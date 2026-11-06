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
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`Falha ao atualizar a solicitacao (${response.status}).`);
}

async function importDataset(dataset, sourceName) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/import_catalog_batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ import_kind: dataset.kind, source_name: sourceName, rows: dataset.rows }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${dataset.kind}: importacao recusada (${result.message || response.status}).`);
  if (result?.ok === false) throw new Error(`${dataset.kind}: ${result.error || "falha de validacao no banco"}.`);
  return { kind: dataset.kind, rows: dataset.rows.length };
}

try {
  const jobResponse = await fetch(
    `${supabaseUrl}/rest/v1/sync_jobs?id=eq.${encodeURIComponent(jobId)}&select=id,status,source_size,source_modified,source_download_url`,
    { headers },
  );
  if (!jobResponse.ok) throw new Error(`Solicitacao indisponivel (${jobResponse.status}).`);
  const [job] = await jobResponse.json();
  if (!job || job.status !== "SOLICITADO" || !job.source_download_url) {
    throw new Error("Solicitacao invalida ou ja processada.");
  }

  await updateJob({ status: "EM_EXECUCAO", started_at: new Date().toISOString(), error_message: null });
  const fileResponse = await fetch(job.source_download_url, { redirect: "follow" });
  if (!fileResponse.ok) throw new Error(`Download temporario falhou (${fileResponse.status}).`);
  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  if (bytes.length !== Number(job.source_size) || bytes.length > 20_000_000) {
    throw new Error("Arquivo baixado incompleto ou fora do limite.");
  }
  if (bytes.subarray(0, 4).join(",") !== "80,75,3,4") throw new Error("Conteudo XLSX invalido.");

  const parsed = parsePortalWorkbook(XLSX, bytes, "planilha-autorizada.xlsx");
  const sourceName = `onedrive:online:${jobId}:${job.source_modified || "sem-data"}`;
  const results = [];
  for (const dataset of parsed.datasets) results.push(await importDataset(dataset, sourceName));
  const summary = Object.fromEntries(results.map((result) => [result.kind.toLowerCase(), result.rows]));
  await updateJob({
    status: "CONCLUIDO",
    summary,
    source_download_url: null,
    finished_at: new Date().toISOString(),
  });
  console.log(JSON.stringify({ imported: true, summary }));
} catch (error) {
  const message = error instanceof Error ? error.message : "Erro inesperado.";
  try {
    await updateJob({
      status: "FALHOU",
      error_message: message.slice(0, 1000),
      source_download_url: null,
      finished_at: new Date().toISOString(),
    });
  } catch {}
  console.error(message);
  process.exitCode = 1;
}
