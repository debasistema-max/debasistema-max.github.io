import test from "node:test";
import assert from "node:assert/strict";
import { finiteNumber, publicText } from "../scripts/lib/catalog-workbook.mjs";

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
