import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExcelWorkbook, buildPdfDocument, buildSapValidationWorkbook, commercialRows } from '../src/lib/exporters.js';

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

test('lista comercial prioriza o ano informado na aplicação consolidada', () => {
  const [row] = commercialRows([{
    code: 'ABC-3',
    description: 'Retrovisor LD',
    applications: ['CORSA', 'CORSA 94/08'],
    years: ['94/08', '96-08'],
    price: 100,
    stock_pr: 1,
    stock_sp: 0,
    stock_origin: 1
  }]);

  assert.equal(row.Aplicação, 'CORSA');
  assert.equal(row.Ano, '94–08');
});

test('lista comercial remove períodos menores contidos em um período maior', () => {
  const rows = commercialRows([{
    code: 'ABC-4', description: 'Produto Corsa', applications: ['CORSA'], years: ['94/08', '96-08'],
    price: 100, stock_pr: 1, stock_sp: 0, stock_origin: 1
  }, {
    code: 'ABC-5', description: 'Produto Victoria', applications: ['VICTORIA'], years: ['90-95', '94/95'],
    price: 100, stock_pr: 1, stock_sp: 0, stock_origin: 1
  }, {
    code: 'ABC-6', description: 'Produto com períodos distintos', applications: ['MODELO'], years: ['93-95', '05/08'],
    price: 100, stock_pr: 1, stock_sp: 0, stock_origin: 1
  }]);

  assert.equal(rows[0].Ano, '94–08');
  assert.equal(rows[1].Ano, '90–95');
  assert.equal(rows[2].Ano, '93–95; 05–08');
});

test('PDF da lista contém uma única tabela comercial com as novas colunas', () => {
  const pdf = buildPdfDocument(payload);
  const bytes = Buffer.from(pdf.output('arraybuffer'));
  assert.ok(bytes.length > 2_000);
  assert.equal(pdf.getNumberOfPages(), 1);
});

test('planilha de conferência destaca entradas manuais e calcula divergências', () => {
  const workbook = buildSapValidationWorkbook({
    items: [{
      validation_line: 'Leve', code: 'ABC-1', description: 'Produto', price: 110,
      stock_pr: 8, stock_sp: 3
    }],
    context: { destinationState: 'PR', originCode: 'PR', tableCode: 'PR-PR', sampleByLine: { Leve: 3, Pesada: 5, Utilitário: 7 } }
  });
  const sheet = workbook.Sheets['Conferência SAP'];
  const summary = workbook.Sheets.Resumo;

  assert.deepEqual(['A7', 'B7', 'E7', 'F7', 'O7', 'P7'].map((cell) => sheet[cell].v), [
    'Linha', 'Código', 'Preço portal', 'Preço SAP', 'Status', 'Observações'
  ]);
  assert.equal(sheet.A8.v, 'Leve');
  assert.equal(sheet.B8.v, 'ABC-1');
  assert.equal(sheet.E8.v, 110);
  assert.match(sheet.G8.f, /F8-E8/);
  assert.match(sheet.H8.f, /F8\/E8-1/);
  assert.match(sheet.K8.f, /J8-I8/);
  assert.match(sheet.N8.f, /M8-L8/);
  assert.match(sheet.O8.f, /PORTAL SEM PREÇO/);
  assert.match(sheet.O8.f, /DIVERGENTE/);
  assert.equal(sheet.F8.s.fill.fgColor.rgb, 'FFF2CC');
  assert.equal(sheet.B5.s.fill.fgColor.rgb, 'FFF2CC');
  assert.match(sheet.A2.v, /Leve: 3/);
  assert.match(sheet.A2.v, /Pesada: 5/);
  assert.match(sheet.A2.v, /Utilitário: 7/);
  assert.match(summary.B8.f, /COUNTIF/);
  assert.match(summary.C17.f, /COUNTIFS/);
  assert.deepEqual(workbook.SheetNames, ['Resumo', 'Conferência SAP']);
  assert.equal(workbook.Props.Company, 'DebaPortal');
});
