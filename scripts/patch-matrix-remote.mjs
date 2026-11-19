import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as XLSX from "xlsx";
import { parsePortalWorkbook } from "./lib/catalog-workbook.mjs";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Configuracao ausente: ${name}.`);
  return value;
}

const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const jobId = requiredEnv("SYNC_JOB_ID");
const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

async function updateJob(patch) {
  const response = await fetch(`${supabaseUrl}/rest/v1/sync_jobs?id=eq.${encodeURIComponent(jobId)}`, {
    method: "PATCH", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`Falha ao atualizar a solicitacao (${response.status}).`);
}

async function importDataset(dataset, sourceName) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/import_catalog_batch`, {
    method: "POST", headers,
    body: JSON.stringify({ import_kind: dataset.kind, source_name: sourceName, rows: dataset.rows }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${dataset.kind}: importacao recusada (${result.message || response.status}).`);
  if (result?.ok === false) throw new Error(`${dataset.kind}: ${result.error || "falha de validacao no banco"}.`);
  return { kind: dataset.kind, rows: dataset.rows.length };
}

let workDir = null;
try {
  const jobResponse = await fetch(
    `${supabaseUrl}/rest/v1/sync_jobs?id=eq.${encodeURIComponent(jobId)}&select=id,status,source_size,source_modified,summary`,
    { headers },
  );
  if (!jobResponse.ok) throw new Error(`Solicitacao indisponivel (${jobResponse.status}).`);
  const [job] = await jobResponse.json();
  const patchRows = job?.summary?.operation === "MATRIX_PATCH" ? job.summary.rows : null;
  if (!job || job.status !== "SOLICITADO" || !Array.isArray(patchRows) || !patchRows.length) {
    throw new Error("Solicitacao de matriz invalida ou ja processada.");
  }

  await updateJob({ status: "EM_EXECUCAO", started_at: new Date().toISOString(), finished_at: null, error_message: null });
  const fileResponse = await fetch(`${supabaseUrl}/functions/v1/sync-onedrive`, {
    method: "POST", headers, body: JSON.stringify({ action: "download", job_id: jobId }),
  });
  if (!fileResponse.ok) {
    const failure = await fileResponse.json().catch(() => ({}));
    throw new Error(failure.error || `Download seguro falhou (${fileResponse.status}).`);
  }
  const inputBytes = Buffer.from(await fileResponse.arrayBuffer());
  if (!inputBytes.length || inputBytes.length > 20_000_000 || inputBytes.subarray(0, 4).join(",") !== "80,75,3,4") {
    throw new Error("Conteudo XLSX de entrada invalido.");
  }

  workDir = await mkdtemp(join(tmpdir(), "debaportal-matrix-"));
  const inputPath = join(workDir, "entrada.xlsx");
  const outputPath = join(workDir, "saida.xlsx");
  const payloadPath = join(workDir, "alteracoes.json");
  await Promise.all([
    writeFile(inputPath, inputBytes),
    writeFile(payloadPath, JSON.stringify(patchRows), "utf8"),
  ]);
  const python = spawnSync("python", ["scripts/patch-matrix-workbook.py", inputPath, outputPath, payloadPath], {
    cwd: process.cwd(), encoding: "utf8", maxBuffer: 2_000_000,
  });
  if (python.status !== 0) throw new Error(String(python.stderr || python.stdout || "Falha ao alterar a MATRIZ.").trim());
  const patchSummary = JSON.parse(String(python.stdout || "{}").trim());
  const outputBytes = await readFile(outputPath);
  if (!outputBytes.length || outputBytes.length > 20_000_000 || outputBytes.subarray(0, 4).join(",") !== "80,75,3,4") {
    throw new Error("Conteudo XLSX de saida invalido.");
  }

  const prepareResponse = await fetch(`${supabaseUrl}/functions/v1/sync-onedrive`, {
    method: "POST", headers, body: JSON.stringify({ action: "prepare_matrix_upload", job_id: jobId }),
  });
  const prepared = await prepareResponse.json().catch(() => ({}));
  if (!prepareResponse.ok || !prepared?.data?.upload_url) {
    throw new Error(prepared.error || `Preparacao do backup falhou (${prepareResponse.status}).`);
  }
  const uploadUrl = String(prepared.data.upload_url);
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Length": String(outputBytes.length),
      "Content-Range": `bytes 0-${outputBytes.length - 1}/${outputBytes.length}`,
    },
    body: outputBytes,
  });
  const uploadResult = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok || Number(uploadResult.size || 0) !== outputBytes.length) {
    throw new Error(`Microsoft recusou a gravacao da planilha (${uploadResponse.status}).`);
  }

  const parsed = parsePortalWorkbook(XLSX, outputBytes, "planilha-matriz-atualizada.xlsx");
  const sourceName = `onedrive:matrix-patch:${jobId}`;
  const imports = [];
  for (const dataset of parsed.datasets) imports.push(await importDataset(dataset, sourceName));
  const summary = Object.fromEntries(imports.map((result) => [result.kind.toLowerCase(), result.rows]));
  Object.assign(summary, {
    operation: "MATRIX_PATCH",
    rows_updated: Number(patchSummary.rows_updated || patchRows.length),
    rows_added: Number(patchSummary.rows_added || 0),
    backup_name: String(prepared.data.backup_name || ""),
    backup_folder: String(prepared.data.backup_folder || ""),
  });
  await updateJob({ status: "CONCLUIDO", summary, source_download_url: null, finished_at: new Date().toISOString() });
  console.log(JSON.stringify({ updated: true, summary }));
} catch (error) {
  const message = error instanceof Error ? error.message : "Erro inesperado.";
  try {
    await updateJob({
      status: "FALHOU", summary: { operation: "MATRIX_PATCH" },
      error_message: message.slice(0, 1000), source_download_url: null, finished_at: new Date().toISOString(),
    });
  } catch {}
  console.error(message);
  process.exitCode = 1;
} finally {
  if (workDir) await rm(workDir, { recursive: true, force: true });
}
