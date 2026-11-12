import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExcelWorkbook, buildPdfDocument, commercialRows } from '../src/lib/exporters.js';

const payload = {
  title: 'Lista comercial - completa',
  variant: 'commercial-list',
  context: { destinationState: 'PR', originCode: 'PR', lines: ['Leve', 'Pesada', 'Utilitário'] },
  items: [{
    code: 'ABC-1', description: 'Produto', applications: ['Veículo / Modelo', ' veículo   / modelo '], years: ['2018/...', '2018/...'],
    price: 110, stock_pr: 8, stock_sp: 3, stock_origin: 8, updated_at: '2026-11-12T12:00:00Z'
  }]
};

test('lista comercial separa aplicação e ano e omite atualização', () => {
  const [row] = commercialRows(payload.items);
  assert.equal(row.Aplicação, 'Veículo / Modelo');
  assert.equal(row.Ano, '2018–...');
  assert.equal(Object.hasOwn(row, 'Atualização'), false);
  assert.equal(commercialRows([...payload.items, { ...payload.items[0] }]).length, 1);

  const workbook = buildExcelWorkbook(payload);
  const sheet = workbook.Sheets['Lista comercial'];
  assert.deepEqual(['A5', 'B5', 'C5', 'D5', 'E5', 'F5', 'G5', 'H5'].map((cell) => sheet[cell].v), [
    'Código', 'Descrição', 'Aplicação', 'Ano', 'Preço', 'Estoque PR', 'Estoque SP', 'Disponibilidade'
  ]);
  assert.equal(Object.values(sheet).some((cell) => cell?.v === 'Atualização'), false);
});

test('lista comercial remove ano e grafias repetidas da aplicação', () => {
  const [row] = commercialRows([{
    code: 'ABC-2',
    description: 'Produto',
    applications: ['ASTRA; ASTRA 93/95', 'S-10 05/08; S10'],
    years: ["'93-'95", '05/08', "'93-'95"],
    price: 100,
    stock_pr: 1,
    stock_sp: 0,
    stock_origin: 1
  }]);

  assert.equal(row.Aplicação, 'ASTRA; S-10');
  assert.equal(row.Ano, '93–95; 05–08');
});

test('PDF da lista contém uma única tabela comercial com as novas colunas', () => {
  const pdf = buildPdfDocument(payload);
  const bytes = Buffer.from(pdf.output('arraybuffer'));
  assert.ok(bytes.length > 2_000);
  assert.equal(pdf.getNumberOfPages(), 1);
});
