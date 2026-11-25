function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Configuracao ausente: ${name}.`);
  return value;
}

const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
async function call(action) {
  const response = await fetch(`${supabaseUrl}/functions/v1/sync-onedrive`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action }),
  });
  const result = await response.json().catch(() => ({}));
  return { response, result };
}

const { response, result } = await call("validate_matrix");
if (!response.ok || result?.error || !result?.data?.valid) {
  const recovery = await call("inspect_matrix_recovery");
  if (recovery.response.ok && recovery.result?.data) {
    console.log(JSON.stringify({ recovery: recovery.result.data }, null, 2));
  }
  throw new Error(result?.error || `Validacao da MATRIZ recusada (${response.status}).`);
}
console.log(JSON.stringify({ valid: true, sheet_count: Number(result.data.sheet_count || 0) }));
