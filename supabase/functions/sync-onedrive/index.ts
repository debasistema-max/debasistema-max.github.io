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
};
type SyncRequest = { action?: "dispatch" | "check" };

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0/me/drive";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Configuracao ausente: ${name}.`);
  return value;
}

async function graphToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: requiredEnv("MS_GRAPH_CLIENT_ID"),
    refresh_token: requiredEnv("MS_GRAPH_REFRESH_TOKEN"),
    scope: Deno.env.get("MS_GRAPH_SCOPE") || "offline_access Files.Read",
    grant_type: "refresh_token",
  });
  const response = await fetch("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`Falha na autenticacao Microsoft (${response.status}).`);
  const data = await response.json();
  if (!data.access_token) throw new Error("Microsoft nao retornou token de acesso.");
  return String(data.access_token);
}

async function graphJson(url: string, token: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
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
    `${GRAPH_ROOT}/items/${folderId}/children?%24select=id,name,size,lastModifiedDateTime,file`, token,
  );
  const matches = (Array.isArray(children.value) ? children.value : []).filter(
    (item: GraphItem) => item.name === workbookName && item.file,
  );
  if (matches.length !== 1) throw new Error("Planilha exclusiva do OneDrive nao encontrada.");
  return matches[0] as GraphItem;
}

async function temporaryDownloadUrl(item: GraphItem, token: string): Promise<string> {
  if ((item.size ?? 0) <= 0 || (item.size ?? 0) > 20_000_000) throw new Error("Arquivo fora do limite permitido.");
  const response = await fetch(`${GRAPH_ROOT}/items/${encodeURIComponent(item.id)}/content`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
  });
  const location = response.headers.get("location");
  if (!location || ![301, 302, 303, 307, 308].includes(response.status)) {
    throw new Error("Microsoft nao forneceu o download temporario.");
  }
  return location;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflightResponse(req);
  if (!isOriginAllowed(req)) return jsonResponse(req, { error: "Origem nao autorizada." }, 403);
  if (req.method !== "POST") return jsonResponse(req, { error: "Metodo nao permitido." }, 405);

  try {
    const { user } = await requireAdmin(req);
    const input = await req.json().catch(() => ({})) as SyncRequest;
    const token = await graphToken();
    const item = await resolveWorkbook(token);

    if (input.action !== "dispatch") {
      return jsonResponse(req, {
        data: {
          source_available: true,
          size_bytes: item.size ?? null,
          modified_at: item.lastModifiedDateTime ?? null,
          processing: "SOB_DEMANDA",
        },
      });
    }

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

    const downloadUrl = await temporaryDownloadUrl(item, token);
    const { data: job, error: insertError } = await admin.from("sync_jobs").insert({
      requested_by: user.id,
      status: "SOLICITADO",
      source_size: item.size,
      source_modified: item.lastModifiedDateTime,
      source_download_url: downloadUrl,
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
      body: JSON.stringify({ ref: "main", inputs: { job_id: job.id }, return_run_details: true }),
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
    return jsonResponse(req, { data: { queued: true, job_id: job.id, status: job.status } }, 202);
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
