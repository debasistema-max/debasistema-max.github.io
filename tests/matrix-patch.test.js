import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { parseMatrixPatchFile } from '../src/lib/importer.js';
import { parseMatrixPatchRecords, parsePriceList02Matrix, prepareMatrixPatch } from '../src/lib/matrix-patch.js';

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

test('lê somente código e PRC.LIST 02 do relatório de preços', () => {
  const parsed = parsePriceList02Matrix([
    ['Observação', 'DESCONTO MAX. 5%'],
    [],
    ['#', 'Cód.', 'ITEM', 'MARK', 'MODEL', 'YEARS', 'NCM', 'IPI %', 'PRC.LIST 01', 'PRC.LIST 02'],
    [1, 7175526020, 'CAIXA DIR.HID.', 'TOYOTA', 'HILUX', "05-15", '8708.94.83', '3,25%', '648,50', '628,00'],
    ['BR260103'],
    ['#', 'Cód.', 'ITEM', 'MARK', 'MODEL', 'YEARS', 'NCM', 'IPI %', 'PRC.LIST 01', 'PRC.LIST 02'],
    [1, 7175526030, 'CAIXA DIR.HID.', 'TOYOTA', 'HILUX', "16-", '8708.94.83', '3,25%', '779,60', '755,00']
  ]);
  assert.deepEqual(parsed.rows, [
    { code: '7175526020', base_price: 628 },
    { code: '7175526030', base_price: 755 }
  ]);
});

test('marca preço da LISTA 02 como atualização do preço base', () => {
  const result = prepareMatrixPatch([{ code: 'A1', base_price: 125.04 }], [{
    code: 'A1', description: 'Produto A', category: 'Direção', commercial_line: 'Leve', product_line: 'Marca A', synonyms: [], applications: []
  }]);
  assert.equal(result.hasBasePrice, true);
  assert.equal(result.mergedRows[0].base_price, 125.04);
  assert.equal(result.changes[0].field, 'Preço base');
});
