import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExcelWorkbook, buildPdfDocument, buildSapValidationQuoteWorkbook, buildSapValidationWorkbook, commercialRows, exportFileName } from '../src/lib/exporters.js';

const payload = {
  title: 'Lista comercial - completa',
  variant: 'commercial-list',
  context: { destinationState: 'SC', originCode: 'PR', routeCode: 'PR-SC', lines: ['Leve', 'Pesada', 'Utilitário'] },
  items: [{
    code: 'ABC-1', description: 'Produto', brand: 'Marca A', applications: ['Veículo / Modelo', ' veículo   / modelo '], years: ['2018/...', '2018/...'],
    base_price: 100, price: 110, stock_pr: 8, stock_sp: 3, stock_origin: 8, updated_at: '2026-11-12T12:00:00Z'
  }]
};

test('lista comercial separa aplicação e ano e omite atualização', () => {
  const [row] = commercialRows(payload.items);
  assert.equal(row.Aplicação, 'Veículo / Modelo');
  assert.equal(row.Ano, '2018–...');
  assert.equal(Object.hasOwn(row, 'Atualização'), false);
  assert.equal(commercialRows([...payload.items, { ...payload.items[0] }]).length, 1);

  const workbook = buildExcelWorkbook(payload);
  const sheet = workbook.Sheets['LISTA PR-SC'];
  assert.equal(sheet.A1.v, 'LISTA PR-SC');
  assert.deepEqual(['A2', 'B2', 'C2', 'D2', 'E2', 'F2', 'G2', 'H2', 'I2'].map((cell) => sheet[cell].v), [
    'Código IPS', 'Descrição', 'Marca', 'Aplicação', 'Ano', 'Preço s/ impostos', 'Preço c/ impostos', 'Estoque', 'Quantidade'
  ]);
  assert.equal(sheet.F3.v, 100);
  assert.equal(sheet.G3.v, 110);
  assert.equal(sheet.H3.v, 'CONFIRMAR');
  assert.equal(sheet.I3.v, '8');
  assert.equal(Object.values(sheet).some((cell) => cell?.v === 'Atualização'), false);
});

test('salva listas comerciais com a data no nome do arquivo', () => {
  const date = new Date(2026, 10, 18, 23, 45);
  assert.equal(exportFileName(payload, 'xlsx', date), 'lista-pr-sc-18-11-2026.xlsx');
  assert.equal(exportFileName(payload, 'pdf', date), 'lista-pr-sc-18-11-2026.pdf');
  assert.equal(exportFileName({ ...payload, title: 'Lista comercial - Faróis + Leve + Marca A + disponíveis' }, 'xlsx', date), 'lista-pr-sc-18-11-2026.xlsx');
  assert.equal(exportFileName({ title: 'Pedido' }, 'pdf', date), 'pedido.pdf');
});

test('lista comercial exibe +50 quando o estoque atualizado atinge o limite', () => {
  const item = { ...payload.items[0], stock_pr: 50, stock_sp: 49, stock_origin: 50 };
  const [row] = commercialRows([item]);
  assert.equal(row.Estoque, 'DISPONÍVEL');
  assert.equal(row.Quantidade, '+50');

  const workbook = buildExcelWorkbook({ ...payload, items: [item] });
  const sheet = workbook.Sheets['LISTA PR-SC'];
  assert.equal(sheet.H3.v, 'DISPONÍVEL');
  assert.equal(sheet.I3.v, '+50');
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
      validation_category: 'Amortecedor', category: 'Amortecedor', code: 'ABC-1', description: 'Produto', price: 110,
      stock_pr: 8, stock_sp: 3
    }],
    context: { destinationState: 'PR', originCode: 'PR', tableCode: 'PR-PR', samplePerCategory: 5 }
  });
  const sheet = workbook.Sheets['Conferência SAP'];
  const summary = workbook.Sheets.Resumo;

  assert.deepEqual(['A7', 'B7', 'E7', 'F7', 'O7', 'P7'].map((cell) => sheet[cell].v), [
    'Categoria', 'Código', 'Preço portal', 'Preço SAP', 'Status', 'Observações'
  ]);
  assert.equal(sheet.A8.v, 'Amortecedor');
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
  assert.match(sheet.A2.v, /5 itens por categoria/);
  assert.equal(summary.A16.v, 'Categoria');
  assert.equal(summary.A17.v, 'Amortecedor');
  assert.match(summary.B8.f, /COUNTIF/);
  assert.match(summary.C17.f, /COUNTIFS/);
  assert.deepEqual(workbook.SheetNames, ['Resumo', 'Conferência SAP']);
  assert.equal(workbook.Props.Company, 'DebaPortal');
});

test('cotação de validação leva códigos e quantidade um para lançamento no SAP', () => {
  const workbook = buildSapValidationQuoteWorkbook({
    items: [{ code: 'ABC-1', description: 'Produto A' }, { code: 'ABC-2', description: 'Produto B' }],
    context: { requestId: 'VAL-20261116-001', destinationState: 'PR', originCode: 'PR', tableCode: 'PR-PR' }
  });
  const sheet = workbook.Sheets['Cotação para SAP'];
  assert.deepEqual(['A5', 'B5', 'C5'].map((cell) => sheet[cell].v), ['Código', 'Descrição', 'Quantidade']);
  assert.deepEqual(['A6', 'B6', 'C6'].map((cell) => sheet[cell].v), ['ABC-1', 'Produto A', 1]);
  assert.equal(workbook.Props.Company, 'DebaPortal');
});
