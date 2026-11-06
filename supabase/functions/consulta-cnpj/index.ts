import { requireUser } from "../_shared/auth.ts";
import { isValidCnpj, onlyDigits } from "../_shared/cnpj.ts";
import { errorMessage, isOriginAllowed, jsonResponse, preflightResponse } from "../_shared/http.ts";

type ProviderResult = {
  provider: "brasilapi" | "receitaws";
  payload: Record<string, unknown>;
};

function normalized(result: ProviderResult, cnpj: string) {
  const source = result.payload;
  const brasilApi = result.provider === "brasilapi";
  return {
    cnpj,
    razao_social: String(source.razao_social ?? source.nome ?? ""),
    nome_fantasia: String(source.nome_fantasia ?? source.fantasia ?? ""),
    uf: String(source.uf ?? "").toUpperCase(),
    municipio: String(source.municipio ?? ""),
    situacao_cadastral: String(source.descricao_situacao_cadastral ?? source.situacao ?? ""),
    cnae_fiscal: String(source.cnae_fiscal ?? source.atividade_principal ?? ""),
    atualizado_em: brasilApi ? String(source.data_situacao_cadastral ?? "") : "",
    fonte: result.provider,
  };
}

async function fetchJson(url: string, timeoutMs = 8_000): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "DebaPortal/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Provedor respondeu ${response.status}.`);
    const data = await response.json();
    if (!data || typeof data !== "object") throw new Error("Resposta invalida do provedor.");
    return data as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

async function consult(cnpj: string): Promise<ProviderResult> {
  try {
    return {
      provider: "brasilapi",
      payload: await fetchJson(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`),
    };
  } catch (primaryError) {
    try {
      const payload = await fetchJson(`https://www.receitaws.com.br/v1/cnpj/${cnpj}`);
      if (String(payload.status ?? "").toUpperCase() === "ERROR") {
        throw new Error(String(payload.message ?? "Consulta recusada pelo provedor alternativo."));
      }
      return { provider: "receitaws", payload };
    } catch {
      throw primaryError;
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflightResponse(req);
  if (!isOriginAllowed(req)) return jsonResponse(req, { error: "Origem nao autorizada." }, 403);
  if (!['GET', 'POST'].includes(req.method)) return jsonResponse(req, { error: "Metodo nao permitido." }, 405);

  try {
    await requireUser(req);
    const raw = req.method === "GET"
      ? new URL(req.url).searchParams.get("cnpj")
      : (await req.json().catch(() => ({})) as Record<string, unknown>).cnpj;
    const cnpj = onlyDigits(raw);
    if (!isValidCnpj(cnpj)) return jsonResponse(req, { error: "CNPJ invalido." }, 400);

    const result = await consult(cnpj);
    return jsonResponse(req, { data: normalized(result, cnpj) });
  } catch (error) {
    const message = errorMessage(error);
    const status = /autenticacao|sessao/i.test(message) ? 401 : 502;
    return jsonResponse(req, { error: message }, status);
  }
});
