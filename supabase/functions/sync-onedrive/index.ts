import { createClient } from "npm:@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/auth.ts";
import { errorMessage, isOriginAllowed, jsonResponse, preflightResponse } from "../_shared/http.ts";

type GraphItem = {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  "@microsoft.graph.downloadUrl"?: string;
};
type SyncRequest = {
  action?: "dispatch" | "dispatch_photos" | "check" | "download";
  job_id?: string;
  retry_failed?: boolean;
};

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0/me/drive";
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Configuracao ausente: ${name}.`);
  return value;
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 4): Promise<Response> {
  let response: Response | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    response = await fetch(url, init);
    if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts - 1) return response;
    await response.body?.cancel().catch(() => {});
    const retryAfter = Number(response.headers.get("retry-after") || 0) * 1000;
    const delay = retryAfter > 0 ? Math.min(retryAfter, 8_000) : 500 * (2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return response as Response;
}

async function microsoftToken(scope: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: requiredEnv("MS_GRAPH_CLIENT_ID"),
    refresh_token: requiredEnv("MS_GRAPH_REFRESH_TOKEN"),
    scope,
    grant_type: "refresh_token",
  });
  const response = await fetchWithRetry("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    const errorCode = String(failure?.error || "unknown_error").replace(/[^a-z0-9_.-]/gi, "");
    throw new Error(`Falha na autenticacao Microsoft (${response.status}, ${errorCode}).`);
  }
  const data = await response.json();
  if (!data.access_token) throw new Error("Microsoft nao retornou token de acesso.");
  return String(data.access_token);
}

async function graphToken(): Promise<string> {
  return await microsoftToken(Deno.env.get("MS_GRAPH_SCOPE") || "offline_access Files.Read");
}

async function graphJson(url: string, token: string): Promise<Record<string, unknown>> {
  const response = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!response.ok) throw new Error(`Microsoft Graph respondeu ${response.status}.`);
  return await response.json();
}

async function resolveWorkbook(token: string): Promise<GraphItem> {
  const folderName = requiredEnv("ONEDRIVE_FOLDER_PATH");
  const workbookName = requiredEnv("ONEDRIVE_WORKBOOK_NAME");
  if (folderName.includes("/") || !workbookName.toLowerCase().endsWith(".xlsx")) {
    throw new Error("Pasta ou planilha configurada invalida.");
  }
  const root = await graphJson(`${GRAPH_ROOT}/root/children?%24select=id,name,folder`, token);
  const folders = (Array.isArray(root.value) ? root.value : []).filter(
    (item: GraphItem) => item.name === folderName && item.folder,
  );
  if (folders.length !== 1) throw new Error("Pasta exclusiva do OneDrive nao encontrada.");
  const folderId = encodeURIComponent(String((folders[0] as GraphItem).id));
  const children = await graphJson(
    `${GRAPH_ROOT}/items/${folderId}/children?%24select=id,name,file`, token,
  );
  const matches = (Array.isArray(children.value) ? children.value : []).filter(
    (item: GraphItem) => item.name === workbookName && item.file,
  );
  if (matches.length !== 1) throw new Error("Planilha exclusiva do OneDrive nao encontrada.");
  const itemId = encodeURIComponent(String((matches[0] as GraphItem).id));
  return await graphJson(`${GRAPH_ROOT}/items/${itemId}`, token) as GraphItem;
}

async function hasServiceRole(req: Request): Promise<boolean> {
  const match = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  const token = match?.[1] || "";
  if (!token) return false;
  if (token === requiredEnv("SUPABASE_SERVICE_ROLE_KEY")) return true;
  const verifier = createClient(requiredEnv("SUPABASE_URL"), token, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await verifier.from("sync_jobs").select("id", { head: true }).limit(1);
  return !error;
}

async function secureWorkbookDownload(req: Request, jobId: string, retryFailed: boolean): Promise<Response> {
  if (!(await hasServiceRole(req))) return jsonResponse(req, { error: "Acesso de backend obrigatorio." }, 403);
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return jsonResponse(req, { error: "Solicitacao invalida." }, 400);

  const admin = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: job, error } = await admin.from("sync_jobs")
    .select("id,status,source_size,source_modified")
    .eq("id", jobId)
    .maybeSingle();
  if (error || !job || !["SOLICITADO", "EM_EXECUCAO"].includes(job.status)) {
    return jsonResponse(req, { error: "Solicitacao indisponivel para download." }, 409);
  }

  const token = await graphToken();
  const item = await resolveWorkbook(token);
  if ((item.size ?? 0) <= 0 || (item.size ?? 0) > 20_000_000) throw new Error("Arquivo fora do limite permitido.");
  if (Number(job.source_size) !== Number(item.size)
    || String(job.source_modified || "") !== String(item.lastModifiedDateTime || "")) {
    if (!retryFailed) throw new Error("A planilha foi alterada depois da solicitacao. Solicite uma nova sincronizacao.");
    const { error: refreshError } = await admin.from("sync_jobs").update({
      source_size: item.size ?? null,
      source_modified: item.lastModifiedDateTime ?? null,
    }).eq("id", jobId);
    if (refreshError) throw new Error("Nao foi possivel atualizar a referencia da planilha para repeticao.");
  }

  const downloadUrl = item["@microsoft.graph.downloadUrl"];
  if (!downloadUrl) throw new Error("Microsoft nao forneceu a URL de download pre-autorizada.");
  const parsedDownloadUrl = new URL(downloadUrl);
  let currentDownloadUrl = parsedDownloadUrl;
  let response: Response | null = null;
  for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
    const downloadHeaders: Record<string, string> = {
      Accept: "application/octet-stream",
      "User-Agent": "ISV|DebaPortal|DebaPortal/1.0",
    };
    response = await fetchWithRetry(currentDownloadUrl.toString(), {
      redirect: "manual",
      cache: "no-store",
      headers: downloadHeaders,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {});
    if (!location) throw new Error("Redirecionamento do OneDrive sem destino.");
    const nextDownloadUrl = new URL(location, currentDownloadUrl);
    const allowedMicrosoftHost = nextDownloadUrl.hostname === "my.microsoftpersonalcontent.com"
      || nextDownloadUrl.hostname.endsWith(".1drv.com");
    if (!allowedMicrosoftHost) throw new Error("Redirecionamento do OneDrive para destino nao autorizado.");
    currentDownloadUrl = nextDownloadUrl;
  }
  if (!response) throw new Error("Download do OneDrive nao iniciado.");
  if (!response.ok) {
    const downloadHost = currentDownloadUrl.hostname.replace(/[^a-z0-9.-]/gi, "");
    throw new Error(`Download seguro do OneDrive falhou (${response.status} em ${downloadHost}).`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== Number(item.size) || bytes.byteLength > 20_000_000) {
    throw new Error("Arquivo baixado incompleto ou fora do limite.");
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflightResponse(req);
  if (!isOriginAllowed(req)) return jsonResponse(req, { error: "Origem nao autorizada." }, 403);
  if (req.method !== "POST") return jsonResponse(req, { error: "Metodo nao permitido." }, 405);

  try {
    const input = await req.json().catch(() => ({})) as SyncRequest;
    if (input.action === "download") {
      return await secureWorkbookDownload(req, String(input.job_id || ""), input.retry_failed === true);
    }

    const { user } = await requireAdmin(req);
    const photosOnly = input.action === "dispatch_photos";

    if (input.action !== "dispatch" && !photosOnly) {
      const token = await graphToken();
      const item = await resolveWorkbook(token);
      return jsonResponse(req, {
        data: {
          source_available: true,
          size_bytes: item.size ?? null,
          modified_at: item.lastModifiedDateTime ?? null,
          processing: "SOB_DEMANDA",
        },
      });
    }

    const driveToken = photosOnly ? null : await graphToken();
    const item = driveToken ? await resolveWorkbook(driveToken) : null;

    const admin = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: activeJob, error: activeError } = await admin
      .from("sync_jobs")
      .select("id,status,requested_at")
      .in("status", ["SOLICITADO", "EM_EXECUCAO"])
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activeError) throw activeError;
    if (activeJob) {
      return jsonResponse(req, { data: { queued: true, job_id: activeJob.id, status: activeJob.status } }, 202);
    }

    const { data: job, error: insertError } = await admin.from("sync_jobs").insert({
      requested_by: user.id,
      status: "SOLICITADO",
      source_size: item?.size ?? null,
      source_modified: item?.lastModifiedDateTime ?? null,
      source_download_url: null,
      summary: photosOnly ? { mode: "FOTOS" } : {},
    }).select("id,status,requested_at").single();
    if (insertError) throw insertError;

    const repository = Deno.env.get("GITHUB_SYNC_REPOSITORY") || "debasistema-max/debasistema-max.github.io";
    const workflow = Deno.env.get("GITHUB_SYNC_WORKFLOW") || "sync-catalog.yml";
    const gitHubResponse = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${requiredEnv("GITHUB_SYNC_TOKEN")}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: { job_id: job.id, ...(photosOnly ? { photos_only: "true" } : {}) },
        return_run_details: true,
      }),
    });
    const run = gitHubResponse.status === 204 ? {} : await gitHubResponse.json().catch(() => ({}));
    if (!gitHubResponse.ok) {
      await admin.from("sync_jobs").update({
        status: "FALHOU",
        error_message: `Disparo remoto recusado (${gitHubResponse.status}).`,
        source_download_url: null,
        finished_at: new Date().toISOString(),
      }).eq("id", job.id);
      throw new Error(`GitHub recusou o disparo (${gitHubResponse.status}).`);
    }
    if (run.workflow_run_id || run.html_url) {
      await admin.from("sync_jobs").update({
        github_run_id: run.workflow_run_id ?? null,
        github_run_url: run.html_url ?? null,
      }).eq("id", job.id);
    }
    return jsonResponse(req, { data: { queued: true, job_id: job.id, status: job.status, photos_only: photosOnly } }, 202);
  } catch (error) {
    const message = errorMessage(error);
    const status = /autenticacao|sessao/i.test(message) ? 401
      : /administrador|permissao/i.test(message) ? 403
      : /nao encontrada|ausente/i.test(message) ? 404
      : /configuracao/i.test(message) ? 503
      : 500;
    return jsonResponse(req, { error: message }, status);
  }
});
