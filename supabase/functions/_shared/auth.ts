import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2.49.8";

export type AuthContext = {
  user: User;
  client: SupabaseClient;
};

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Configuracao ausente: ${name}.`);
  return value;
}

function bearerToken(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Autenticacao obrigatoria.");
  return match[1];
}

export async function requireUser(req: Request): Promise<AuthContext> {
  const token = bearerToken(req);
  const client = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new Error("Sessao invalida ou expirada.");
  return { user: data.user, client };
}

export async function requireAdmin(req: Request): Promise<AuthContext> {
  const context = await requireUser(req);
  const { data, error } = await context.client
    .from("profiles")
    .select("role, active")
    .eq("id", context.user.id)
    .maybeSingle();

  if (error) throw new Error("Nao foi possivel validar o perfil do usuario.");
  if (!data || data.active === false || String(data.role).toUpperCase() !== "ADMIN") {
    throw new Error("Permissao de administrador obrigatoria.");
  }
  return context;
}
