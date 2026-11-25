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

async function callSyncFunction(action) {
  const response = await fetch(`${supabaseUrl}/functions/v1/sync-onedrive`, {
    method: "POST", headers, body: JSON.stringify({ action, job_id: jobId }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.error || !result?.data) {
    throw new Error(result?.error || `${action}: operacao recusada (${response.status}).`);
  }
  return result.data;
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

let prepared = null;
try {
  const jobResponse = await fetch(
    `${supabaseUrl}/rest/v1/sync_jobs?id=eq.${encodeURIComponent(jobId)}&select=id,status,summary`,
    { headers },
  );
  if (!jobResponse.ok) throw new Error(`Solicitacao indisponivel (${jobResponse.status}).`);
  const [job] = await jobResponse.json();
  const patchRows = job?.summary?.operation === "MATRIX_PATCH" ? job.summary.rows : null;
  if (!job || job.status !== "SOLICITADO" || !Array.isArray(patchRows) || !patchRows.length) {
    throw new Error("Solicitacao de matriz invalida ou ja processada.");
  }

  await updateJob({ status: "EM_EXECUCAO", started_at: new Date().toISOString(), finished_at: null, error_message: null });
  prepared = await callSyncFunction("prepare_matrix_patch");
  const applied = await callSyncFunction("apply_matrix_patch");

  const fileResponse = await fetch(`${supabaseUrl}/functions/v1/sync-onedrive`, {
    method: "POST", headers, body: JSON.stringify({ action: "download", job_id: jobId }),
  });
  if (!fileResponse.ok) {
    const failure = await fileResponse.json().catch(() => ({}));
    throw new Error(failure.error || `Download de verificacao falhou (${fileResponse.status}).`);
  }
  const outputBytes = Buffer.from(await fileResponse.arrayBuffer());
  if (!outputBytes.length || outputBytes.length > 20_000_000 || outputBytes.subarray(0, 4).join(",") !== "80,75,3,4") {
    throw new Error("Conteudo XLSX de verificacao invalido.");
  }

  const parsed = parsePortalWorkbook(
    XLSX,
    outputBytes,
    "planilha-matriz-atualizada.xlsx",
    50_000,
    ["PRODUTOS"],
  );
  const sourceName = `onedrive:matrix-patch:${jobId}`;
  const imports = [];
  for (const dataset of parsed.datasets.filter((entry) => entry.kind === "PRODUTOS")) {
    imports.push(await importDataset(dataset, sourceName));
  }
  const summary = Object.fromEntries(imports.map((result) => [result.kind.toLowerCase(), result.rows]));
  Object.assign(summary, {
    operation: "MATRIX_PATCH",
    rows_updated: Number(applied.rows_updated || patchRows.length),
    rows_added: Number(applied.rows_added || 0),
    backup_name: String(prepared.backup_name || applied.backup_name || ""),
    backup_folder: String(prepared.backup_folder || applied.backup_folder || ""),
    write_method: "MICROSOFT_GRAPH_CELLS",
  });
  await updateJob({ status: "CONCLUIDO", summary, source_download_url: null, finished_at: new Date().toISOString() });
  console.log(JSON.stringify({ updated: true, summary }));
} catch (error) {
  const message = error instanceof Error ? error.message : "Erro inesperado.";
  try {
    await updateJob({
      status: "FALHOU",
      summary: {
        operation: "MATRIX_PATCH",
        ...(prepared?.backup_name ? { backup_name: prepared.backup_name, backup_folder: prepared.backup_folder } : {}),
      },
      error_message: message.slice(0, 1000), source_download_url: null, finished_at: new Date().toISOString(),
    });
  } catch {}
  console.error(message);
  process.exitCode = 1;
}
