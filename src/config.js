const env = import.meta.env;

export const config = Object.freeze({
  supabaseUrl: String(env.VITE_SUPABASE_URL || '').trim(),
  supabaseAnonKey: String(env.VITE_SUPABASE_ANON_KEY || '').trim(),
  cnpjFunctionUrl: String(env.VITE_CNPJ_FUNCTION_URL || '').trim(),
  demoEnabled: String(env.VITE_ENABLE_DEMO || '').toLowerCase() === 'true'
});

export function hasSupabaseConfig() {
  return /^https:\/\/.+\.supabase\.co$/i.test(config.supabaseUrl)
    && config.supabaseAnonKey.length > 40
    && !config.supabaseUrl.includes('SEU-PROJETO');
}
