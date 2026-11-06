const CODE_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const IMAGE_PATH_PATTERN = /^\/uploads\/products\/[A-Za-z0-9._-]+\/site\/[A-Za-z0-9._-]+\.(?:webp|png|jpe?g)$/i;

function trustedBase(value, label) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${label} deve usar HTTPS sem credenciais embutidas.`);
  }
  return url;
}

export function normalizePhotoRecord(item, imageOrigin) {
  const code = String(item?.code || "").trim();
  const source = String(item?.primaryImageUrl || "").trim();
  if (!CODE_PATTERN.test(code) || !source) return null;

  const origin = trustedBase(imageOrigin, "Origem das imagens");
  const image = new URL(source, origin);
  let decodedPath = "";
  try {
    decodedPath = decodeURIComponent(image.pathname);
  } catch {
    return null;
  }
  if (image.origin !== origin.origin || decodedPath.includes("..") || decodedPath.includes("\\")) return null;
  if (!IMAGE_PATH_PATTERN.test(decodedPath)) return null;

  const updatedAt = String(item?.updatedAt || "").trim();
  return {
    code,
    image_path: image.pathname,
    source_updated_at: updatedAt && !Number.isNaN(Date.parse(updatedAt)) ? new Date(updatedAt).toISOString() : null,
  };
}

async function fetchPage(fetchImpl, apiUrl, imageOrigin, page, timeoutMs) {
  const endpoint = trustedBase(apiUrl, "API do catalogo");
  const origin = trustedBase(imageOrigin, "Origem das imagens");
  if (endpoint.origin !== origin.origin) throw new Error("API e imagens devem usar a mesma origem autorizada.");
  endpoint.searchParams.set("page", String(page));
  endpoint.searchParams.set("limit", "48");

  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        headers: { Accept: "application/json", "User-Agent": "DebaPortal-Catalog/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const data = payload?.data;
      if (!data || !Array.isArray(data.products)) throw new Error("Resposta de catalogo invalida.");
      const pages = Math.max(1, Math.min(200, Number(data.pages || 1)));
      return { pages, products: data.products };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error(`Catalogo de fotos indisponivel: ${lastError instanceof Error ? lastError.message : "falha de rede"}.`);
}

export async function fetchCatalogPhotos({ fetchImpl = fetch, apiUrl, imageOrigin, timeoutMs = 20_000 }) {
  const first = await fetchPage(fetchImpl, apiUrl, imageOrigin, 1, timeoutMs);
  const products = [...first.products];
  const remaining = Array.from({ length: first.pages - 1 }, (_, index) => index + 2);
  for (let offset = 0; offset < remaining.length; offset += 6) {
    const batch = await Promise.all(
      remaining.slice(offset, offset + 6).map((page) => fetchPage(fetchImpl, apiUrl, imageOrigin, page, timeoutMs)),
    );
    batch.forEach((result) => products.push(...result.products));
  }

  const unique = new Map();
  for (const item of products) {
    const row = normalizePhotoRecord(item, imageOrigin);
    if (!row) continue;
    const existing = unique.get(row.code);
    if (existing && existing.image_path !== row.image_path) {
      throw new Error(`Catalogo retornou fotos conflitantes para o codigo ${row.code}.`);
    }
    unique.set(row.code, row);
  }
  if (!unique.size) throw new Error("Catalogo nao retornou fotos validas.");
  return [...unique.values()];
}

export function assertSafePhotoSnapshot(incomingCount, storedCount) {
  const incoming = Number(incomingCount || 0);
  const stored = Number(storedCount || 0);
  if (stored > 0 && incoming < Math.floor(stored * 0.8)) {
    throw new Error("Catalogo de fotos veio incompleto; as referencias anteriores foram mantidas.");
  }
}
