function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Configuracao ausente: ${name}.`);
  return value;
}

const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const response = await fetch(`${supabaseUrl}/functions/v1/sync-onedrive`, {
  method: "POST",
  headers: {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ action: "validate_matrix" }),
});
const result = await response.json().catch(() => ({}));
if (!response.ok || result?.error || !result?.data?.valid) {
  throw new Error(result?.error || `Validacao da MATRIZ recusada (${response.status}).`);
}
console.log(JSON.stringify({ valid: true, sheet_count: Number(result.data.sheet_count || 0) }));
