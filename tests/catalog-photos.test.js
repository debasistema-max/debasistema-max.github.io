import test from "node:test";
import assert from "node:assert/strict";
import { fetchCatalogPhotos, normalizePhotoRecord } from "../scripts/lib/catalog-photos.mjs";

const origin = "https://catalogo.example";

test("aceita somente caminhos de foto da origem autorizada", () => {
  assert.deepEqual(normalizePhotoRecord({
    code: "123456",
    primaryImageUrl: "/uploads/products/123456/site/123456.webp",
    updatedAt: "2026-11-06T10:00:00Z",
  }, origin), {
    code: "123456",
    image_path: "/uploads/products/123456/site/123456.webp",
    source_updated_at: "2026-11-06T10:00:00.000Z",
  });
  assert.equal(normalizePhotoRecord({ code: "123456", primaryImageUrl: "https://outro.example/foto.webp" }, origin), null);
  assert.equal(normalizePhotoRecord({ code: "123456", primaryImageUrl: "/arquivo.txt" }, origin), null);
});

test("pagina e consolida fotos repetidas do catalogo", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const page = Number(new URL(url).searchParams.get("page"));
    return {
      ok: true,
      async json() {
        return { data: { pages: 2, products: [{
          code: String(page),
          primaryImageUrl: `/uploads/products/${page}/site/${page}.webp`,
        }, ...(page === 2 ? [{ code: "1", primaryImageUrl: "/uploads/products/1/site/1.webp" }] : [])] } };
      },
    };
  };
  const rows = await fetchCatalogPhotos({ fetchImpl, apiUrl: `${origin}/api/catalog/products`, imageOrigin: origin });
  assert.equal(calls.length, 2);
  assert.deepEqual(rows.map((row) => row.code), ["1", "2"]);
});
