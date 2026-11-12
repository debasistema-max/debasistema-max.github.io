import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  basePlusIpi,
  deduplicateStockRows,
  finiteNumber,
  parsePortalWorkbook,
  percentageRate,
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
    ["CODIGO", "DESCRICAO", "PRECO S/IMP", "IPI"],
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

  assert.deepEqual(prices, {
    "PR-PR": 130,
    "SP-SP": 110,
    "PR-SC": 110,
    "PR-SP": 110,
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
