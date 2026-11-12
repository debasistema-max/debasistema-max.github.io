import { assertSafePhotoSnapshot, fetchCatalogPhotos } from "./lib/catalog-photos.mjs";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Configuracao ausente: ${name}.`);
  return value;
}

const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const jobId = process.env.SYNC_JOB_ID?.trim() || "";
const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

async function updateJob(patch) {
  if (!jobId) return;
  const response = await fetch(`${supabaseUrl}/rest/v1/sync_jobs?id=eq.${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`Falha ao atualizar a solicitacao de fotos (${response.status}).`);
}

try {
  await updateJob({ status: "EM_EXECUCAO", started_at: new Date().toISOString(), error_message: null });
  const rows = await fetchCatalogPhotos({
    apiUrl: requiredEnv("PRODUCT_CATALOG_API_URL"),
    imageOrigin: requiredEnv("PRODUCT_IMAGE_ORIGIN"),
  });
  const countResponse = await fetch(`${supabaseUrl}/rest/v1/product_images?select=product_id`, {
    method: "HEAD",
    headers: { ...headers, Prefer: "count=exact" },
  });
  if (!countResponse.ok) throw new Error(`Contagem atual de fotos indisponivel (${countResponse.status}).`);
  const countMatch = String(countResponse.headers.get("content-range") || "").match(/\/(\d+)$/);
  assertSafePhotoSnapshot(rows.length, countMatch ? Number(countMatch[1]) : 0);
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/sync_product_images`, {
    method: "POST",
    headers,
    body: JSON.stringify({ source_name: `catalog-api:${jobId || "manual"}`, rows }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.ok === false) {
    throw new Error(`Sincronizacao de fotos recusada (${result.message || result.error || response.status}).`);
  }
  const summary = {
    fotos: Number(result.rows_applied || 0),
    fotos_ignoradas: Number(result.rows_skipped || 0),
    fotos_removidas: Number(result.rows_removed || 0),
  };
  await updateJob({ status: "CONCLUIDO", summary, finished_at: new Date().toISOString() });
  console.log(JSON.stringify({ synced: true, summary }));
} catch (error) {
  const message = error instanceof Error ? error.message : "Erro inesperado.";
  try {
    await updateJob({ status: "FALHOU", error_message: message.slice(0, 1000), finished_at: new Date().toISOString() });
  } catch {}
  throw error;
}
