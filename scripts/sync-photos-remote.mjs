import { assertSafePhotoSnapshot, fetchCatalogPhotos } from "./lib/catalog-photos.mjs";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Configuracao ausente: ${name}.`);
  return value;
}

const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const rows = await fetchCatalogPhotos({
  apiUrl: requiredEnv("PRODUCT_CATALOG_API_URL"),
  imageOrigin: requiredEnv("PRODUCT_IMAGE_ORIGIN"),
});
const countResponse = await fetch(`${supabaseUrl}/rest/v1/product_images?select=product_id`, {
  method: "HEAD",
  headers: {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Prefer: "count=exact",
  },
});
if (!countResponse.ok) throw new Error(`Contagem atual de fotos indisponivel (${countResponse.status}).`);
const countMatch = String(countResponse.headers.get("content-range") || "").match(/\/(\d+)$/);
assertSafePhotoSnapshot(rows.length, countMatch ? Number(countMatch[1]) : 0);
const response = await fetch(`${supabaseUrl}/rest/v1/rpc/sync_product_images`, {
  method: "POST",
  headers: {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ source_name: "catalog-api:initial", rows }),
});
const result = await response.json().catch(() => ({}));
if (!response.ok || result?.ok === false) {
  throw new Error(`Sincronizacao de fotos recusada (${result.message || result.error || response.status}).`);
}
console.log(JSON.stringify({ synced: true, summary: result }));
