import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSapClipboard, parseSapPdfPages, sapNumber, validateSapQuote } from '../src/lib/sap-quote-validation.js';

test('interpreta números brasileiros da cotação SAP', () => {
  assert.equal(sapNumber('1.143,43'), 1143.43);
  assert.equal(sapNumber('836,9000'), 836.9);
  assert.equal(sapNumber('R$ 2.791,30'), 2791.3);
});

test('lê a tabela copiada do Excel com estoque e preço final', () => {
  const pasted = [
    '#\tCód.\tDescrição\tDisp. Geral\tDisp. Venda\tQtd. Auth. Pend.\tUM\tQtde\tPr.Unit.\t% do desc.\tPr.Após Desc.\tTotal Após Desc.\tICMS-ST\tIPI\tDesonerado\tTotal c/Imp.\tPr.Unit.(c/i)',
    '1\t7146666001\tCAIXA DIR.HID.\t7\t7\t0\tUN\t1\t836,9\t0\t836,9\t836,9\t279,33\t27,2\t0\t1.143,43\t1.143,43'
  ].join('\n');
  const result = parseSapClipboard(pasted);
  assert.deepEqual(result.items[0], {
    code: '7146666001', description: 'CAIXA DIR.HID.', quantity: 1, stock: 7,
    unitPriceBase: 836.9, unitPriceFinal: 1143.43, source: 'EXCEL'
  });
});

test('lê as colunas posicionais do PDF de cotação SAP', () => {
  const item = (x, y, str) => ({ str, transform: [1, 0, 0, 1, x, y] });
  const page = [
    item(15, 770, 'Orçamento'), item(79, 770, '5456'),
    item(53, 672, 'Código'), item(223, 672, 'Descrição'), item(381, 672, 'UM'), item(408, 672, 'Qtd'), item(447, 672, 'Pr.Unit(s/i)'), item(521, 672, 'Pr.Unit.(c/i)'),
    item(18, 657, '1'), item(45, 657, '7146666001'), item(107, 657, 'CAIXA DIR.HID.'), item(407, 657, '1,00'), item(451, 657, '836,9000'), item(527, 657, '1.143,43')
  ];
  const result = parseSapPdfPages([page]);
  assert.equal(result.quoteNumber, '5456');
  assert.equal(result.items[0].code, '7146666001');
  assert.equal(result.items[0].quantity, 1);
  assert.equal(result.items[0].unitPriceFinal, 1143.43);
});

test('autovalida preço, quantidade, estoque e itens ausentes ou extras', () => {
  const portal = [
    { code: 'A1', description: 'Produto A', price: 100, stock_origin: 50 },
    { code: 'B2', description: 'Produto B', price: 200, stock_origin: 7 },
    { code: 'C3', description: 'Produto C', price: 300, stock_origin: 0 }
  ];
  const result = validateSapQuote(portal, { source: 'EXCEL', items: [
    { code: 'A1', quantity: 1, unitPriceFinal: 100, stock: 401 },
    { code: 'B2', quantity: 1, unitPriceFinal: 210, stock: 6 },
    { code: 'X9', quantity: 1, unitPriceFinal: 10, stock: 1 }
  ] });
  assert.deepEqual(result.summary, { total: 4, ok: 1, divergent: 1, missing: 1, extra: 1 });
  assert.equal(result.rows.find((row) => row.code === 'A1').status, 'OK');
  assert.equal(result.rows.find((row) => row.code === 'B2').status, 'DIVERGENTE');
});
