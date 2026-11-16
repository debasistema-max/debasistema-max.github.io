import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { parseMatrixPatchFile } from '../src/lib/importer.js';
import { parseMatrixPatchRecords, prepareMatrixPatch } from '../src/lib/matrix-patch.js';

test('lê um arquivo Excel contendo somente os itens alterados', async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
    { Código: 'A1', Descrição: 'Descrição nova', Aplicação: 'CARRO', Ano: '20-24' }
  ]), 'MATRIZ PARCIAL');
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const file = {
    name: 'matriz-parcial.xlsx',
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
  const parsed = await parseMatrixPatchFile(file);
  assert.equal(parsed.rows[0].code, 'A1');
  assert.equal(parsed.rows[0].description, 'Descrição nova');
  assert.deepEqual(parsed.rows[0].applicationValues, ['CARRO']);
  assert.deepEqual(parsed.rows[0].yearValues, ['20-24']);
});

test('prepara atualização parcial preservando células vazias e demais produtos', () => {
  const parsed = parseMatrixPatchRecords([
    { Código: 'A1', Descrição: 'Descrição nova', Categoria: '', Ano: '20-24' },
    { Código: 'B2', Descrição: '', Categoria: 'Direção', Ano: '' }
  ]);
  const current = [
    { code: 'A1', description: 'Descrição antiga', category: 'Suspensão', commercial_line: 'Leve', product_line: 'Marca A', synonyms: ['A'], applications: [{ application: 'CARRO', year: '18-22' }] },
    { code: 'B2', description: 'Produto B', category: 'Suspensão', commercial_line: 'Pesada', product_line: 'Marca B', synonyms: [], applications: [{ application: 'CAMINHÃO', year: '10-15' }] },
    { code: 'C3', description: 'Não deve mudar', category: 'Freio', commercial_line: 'Leve', product_line: 'Marca C', synonyms: [], applications: [] }
  ];
  const result = prepareMatrixPatch(parsed.rows, current);
  assert.equal(result.mergedRows.length, 2);
  assert.equal(result.changes.length, 3);
  assert.equal(result.mergedRows[0].category, 'Suspensão');
  assert.deepEqual(result.mergedRows[0].applications, [{ application: 'CARRO', year: '20-24' }]);
  assert.equal(result.mergedRows.some((row) => row.code === 'C3'), false);
});

test('bloqueia códigos inexistentes e permite marcador LIMPAR', () => {
  const parsed = parseMatrixPatchRecords([
    { Código: 'A1', Sinônimos: 'LIMPAR' },
    { Código: 'X9', Sinônimos: 'Novo' }
  ]);
  const result = prepareMatrixPatch(parsed.rows, [{
    code: 'A1', description: 'Produto A', category: null, commercial_line: 'Leve', product_line: 'Marca A', synonyms: ['Antigo'], applications: []
  }]);
  assert.deepEqual(result.missingCodes, ['X9']);
  assert.deepEqual(result.mergedRows[0].synonyms, []);
  assert.equal(result.changes[0].field, 'Sinônimos');
});

test('rejeita código duplicado na planilha parcial', () => {
  assert.throws(() => parseMatrixPatchRecords([
    { Código: 'A1', Descrição: 'Um' },
    { Código: 'A1', Descrição: 'Dois' }
  ]), /duplicado/);
});
