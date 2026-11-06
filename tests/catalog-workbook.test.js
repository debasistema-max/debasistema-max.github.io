import test from "node:test";
import assert from "node:assert/strict";
import { deduplicateStockRows, finiteNumber, publicText } from "../scripts/lib/catalog-workbook.mjs";

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
