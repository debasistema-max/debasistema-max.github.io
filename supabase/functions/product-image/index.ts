import { createClient } from "npm:@supabase/supabase-js@2";
import { requireUser } from "../_shared/auth.ts";
import { corsHeaders, errorMessage, isOriginAllowed, jsonResponse, preflightResponse } from "../_shared/http.ts";

const CODE_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const FALLBACK_CODE_PATTERN = /^\d{6,20}$/;
const IMAGE_PATH_PATTERN = /^\/uploads\/products\/[A-Za-z0-9._-]+\/(?:site\/)?[A-Za-z0-9._-]+\.(?:webp|png|jpe?g)$/i;
const ALLOWED_TYPES = new Set(["image/webp", "image/png", "image/jpeg"]);
const MAX_IMAGE_BYTES = 5_000_000;

function imageCandidates(code: string, storedPath?: string | null): string[] {
  const candidates = [storedPath || ""];
  if (FALLBACK_CODE_PATTERN.test(code)) {
    for (const extension of ["webp", "png", "jpg"]) {
      candidates.push(`/uploads/products/${code}/site/${code}.${extension}`);
      candidates.push(`/uploads/products/${code}/${code}.${extension}`);
    }
  }
  return [...new Set(candidates.filter((path) => IMAGE_PATH_PATTERN.test(path) && !path.includes("..")))];
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Configuracao ausente: ${name}.`);
  return value;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflightResponse(req);
  if (!isOriginAllowed(req)) return jsonResponse(req, { error: "Origem nao autorizada." }, 403);
  if (req.method !== "GET") return jsonResponse(req, { error: "Metodo nao permitido." }, 405);

  try {
    const { user, client } = await requireUser(req);
    const { data: profile, error: profileError } = await client
      .from("profiles").select("active").eq("id", user.id).maybeSingle();
    if (profileError || !profile?.active) return jsonResponse(req, { error: "Acesso negado." }, 403);

    const code = new URL(req.url).searchParams.get("code")?.trim() ?? "";
    if (!CODE_PATTERN.test(code)) return jsonResponse(req, { error: "Codigo invalido." }, 400);

    const admin = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: product, error: productError } = await admin
      .from("products").select("id").eq("code", code).eq("active", true).eq("admin_inactive", false).maybeSingle();
    if (productError) throw productError;
    if (!product) return jsonResponse(req, { error: "Foto nao encontrada." }, 404);
    const { data: image, error: imageError } = await admin
      .from("product_images").select("image_path").eq("product_id", product.id).maybeSingle();
    if (imageError) throw imageError;
    const candidates = imageCandidates(code, image?.image_path);
    if (!candidates.length) {
      return jsonResponse(req, { error: "Foto nao encontrada." }, 404);
    }

    const origin = new URL(requiredEnv("PRODUCT_IMAGE_ORIGIN"));
    if (origin.protocol !== "https:" || origin.username || origin.password) throw new Error("Origem de fotos invalida.");
    let upstream: Response | null = null;
    for (const imagePath of candidates) {
      const target = new URL(imagePath, origin);
      if (target.origin !== origin.origin) continue;
      const response = await fetch(target, {
        headers: { Accept: "image/webp,image/png,image/jpeg" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        upstream = response;
        break;
      }
      if (response.status !== 404) throw new Error("Fonte de fotos indisponivel.");
    }
    if (!upstream) return jsonResponse(req, { error: "Foto nao encontrada." }, 404);
    const contentType = (upstream.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
    if (!ALLOWED_TYPES.has(contentType)) throw new Error("Formato de foto nao autorizado.");
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Foto fora do limite permitido.");

    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders(req),
        "Content-Type": contentType,
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, max-age=21600",
        "Content-Security-Policy": "default-src 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = errorMessage(error);
    const status = /autenticacao|sessao/i.test(message) ? 401 : /configuracao/i.test(message) ? 503 : 502;
    return jsonResponse(req, { error: message }, status);
  }
});
