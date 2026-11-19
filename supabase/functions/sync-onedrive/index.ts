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
  parentReference?: { driveId?: string; id?: string };
  "@microsoft.graph.downloadUrl"?: string;
};
type MatrixPatchRow = {
  code?: string;
  description?: string | null;
  category?: string | null;
  product_line?: string | null;
  commercial_line?: string | null;
  synonyms?: string[];
  applicationProvided?: boolean;
  applicationClear?: boolean;
  applicationValues?: string[];
  yearProvided?: boolean;
  yearValues?: string[];
  base_price?: number;
  append_data?: {
    description?: string;
    category?: string;
    product_line?: string;
    commercial_line?: string;
    synonyms?: string[];
    applicationValues?: string[];
    yearValues?: string[];
  };
};
type SyncRequest = {
  action?: "dispatch" | "dispatch_photos" | "check" | "download" | "connect_start" | "connect_complete" | "patch_matrix";
  job_id?: string;
  retry_failed?: boolean;
  device_code?: string;
  rows?: MatrixPatchRow[];
};

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0/me/drive";
const BACKUP_FOLDER_NAME = "Backup DebaPortal";
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_BATCH_STATUS = new Set([408, 409, 423, ...RETRYABLE_STATUS]);

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

async function storedRefreshToken(): Promise<string> {
  const admin = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data } = await admin.rpc("backend_get_onedrive_refresh_token");
  return String(data || Deno.env.get("MS_GRAPH_REFRESH_TOKEN") || "").trim();
}

async function microsoftToken(scope: string): Promise<string> {
  const refreshToken = await storedRefreshToken();
  if (!refreshToken) throw new Error("Conexao Microsoft ausente.");
  const body = new URLSearchParams({
    client_id: requiredEnv("MS_GRAPH_CLIENT_ID"),
    refresh_token: refreshToken,
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

async function startMicrosoftConnection(): Promise<Record<string, unknown>> {
  const response = await fetchWithRetry("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode?mkt=pt-BR", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requiredEnv("MS_GRAPH_CLIENT_ID"),
      scope: "offline_access Files.ReadWrite",
    }),
  });
  const data = await response.json().catch(() => ({}));
  let verificationUri: URL | null = null;
  try { verificationUri = new URL(String(data.verification_uri || "")); } catch { verificationUri = null; }
  const allowedVerificationUri = verificationUri?.protocol === "https:"
    && ["microsoft.com", "www.microsoft.com"].includes(verificationUri.hostname)
    && ["/devicelogin", "/link"].includes(verificationUri.pathname.replace(/\/$/, ""));
  if (!response.ok || !data.device_code || !data.user_code || !allowedVerificationUri) {
    const code = String(data?.error || "unknown_error").replace(/[^a-z0-9_.-]/gi, "");
    throw new Error(`Microsoft recusou a reconexao (${response.status}, ${code}).`);
  }
  return {
    device_code: String(data.device_code), user_code: String(data.user_code),
    verification_uri: String(data.verification_uri), expires_in: Number(data.expires_in || 900),
  };
}

async function completeMicrosoftConnection(deviceCode: string): Promise<{ connected: boolean; pending?: boolean }> {
  if (!deviceCode || deviceCode.length < 20 || deviceCode.length > 2048) throw new Error("Codigo de conexao invalido.");
  const response = await fetchWithRetry("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: requiredEnv("MS_GRAPH_CLIENT_ID"), device_code: deviceCode,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = String(data?.error || "unknown_error").replace(/[^a-z0-9_.-]/gi, "");
    if (code === "authorization_pending" || code === "slow_down") return { connected: false, pending: true };
    throw new Error(`Microsoft nao concluiu a conexao (${code}).`);
  }
  const refreshToken = String(data.refresh_token || "");
  if (refreshToken.length < 40) throw new Error("Microsoft nao retornou autorizacao duradoura.");
  const admin = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await admin.rpc("backend_set_onedrive_refresh_token", { token_value: refreshToken });
  if (error) throw new Error("Nao foi possivel guardar a conexao no cofre seguro.");
  return { connected: true };
}

async function graphToken(writeAccess = false): Promise<string> {
  try {
    return await microsoftToken(writeAccess
      ? "offline_access Files.ReadWrite"
      : (Deno.env.get("MS_GRAPH_SCOPE") || "offline_access Files.Read"));
  } catch (error) {
    if (writeAccess) {
      throw new Error(`Permissao de escrita ausente. Reconecte o OneDrive no painel. ${errorMessage(error)}`);
    }
    throw error;
  }
}

async function graphJson(url: string, token: string): Promise<Record<string, unknown>> {
  const response = await fetchWithRetry(url, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Cache-Control": "no-cache, no-store",
      Pragma: "no-cache",
    },
  });
  if (!response.ok) throw new Error(`Microsoft Graph respondeu ${response.status}.`);
  return await response.json();
}

async function resolveWorkbookTarget(token: string): Promise<{ item: GraphItem; folderId: string; driveId: string }> {
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
  const [item, drive] = await Promise.all([
    graphJson(`${GRAPH_ROOT}/items/${itemId}`, token) as Promise<GraphItem>,
    graphJson("https://graph.microsoft.com/v1.0/me/drive?%24select=id", token),
  ]);
  const driveId = String(drive.id || "");
  if (!driveId) throw new Error("Microsoft nao informou o identificador do OneDrive.");
  return { item, folderId: String((folders[0] as GraphItem).id), driveId };
}

async function resolveWorkbook(token: string): Promise<GraphItem> {
  return (await resolveWorkbookTarget(token)).item;
}

const MATRIX_FIELDS: Record<string, { label: string; aliases: string[] }> = {
  description: { label: "Descricao", aliases: ["descricao", "description", "produto", "nome"] },
  category: { label: "Categoria", aliases: ["categoria", "category", "grupo"] },
  product_line: { label: "Marca", aliases: ["marca", "brand", "fabricante"] },
  commercial_line: {
    label: "Linha",
    aliases: ["linha", "commercial_line", "linha_produto", "segmento", "tipo", "tipo_veiculo", "linha_veiculo", "categoria_veiculo", "classificacao"],
  },
  synonyms: { label: "Sinonimos", aliases: ["sinonimos", "synonyms", "similares", "similar", "oem"] },
  application: { label: "Aplicacao", aliases: ["aplicacao", "applications", "application", "aplicacoes", "aplicacao_veiculo", "veiculo", "modelo"] },
  year: { label: "Ano", aliases: ["ano", "year", "anos"] },
  base_price: { label: "Preco base", aliases: ["preco_s_imp", "preco_sem_imposto", "preco_base", "valor_base", "base_price"] },
};
const CODE_HEADERS = ["codigo", "codigo_ips", "cod_ips", "code", "codigo_produto", "sku", "item"];

function normalizeHeader(value: unknown): string {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function safeMatrixText(value: unknown, label: string, maxLength = 500): string {
  const text = String(value ?? "").trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  if (text.length > maxLength) throw new Error(`${label} excede o limite permitido.`);
  if (/^[=+@]/.test(text)) throw new Error(`${label} nao pode iniciar com formula.`);
  return text;
}

function listText(value: unknown, label: string): string {
  if (!Array.isArray(value)) throw new Error(`${label} invalido na atualizacao parcial.`);
  if (value.length > 50) throw new Error(`${label} excede o limite de valores.`);
  return value.map((item) => safeMatrixText(item, label, 300)).filter(Boolean).join("; ");
}

function sanitizeMatrixRows(rows: MatrixPatchRow[] | undefined): MatrixPatchRow[] {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("Atualizacao parcial vazia.");
  if (rows.length > 200) throw new Error("Atualize no maximo 200 itens por operacao no OneDrive.");
  const seen = new Set<string>();
  return rows.map((row) => {
    const code = safeMatrixText(row?.code, "Codigo", 120).replace(/\.0+$/, "");
    if (!code) throw new Error("Codigo vazio na atualizacao parcial.");
    if (seen.has(code)) throw new Error(`Codigo duplicado na atualizacao parcial: ${code}.`);
    seen.add(code);
    const sanitized: MatrixPatchRow = { code };
    for (const field of ["description", "category", "product_line", "commercial_line"] as const) {
      if (Object.hasOwn(row, field)) sanitized[field] = row[field] === null ? null : safeMatrixText(row[field], MATRIX_FIELDS[field].label, field === "description" ? 500 : 200);
    }
    if (Object.hasOwn(row, "synonyms")) sanitized.synonyms = String(listText(row.synonyms, "Sinonimos")).split("; ").filter(Boolean);
    if (row.applicationProvided) {
      sanitized.applicationProvided = true;
      sanitized.applicationClear = Boolean(row.applicationClear);
      sanitized.applicationValues = row.applicationClear ? [] : listText(row.applicationValues || [], "Aplicacao").split("; ").filter(Boolean);
    }
    if (row.yearProvided) {
      sanitized.yearProvided = true;
      sanitized.yearValues = listText(row.yearValues || [], "Ano").split("; ").filter(Boolean);
    }
    if (Object.hasOwn(row, "base_price")) {
      const price = Number(row.base_price);
      if (!Number.isFinite(price) || price <= 0 || price > 10_000_000) throw new Error(`Preco base invalido para o codigo ${code}.`);
      sanitized.base_price = Math.round(price * 100) / 100;
    }
    const hasChange = Object.keys(sanitized).some((key) => key !== "code" && key !== "append_data" && !key.endsWith("Provided") && key !== "applicationClear");
    if (!hasChange) throw new Error(`Nenhum campo informado para o codigo ${code}.`);
    if (row.append_data && typeof row.append_data === "object") {
      const appendData: NonNullable<MatrixPatchRow["append_data"]> = {};
      for (const field of ["description", "category", "product_line", "commercial_line"] as const) {
        if (Object.hasOwn(row.append_data, field)) {
          appendData[field] = safeMatrixText(row.append_data[field], `Dados de inclusao: ${MATRIX_FIELDS[field].label}`, field === "description" ? 500 : 200);
        }
      }
      if (Object.hasOwn(row.append_data, "synonyms")) appendData.synonyms = listText(row.append_data.synonyms || [], "Dados de inclusao: Sinonimos").split("; ").filter(Boolean);
      if (Object.hasOwn(row.append_data, "applicationValues")) appendData.applicationValues = listText(row.append_data.applicationValues || [], "Dados de inclusao: Aplicacao").split("; ").filter(Boolean);
      if (Object.hasOwn(row.append_data, "yearValues")) {
        const years = Array.isArray(row.append_data.yearValues) ? row.append_data.yearValues : [];
        if (years.length > 50) throw new Error("Dados de inclusao: Ano excede o limite de valores.");
        appendData.yearValues = years.map((value) => safeMatrixText(value, "Dados de inclusao: Ano", 100));
      }
      sanitized.append_data = appendData;
    }
    return sanitized;
  });
}

function excelColumn(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function matrixFieldValues(row: MatrixPatchRow): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  for (const field of ["description", "category", "product_line", "commercial_line"] as const) {
    if (Object.hasOwn(row, field)) values[field] = row[field] === null ? "" : String(row[field]);
  }
  if (Object.hasOwn(row, "synonyms")) values.synonyms = (row.synonyms || []).join("; ");
  if (row.applicationProvided) values.application = row.applicationClear ? "" : (row.applicationValues || []).join("; ");
  if (row.yearProvided) values.year = (row.yearValues || []).join("; ");
  if (Object.hasOwn(row, "base_price")) values.base_price = Number(row.base_price);
  return values;
}

function appendDataValues(row: MatrixPatchRow): Record<string, string | number> {
  const source = row.append_data || {};
  const values: Record<string, string | number> = {};
  for (const field of ["description", "category", "product_line", "commercial_line"] as const) {
    const value = String(source[field] || "").trim();
    if (value) values[field] = value;
  }
  if (source.synonyms?.length) values.synonyms = source.synonyms.join("; ");
  if (source.applicationValues?.length) values.application = source.applicationValues.join("; ");
  if (source.yearValues?.some((value) => String(value || "").trim())) values.year = (source.yearValues || []).join("; ");
  return values;
}

function headerValue(headers: string[], row: unknown[], aliases: string[]): unknown {
  const index = headers.findIndex((header) => aliases.includes(header));
  return index < 0 ? "" : row[index];
}

async function loadSapMatrixDefaults(
  token: string,
  itemId: string,
  codes: string[],
): Promise<Map<string, Record<string, string | number>>> {
  const sheetName = encodeURIComponent("Cadastro Item SAP");
  const used = await graphJson(
    `${GRAPH_ROOT}/items/${itemId}/workbook/worksheets/${sheetName}/usedRange(valuesOnly=true)?%24select=values`, token,
  );
  const values = Array.isArray(used.values) ? used.values as unknown[][] : [];
  const codeAliases = ["n_do_item", "codigo", "codigo_ips", "cod_ips", "item"];
  const descriptionAliases = ["descricao_do_item", "descricao", "description", "nome"];
  const headerOffset = values.findIndex((line) => {
    const normalized = (Array.isArray(line) ? line : []).map(normalizeHeader);
    return normalized.some((header) => codeAliases.includes(header))
      && normalized.some((header) => descriptionAliases.includes(header));
  });
  if (headerOffset < 0) throw new Error("Cabecalho da aba Cadastro Item SAP nao reconhecido.");
  const headers = (values[headerOffset] || []).map(normalizeHeader);
  const wanted = new Set(codes);
  const result = new Map<string, Record<string, string | number>>();
  for (const row of values.slice(headerOffset + 1)) {
    const code = String(headerValue(headers, row, codeAliases) ?? "").trim().replace(/\.0+$/, "");
    if (!wanted.has(code) || result.has(code)) continue;
    const text = (aliases: string[], label: string, maxLength = 300) => {
      const value = String(headerValue(headers, row, aliases) ?? "").trim();
      return value ? safeMatrixText(value, label, maxLength) : "";
    };
    const defaults: Record<string, string | number> = {};
    const description = text(descriptionAliases, "Descricao SAP", 500);
    const category = text(["grupo_de_itens", "categoria", "grupo"], "Categoria SAP", 200);
    const brand = text(["marca", "fabricante"], "Marca SAP", 200);
    const commercialLine = text([
      "linha", "segmento", "tipo", "tipo_veiculo", "linha_veiculo", "linha_de_produto",
      "categoria_veiculo", "categoria_de_veiculo", "segmento_veiculo", "classificacao",
    ], "Linha SAP", 200);
    const application = text(["modelo", "aplicacao", "veiculo"], "Aplicacao SAP", 300);
    const year = text(["ano", "anos"], "Ano SAP", 100);
    const synonyms = [
      text(["oem_01", "oem", "similar"], "OEM SAP", 300),
      text(["codigo_de_barras", "ean"], "Codigo de barras SAP", 300),
    ].filter(Boolean);
    if (description) defaults.description = description;
    if (category) defaults.category = category;
    if (brand) defaults.product_line = brand;
    if (commercialLine) defaults.commercial_line = commercialLine;
    if (application) defaults.application = application;
    if (year) defaults.year = year;
    if (synonyms.length) defaults.synonyms = synonyms.join("; ");
    result.set(code, defaults);
  }
  return result;
}

type MatrixTable = { id: string; headers: string[] };

async function findMatrixTable(token: string, itemId: string, sheetName: string): Promise<MatrixTable | null> {
  const tables = await graphJson(
    `${GRAPH_ROOT}/items/${itemId}/workbook/worksheets/${sheetName}/tables?%24select=id,name`, token,
  );
  for (const table of Array.isArray(tables.value) ? tables.value as Record<string, unknown>[] : []) {
    const tableId = String(table.id || "");
    if (!tableId) continue;
    const headerRange = await graphJson(
      `${GRAPH_ROOT}/items/${itemId}/workbook/tables/${encodeURIComponent(tableId)}/headerRowRange?%24select=values`, token,
    );
    const headers = (Array.isArray(headerRange.values) && Array.isArray(headerRange.values[0])
      ? headerRange.values[0] as unknown[] : []).map(normalizeHeader);
    if (headers.some((header) => CODE_HEADERS.includes(header))) return { id: tableId, headers };
  }
  return null;
}

function matrixAppendRowValues(
  headers: string[],
  row: MatrixPatchRow,
  sapDefaults: Map<string, Record<string, string | number>>,
): (string | number | null)[] {
  const codeColumn = headers.findIndex((header) => CODE_HEADERS.includes(header));
  if (codeColumn < 0) throw new Error("Coluna de codigo nao encontrada na aba MATRIZ.");
  const fieldColumns = Object.fromEntries(Object.entries(MATRIX_FIELDS).map(([field, definition]) => [
    field, headers.findIndex((header) => definition.aliases.includes(header)),
  ]));
  const explicit = matrixFieldValues(row);
  for (const field of Object.keys(explicit)) {
    if (Number(fieldColumns[field]) < 0) throw new Error(`Coluna ${MATRIX_FIELDS[field].label} nao encontrada na aba MATRIZ.`);
  }
  const fields = { ...(sapDefaults.get(String(row.code)) || {}), ...appendDataValues(row), ...explicit };
  if (!String(fields.description || "").trim()) {
    throw new Error(`Codigo ${row.code} nao encontrado com descricao no Cadastro Item SAP ou no portal.`);
  }
  const cells: (string | number | null)[] = Array(headers.length).fill(null);
  cells[codeColumn] = String(row.code);
  for (const [field, value] of Object.entries(fields)) {
    const column = Number(fieldColumns[field]);
    if (column >= 0) cells[column] = value;
  }
  return cells;
}

async function addMatrixTableRows(
  token: string,
  itemId: string,
  table: MatrixTable,
  rows: MatrixPatchRow[],
  sapDefaults: Map<string, Record<string, string | number>>,
): Promise<number> {
  if (!rows.length) return 0;
  const values = rows.map((row) => matrixAppendRowValues(table.headers, row, sapDefaults));
  const response = await fetchWithRetry(
    `${GRAPH_ROOT}/items/${itemId}/workbook/tables/${encodeURIComponent(table.id)}/rows/add`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ index: null, values }),
    },
  );
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    throw new Error(`Nao foi possivel incluir novos itens na tabela MATRIZ (${response.status}, ${String(failure?.error?.code || "erro").replace(/[^a-z0-9_.-]/gi, "")}).`);
  }
  await response.body?.cancel().catch(() => {});
  return rows.length;
}

async function patchWorkbookResource(
  token: string,
  url: string,
  body: Record<string, unknown>,
  label: string,
): Promise<void> {
  if (!Object.keys(body).length) return;
  const response = await fetchWithRetry(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    throw new Error(`${label} (${response.status}, ${String(failure?.error?.code || "erro").replace(/[^a-z0-9_.-]/gi, "")}).`);
  }
  await response.body?.cancel().catch(() => {});
}

async function cloneMatrixRowStyle(
  token: string,
  itemId: string,
  sheetName: string,
  sourceAddress: string,
  targetAddress: string,
  targetRows: number,
): Promise<boolean> {
  const sourceRange = `${GRAPH_ROOT}/items/${itemId}/workbook/worksheets/${sheetName}/range(address='${sourceAddress}')`;
  const targetRange = `${GRAPH_ROOT}/items/${itemId}/workbook/worksheets/${sheetName}/range(address='${targetAddress}')`;
  try {
    const template = await graphJson(`${sourceRange}?%24select=formulasR1C1,numberFormat`, token);
    const templateFormulas = Array.isArray(template.formulasR1C1) && Array.isArray(template.formulasR1C1[0])
      ? (template.formulasR1C1[0] as unknown[]).map((value) => typeof value === "string" && value.trim().startsWith("=") ? value : null)
      : [];
    const templateFormats = Array.isArray(template.numberFormat) && Array.isArray(template.numberFormat[0])
      ? template.numberFormat[0] as unknown[] : [];
    const repeated = (row: unknown[]) => Array.from({ length: targetRows }, () => [...row]);
    const body = {
      ...(templateFormulas.some((value) => value !== null) ? { formulasR1C1: repeated(templateFormulas) } : {}),
      ...(templateFormats.length ? { numberFormat: repeated(templateFormats) } : {}),
    };
    if (!Object.keys(body).length) return false;
    await patchWorkbookResource(token, targetRange, body,
      "Nao foi possivel copiar formulas e formatos da ultima linha da MATRIZ");
    return true;
  } catch {
    // A formatacao auxiliar nao pode impedir a inclusao dos dados. A planilha continua protegida pelo backup.
    return false;
  }
}

async function addMatrixRangeRows(
  token: string,
  itemId: string,
  sheetName: string,
  headers: string[],
  baseRow: number,
  baseColumn: number,
  lastDataOffset: number,
  rows: MatrixPatchRow[],
  sapDefaults: Map<string, Record<string, string | number>>,
): Promise<number> {
  if (!rows.length) return 0;
  if (lastDataOffset < 0) throw new Error("A aba MATRIZ nao possui uma linha de item para copiar o padrao visual.");
  const sourceExcelRow = baseRow + lastDataOffset + 1;
  const targetStartRow = sourceExcelRow + 1;
  const targetEndRow = targetStartRow + rows.length - 1;
  const firstColumn = excelColumn(baseColumn);
  const lastColumn = excelColumn(baseColumn + headers.length - 1);
  const sourceAddress = `${firstColumn}${sourceExcelRow}:${lastColumn}${sourceExcelRow}`;
  const targetAddress = `${firstColumn}${targetStartRow}:${lastColumn}${targetEndRow}`;
  const values = rows.map((row) => matrixAppendRowValues(headers, row, sapDefaults));
  await cloneMatrixRowStyle(token, itemId, sheetName, sourceAddress, targetAddress, rows.length);
  await patchWorkbookResource(token,
    `${GRAPH_ROOT}/items/${itemId}/workbook/worksheets/${sheetName}/range(address='${targetAddress}')`,
    { values }, "Nao foi possivel incluir novos itens no intervalo da MATRIZ");
  return rows.length;
}

async function findBackupFolder(token: string, parentFolderId: string): Promise<string | null> {
  const folderUrl = `${GRAPH_ROOT}/items/${encodeURIComponent(parentFolderId)}:/${encodeURIComponent(BACKUP_FOLDER_NAME)}?%24select=id,name,folder`;
  const response = await fetchWithRetry(folderUrl, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Cache-Control": "no-cache, no-store",
    },
  });
  if (response.status === 404) return null;
  const item = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Nao foi possivel localizar a pasta de backup (${response.status}).`);
  if (item.name !== BACKUP_FOLDER_NAME || !item.folder || !item.id) {
    throw new Error(`Ja existe um arquivo chamado ${BACKUP_FOLDER_NAME}; renomeie-o para liberar a pasta de backup.`);
  }
  return String(item.id);
}

async function ensureBackupFolder(token: string, parentFolderId: string): Promise<string> {
  const existingId = await findBackupFolder(token, parentFolderId);
  if (existingId) return existingId;
  const response = await fetchWithRetry(`${GRAPH_ROOT}/items/${encodeURIComponent(parentFolderId)}/children`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: BACKUP_FOLDER_NAME,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    }),
  });
  if (response.status === 409) {
    const racedId = await findBackupFolder(token, parentFolderId);
    if (racedId) return racedId;
  }
  const folder = await response.json().catch(() => ({}));
  if (!response.ok || folder.name !== BACKUP_FOLDER_NAME || !folder.folder || !folder.id) {
    throw new Error(`Nao foi possivel criar a pasta ${BACKUP_FOLDER_NAME} no OneDrive (${response.status}).`);
  }
  return String(folder.id);
}

async function createWorkbookBackup(token: string, target: { item: GraphItem; folderId: string; driveId: string }): Promise<string> {
  const backupFolderId = await ensureBackupFolder(token, target.folderId);
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/T/, "-").slice(0, 15);
  const suffix = crypto.randomUUID().slice(0, 4);
  const backupName = `DebaPortal-backup-matriz-${now}-${suffix}.xlsx`;
  const response = await fetchWithRetry(`${GRAPH_ROOT}/items/${encodeURIComponent(target.item.id)}/copy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ parentReference: { driveId: target.driveId, id: backupFolderId }, name: backupName }),
  });
  if (response.status !== 202) {
    const failure = await response.json().catch(() => ({}));
    throw new Error(`Nao foi possivel criar o backup no OneDrive (${response.status}, ${String(failure?.error?.code || "erro").replace(/[^a-z0-9_.-]/gi, "")}).`);
  }
  const backupUrl = `${GRAPH_ROOT}/items/${encodeURIComponent(backupFolderId)}:/${encodeURIComponent(backupName)}?%24select=id,name,size,file`;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const statusResponse = await fetchWithRetry(backupUrl, {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Cache-Control": "no-cache, no-store",
      },
    });
    if (statusResponse.ok) {
      const backup = await statusResponse.json().catch(() => ({}));
      const expectedSize = Number(target.item.size || 0);
      if (backup.name === backupName && backup.file
        && Number(backup.size || 0) > 0
        && (!expectedSize || Number(backup.size) === expectedSize)) return backupName;
    } else if (statusResponse.status !== 404) {
      throw new Error(`Nao foi possivel confirmar o backup no OneDrive (${statusResponse.status}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_250));
  }
  throw new Error("O backup do OneDrive nao terminou dentro do prazo.");
}

type WorkbookUpdate = { address: string; values: (string | number | null)[] };

async function applyWorkbookUpdates(
  token: string,
  itemId: string,
  sheetName: string,
  updates: WorkbookUpdate[],
): Promise<void> {
  let pending = [...updates];
  let lastStatus = 500;
  for (let attempt = 0; attempt < 4 && pending.length; attempt += 1) {
    const batchResponse = await fetchWithRetry("https://graph.microsoft.com/v1.0/$batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: pending.map((update, index) => ({
        id: String(index + 1), method: "PATCH",
        url: `/me/drive/items/${itemId}/workbook/worksheets/${sheetName}/range(address='${update.address}')`,
        headers: { "Content-Type": "application/json" }, body: { values: [update.values] },
      })) }),
    });
    const batch = await batchResponse.json().catch(() => ({}));
    if (!batchResponse.ok || !Array.isArray(batch.responses)) {
      throw new Error(`Microsoft recusou o lote de alteracoes (${batchResponse.status}).`);
    }
    const responses = new Map(batch.responses.map((entry: { id?: string; status?: number }) => [String(entry.id || ""), entry]));
    const retry: WorkbookUpdate[] = [];
    for (let index = 0; index < pending.length; index += 1) {
      const status = Number(responses.get(String(index + 1))?.status || 500);
      if (status >= 200 && status < 300) continue;
      lastStatus = status;
      if (status === 401 || status === 403) throw new Error("Permissao de escrita ausente. Reconecte o OneDrive no painel.");
      if (!RETRYABLE_BATCH_STATUS.has(status)) throw new Error(`Falha ao atualizar uma linha da matriz (${status}).`);
      retry.push(pending[index]);
    }
    pending = retry;
    if (pending.length && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(750 * (2 ** attempt), 6_000)));
    }
  }
  if (pending.length) throw new Error(`Falha temporaria ao atualizar ${pending.length} linha(s) da matriz (${lastStatus}). Tente novamente.`);
}

async function patchMatrixWorkbook(rows: MatrixPatchRow[]): Promise<Record<string, unknown>> {
  const sanitized = sanitizeMatrixRows(rows);
  const token = await graphToken(true);
  const target = await resolveWorkbookTarget(token);
  const backupName = await createWorkbookBackup(token, target);
  try {
    const itemId = encodeURIComponent(target.item.id);
    const sheetName = encodeURIComponent("MATRIZ");
    const used = await graphJson(
      `${GRAPH_ROOT}/items/${itemId}/workbook/worksheets/${sheetName}/usedRange(valuesOnly=true)?%24select=rowIndex,columnIndex,rowCount,columnCount`, token,
    );
    const baseRow = Number(used.rowIndex || 0);
    const baseColumn = Number(used.columnIndex || 0);
    const rowCount = Number(used.rowCount || 0);
    const columnCount = Number(used.columnCount || 0);
    if (!Number.isInteger(rowCount) || !Number.isInteger(columnCount) || rowCount < 2 || columnCount < 1 || columnCount > 200) {
      throw new Error("Dimensoes da aba MATRIZ invalidas.");
    }
    const firstColumnLetter = excelColumn(baseColumn);
    const lastColumnLetter = excelColumn(baseColumn + columnCount - 1);
    const headerScanRows = Math.min(rowCount, 50);
    const headerAddress = `${firstColumnLetter}${baseRow + 1}:${lastColumnLetter}${baseRow + headerScanRows}`;
    const headerRange = await graphJson(
      `${GRAPH_ROOT}/items/${itemId}/workbook/worksheets/${sheetName}/range(address='${headerAddress}')?%24select=values`, token,
    );
    const headerValues = Array.isArray(headerRange.values) ? headerRange.values as unknown[][] : [];
    const headerOffset = headerValues.findIndex((line) => Array.isArray(line) && line.some((value) => CODE_HEADERS.includes(normalizeHeader(value))));
    if (headerOffset < 0) throw new Error("Cabecalho da aba MATRIZ nao reconhecido.");
    const rawHeaders = headerValues[headerOffset] || [];
    const headers = Array.from({ length: columnCount }, (_, index) => normalizeHeader(rawHeaders[index]));
    const codeColumn = headers.findIndex((header) => CODE_HEADERS.includes(header));
    const fieldColumns = Object.fromEntries(Object.entries(MATRIX_FIELDS).map(([field, definition]) => [
      field, headers.findIndex((header) => definition.aliases.includes(header)),
    ]));
    const sourceRows = new Map<string, number[]>();
    const wantedCodes = new Set(sanitized.map((row) => String(row.code)));
    const codeColumnLetter = excelColumn(baseColumn + codeColumn);
    let lastDataOffset = -1;
    const firstDataOffset = headerOffset + 1;
    const codeChunkSize = 20_000;
    for (let startOffset = firstDataOffset; startOffset < rowCount; startOffset += codeChunkSize) {
      const endOffset = Math.min(rowCount - 1, startOffset + codeChunkSize - 1);
      const codeAddress = `${codeColumnLetter}${baseRow + startOffset + 1}:${codeColumnLetter}${baseRow + endOffset + 1}`;
      const codeRange = await graphJson(
        `${GRAPH_ROOT}/items/${itemId}/workbook/worksheets/${sheetName}/range(address='${codeAddress}')?%24select=values`, token,
      );
      const codeValues = Array.isArray(codeRange.values) ? codeRange.values as unknown[][] : [];
      for (let index = 0; index < codeValues.length; index += 1) {
        const offset = startOffset + index;
        const code = String(codeValues[index]?.[0] ?? "").trim().replace(/\.0+$/, "");
        if (!code) continue;
        lastDataOffset = offset;
        if (!wantedCodes.has(code)) continue;
        const offsets = sourceRows.get(code) || [];
        offsets.push(offset);
        sourceRows.set(code, offsets);
      }
    }

    const missingRows: MatrixPatchRow[] = [];
    const updates = sanitized.flatMap((row) => {
      const rowOffsets = sourceRows.get(String(row.code)) || [];
      if (!rowOffsets.length) {
        missingRows.push(row);
        return [];
      }
      if (rowOffsets.length > 1 && (row.applicationProvided || row.yearProvided)) {
        throw new Error(`O codigo ${row.code} possui varias linhas na MATRIZ. Atualize aplicacao e ano pela planilha completa.`);
      }
      const fields = matrixFieldValues(row);
      const targetCells = Object.entries(fields).map(([field, value]) => {
        const column = Number(fieldColumns[field]);
        if (column < 0) throw new Error(`Coluna ${MATRIX_FIELDS[field].label} nao encontrada na aba MATRIZ.`);
        return { column, value };
      });
      const firstColumn = Math.min(...targetCells.map((cell) => cell.column));
      const lastColumn = Math.max(...targetCells.map((cell) => cell.column));
      const rowValues: (string | number | null)[] = Array(lastColumn - firstColumn + 1).fill(null);
      for (const cell of targetCells) rowValues[cell.column - firstColumn] = cell.value;
      return rowOffsets.map((rowOffset) => {
        const excelRow = baseRow + rowOffset + 1;
        const address = `${excelColumn(baseColumn + firstColumn)}${excelRow}:${excelColumn(baseColumn + lastColumn)}${excelRow}`;
        return { address, values: rowValues };
      });
    });

    let rowsAdded = 0;
    if (missingRows.length) {
      const rowsNeedingSap = missingRows.filter((row) => !String(appendDataValues(row).description || "").trim());
      const [table, sapDefaults] = await Promise.all([
        findMatrixTable(token, itemId, sheetName),
        rowsNeedingSap.length
          ? loadSapMatrixDefaults(token, itemId, rowsNeedingSap.map((row) => String(row.code)))
          : Promise.resolve(new Map<string, Record<string, string | number>>()),
      ]);
      rowsAdded = table
        ? await addMatrixTableRows(token, itemId, table, missingRows, sapDefaults)
        : await addMatrixRangeRows(token, itemId, sheetName, headers, baseRow, baseColumn, lastDataOffset, missingRows, sapDefaults);
    }
    for (let start = 0; start < updates.length; start += 10) {
      await applyWorkbookUpdates(token, itemId, sheetName, updates.slice(start, start + 10));
    }
    return {
      updated: true,
      rows_updated: sanitized.length,
      sheet_rows_updated: updates.length + rowsAdded,
      rows_added: rowsAdded,
      backup_name: backupName,
      backup_folder: BACKUP_FOLDER_NAME,
    };
  } catch (error) {
    throw new Error(`${errorMessage(error)} Backup preservado: ${BACKUP_FOLDER_NAME}/${backupName}.`);
  }
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

async function secureWorkbookDownload(req: Request, jobId: string): Promise<Response> {
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
    const { error: refreshError } = await admin.from("sync_jobs").update({
      source_size: item.size ?? null,
      source_modified: item.lastModifiedDateTime ?? null,
    }).eq("id", jobId);
    if (refreshError) throw new Error("Nao foi possivel atualizar a referencia da planilha.");
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
      return await secureWorkbookDownload(req, String(input.job_id || ""));
    }

    const { user } = await requireAdmin(req);
    if (input.action === "connect_start") return jsonResponse(req, { data: await startMicrosoftConnection() });
    if (input.action === "connect_complete") {
      return jsonResponse(req, { data: await completeMicrosoftConnection(String(input.device_code || "")) });
    }
    if (input.action === "patch_matrix") {
      return jsonResponse(req, { data: await patchMatrixWorkbook(input.rows || []) });
    }
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
