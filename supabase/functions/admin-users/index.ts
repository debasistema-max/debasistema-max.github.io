import { createClient } from "npm:@supabase/supabase-js@2.49.8";
import { requireAdmin } from "../_shared/auth.ts";
import { errorMessage, isOriginAllowed, jsonResponse, preflightResponse } from "../_shared/http.ts";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Configuracao ausente: ${name}.`);
  return value;
}

function validEmail(value: unknown): string {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error("E-mail invalido.");
  }
  return email;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflightResponse(req);
  if (!isOriginAllowed(req)) return jsonResponse(req, { error: "Origem nao autorizada." }, 403);
  if (req.method !== "POST") return jsonResponse(req, { error: "Metodo nao permitido." }, 405);

  try {
    await requireAdmin(req);
    const payload = await req.json().catch(() => ({})) as Record<string, unknown>;
    const email = validEmail(payload.email);
    const fullName = String(payload.full_name ?? "").trim().replace(/\s+/g, " ").slice(0, 160);
    if (!fullName) return jsonResponse(req, { error: "Nome obrigatorio." }, 400);

    const adminClient = createClient(
      requiredEnv("SUPABASE_URL"),
      requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const redirectTo = Deno.env.get("APP_URL") || undefined;
    const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
      redirectTo,
    });
    if (error) throw new Error(error.message);

    return jsonResponse(req, {
      data: { id: data.user?.id, email: data.user?.email, full_name: fullName, invited: true },
    }, 201);
  } catch (error) {
    const message = errorMessage(error);
    const status = /autenticacao|sessao/i.test(message) ? 401
      : /administrador|permissao/i.test(message) ? 403
      : /e-mail|nome/i.test(message) ? 400
      : 500;
    return jsonResponse(req, { error: message }, status);
  }
});
