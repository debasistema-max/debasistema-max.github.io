import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  basePlusIpi,
  deduplicateStockRows,
  finiteNumber,
  parsePortalWorkbook,
  percentageRate,
  productBrandText,
  publicText,
} from "../scripts/lib/catalog-workbook.mjs";

test("interpreta estoque com sufixo de quantidade", () => {
  assert.equal(finiteNumber("100+"), 100);
  assert.equal(finiteNumber("1.234,56"), 1234.56);
  assert.equal(finiteNumber(""), null);
});

test("remove marcas empresariais de campos publicos", () => {
  const blocked = [
    ["I", "P", "S"].join("") + " do Brasil",
    ["Yoko", "mitsu"].join(""),
    ["R", "T", "Group"].join(" "),
  ].join(" ");
  assert.equal(publicText(`Produto ${blocked}`), "Produto");
  assert.equal(publicText("Aplicacao normal"), "Aplicacao normal");
  assert.equal(productBrandText(["Yoko", "mitsu"].join("")), ["Yoko", "mitsu"].join(""));
  assert.equal(productBrandText(["I", "P", "S"].join("")), "");
});

test("consolida estoque repetido por produto e filial", () => {
  const rows = [
    { code: "100", origin_code: "PR", quantity: 8 },
    { code: "100", origin_code: "PR", quantity: 8 },
    { code: "100", origin_code: "SP", quantity: 3 },
  ];
  assert.deepEqual(deduplicateStockRows(rows), [rows[1], rows[2]]);
  assert.throws(
    () => deduplicateStockRows([rows[0], { ...rows[0], quantity: 9 }], "catalogo.xlsx"),
    /estoques conflitantes/,
  );
});

test("normaliza IPI e calcula somente base mais IPI", () => {
  assert.equal(percentageRate("9,75%"), 0.0975);
  assert.equal(percentageRate(5), 0.05);
  assert.equal(percentageRate(0.05), 0.05);
  assert.equal(percentageRate("1%"), 0.01);
  assert.equal(percentageRate(""), null);
  assert.equal(basePlusIpi(232, 22.62, null), 254.62);
  assert.equal(basePlusIpi(100, null, "10%"), 110);
});

test("aplica a regra fiscal por rota comercial", () => {
  const workbook = XLSX.utils.book_new();
  const addSheet = (name, rows) => {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  };

  addSheet("MATRIZ", [
    ["CODIGO IPS", "DESCRICAO", "PRECO S/IMP", "IPI"],
    ["ABC-1", "Produto de teste", 100, "10%"],
  ]);
  for (const [route, importedTotal] of [["PR-PR", 130], ["SP-SP", 140], ["PR-SC", 120]]) {
    addSheet(`LISTA ${route}`, [
      ["CODIGO", "DESCRICAO", "PRECO S/IMP", "PRECO C/IMPOSTOS"],
      ["ABC-1", "Produto de teste", 100, importedTotal],
    ]);
  }
  addSheet("Cálculo Fiscal", [
    ["ROTA", "CODIGO", "PRECO S/IMP", "IPI", "ICMS-ST", "PRECO FINAL"],
    ["PR-PR", "ABC-1", 100, 10, 20, 130],
    ["SP-SP", "ABC-1", 100, 10, 30, 140],
    ["PR-SC", "ABC-1", 100, 10, 10, 120],
  ]);
  for (const branch of ["PR", "SP"]) {
    addSheet(`PORTAL ESTOQUE ${branch}`, [
      ["CODIGO", "ESTOQUE", "DISP GERAL"],
      ["ABC-1", 8, 8],
    ]);
  }

  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const { datasets } = parsePortalWorkbook(XLSX, bytes, "teste.xlsx");
  const priceRows = datasets.find((dataset) => dataset.kind === "PRECOS").rows;
  const prices = Object.fromEntries(priceRows.map((row) => [row.price_table_code, row.price]));
  const basePrices = Object.fromEntries(priceRows.map((row) => [row.price_table_code, row.base_price]));

  assert.deepEqual(prices, {
    "PR-PR": 130,
    "SP-SP": 110,
    "PR-SC": 110,
    "PR-SP": 110,
  });
  assert.deepEqual(basePrices, {
    "PR-PR": 100,
    "SP-SP": 100,
    "PR-SC": 100,
    "PR-SP": 100,
  });
});

test("mantém aplicação e ano em campos separados", () => {
  const workbook = XLSX.utils.book_new();
  const addSheet = (name, rows) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  addSheet("MATRIZ", [
    ["CODIGO", "DESCRICAO", "APLICACAO", "ANO", "PRECO S/IMP", "IPI"],
    ["ABC-2", "Produto com aplicação", "Veículo / Modelo", "2018/...", 100, "10%"],
  ]);
  addSheet("LISTA PR-PR", [
    ["CODIGO", "DESCRICAO", "PRECO S/IMP", "PRECO C/IMPOSTOS"],
    ["ABC-2", "Produto com aplicação", 100, 110],
  ]);
  addSheet("PORTAL ESTOQUE PR", [
    ["CODIGO", "ESTOQUE", "DISP GERAL"],
    ["ABC-2", 5, 5],
  ]);
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const { datasets } = parsePortalWorkbook(XLSX, bytes, "aplicacao-ano.xlsx");
  const product = datasets.find((dataset) => dataset.kind === "PRODUTOS").rows[0];

  assert.deepEqual(product.applications, [{ application: "Veículo / Modelo", year: "2018/..." }]);
});

test("prioriza descrição, aplicação e ano da MATRIZ sobre o Cadastro Item SAP", () => {
  const workbook = XLSX.utils.book_new();
  const addSheet = (name, rows) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  addSheet("MATRIZ", [
    ["CODIGO", "DESCRICAO", "APLICACAO", "ANO", "PRECO S/IMP", "IPI"],
    ["ABC-20", "Descrição comercial da matriz", "KADETT 89/98 IPANEMA", "89-90 91-98", 100, "10%"],
  ]);
  addSheet("Cadastro Item SAP", [
    ["Nº do item", "Descrição do item", "Código NCM", "Modelo", "Ano", "Grupo de itens"],
    ["ABC-20", "Descrição diferente do SAP", "8708", "Kadett", "89-98", "AMORTECEDOR"],
  ]);
  addSheet("LISTA PR-PR", [
    ["CODIGO", "DESCRICAO", "PRECO S/IMP", "PRECO C/IMPOSTOS"],
    ["ABC-20", "Descrição da lista", 100, 110],
  ]);
  addSheet("PORTAL ESTOQUE PR", [
    ["CODIGO", "ESTOQUE", "DISP GERAL"],
    ["ABC-20", 5, 5],
  ]);

  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const { datasets } = parsePortalWorkbook(XLSX, bytes, "matriz-prioritaria.xlsx");
  const product = datasets.find((dataset) => dataset.kind === "PRODUTOS").rows[0];

  assert.equal(product.description, "Descrição comercial da matriz");
  assert.deepEqual(product.applications, [{ application: "KADETT 89/98 IPANEMA", year: "89-90 91-98" }]);
  assert.ok(product.synonyms.includes("Kadett"));
});

test("separa marca da linha comercial do produto", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["CODIGO", "DESCRICAO", "MARCA", "LINHA", "PRECO S/IMP", "IPI"],
    ["ABC-3", "Produto com marca", ["Yoko", "mitsu"].join(""), "Utilitarios", 100, "10%"],
  ]), "MATRIZ");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["CODIGO", "DESCRICAO", "PRECO S/IMP", "PRECO C/IMPOSTOS"],
    ["ABC-3", "Produto com marca", 100, 110],
  ]), "LISTA PR-PR");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["CODIGO", "ESTOQUE", "DISP GERAL"],
    ["ABC-3", 5, 5],
  ]), "PORTAL ESTOQUE PR");

  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const { datasets } = parsePortalWorkbook(XLSX, bytes, "marca-linha.xlsx");
  const product = datasets.find((dataset) => dataset.kind === "PRODUTOS").rows[0];

  assert.equal(product.product_line, ["Yoko", "mitsu"].join(""));
  assert.equal(product.commercial_line, "Utilitário");
});

test("classifica automaticamente linhas leve, pesada e utilitario", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["CODIGO", "DESCRICAO", "APLICACAO", "PRECO S/IMP"],
    ["L-1", "FAROL PRINCIPAL", "ASTRA", 100],
    ["P-1", "AMORTECEDOR", "VOLVO FH", 200],
    ["U-1", "CAIXA DE DIRECAO", "HILUX", 300],
  ]), "MATRIZ");

  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const { datasets } = parsePortalWorkbook(XLSX, bytes, "linhas.xlsx", 50_000, ["PRODUTOS"]);
  const products = Object.fromEntries(datasets.find((dataset) => dataset.kind === "PRODUTOS").rows
    .map((product) => [product.code, product.commercial_line]));

  assert.deepEqual(products, { "L-1": "Leve", "P-1": "Pesada", "U-1": "Utilitário" });
});

test("permite atualizar somente produtos sem exigir preços e estoques", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["CODIGO", "DESCRICAO", "PRECO S/IMP"],
    ["ABC-4", "Produto atualizado", 100],
  ]), "MATRIZ");

  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const { datasets } = parsePortalWorkbook(XLSX, bytes, "parcial.xlsx", 50_000, ["PRODUTOS"]);

  assert.equal(datasets.find((dataset) => dataset.kind === "PRODUTOS").rows.length, 1);
  assert.equal(datasets.find((dataset) => dataset.kind === "PRECOS").rows.length, 0);
  assert.equal(datasets.find((dataset) => dataset.kind === "ESTOQUE").rows.length, 0);
});
