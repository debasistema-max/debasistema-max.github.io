import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleProductsByLine } from '../src/lib/sap-validation.js';

function products(line, count, prefix) {
  return Array.from({ length: count }, (_, index) => ({
    code: `${prefix}-${index + 1}`,
    description: `Produto ${index + 1}`,
    product_line: line
  }));
}

test('sorteia no máximo cinco produtos de cada linha', () => {
  const items = [
    ...products('Leve', 8, 'L'),
    ...products('Pesada', 7, 'P'),
    ...products('Utilitário', 3, 'U')
  ];
  const sample = sampleProductsByLine(items, 5, () => 0.25);
  const counts = sample.reduce((groups, item) => {
    groups[item.validation_line] ||= [];
    groups[item.validation_line].push(item);
    return groups;
  }, {});

  assert.equal(counts.Leve.length, 5);
  assert.equal(counts.Pesada.length, 5);
  assert.equal(counts.Utilitário.length, 3);
  assert.equal(new Set(sample.map((item) => item.code)).size, sample.length);
});

test('mantém produtos sem classificação no grupo Sem linha e ignora item sem código', () => {
  const sample = sampleProductsByLine([
    { code: 'A-1', product_line: '' },
    { code: 'A-2', product_line: null },
    { code: '', product_line: 'Leve' }
  ], 5, () => 0.5);

  assert.deepEqual(sample.map((item) => item.validation_line), ['Sem linha', 'Sem linha']);
});

test('aceita uma quantidade diferente para cada linha comercial', () => {
  const items = [
    ...products('Leve', 8, 'L'),
    ...products('Pesada', 8, 'P'),
    ...products('Utilitário', 8, 'U'),
    ...products('Sem linha', 8, 'S')
  ];
  const sample = sampleProductsByLine(items, { Leve: 2, Pesada: 4, Utilitario: 1 }, () => 0.25);
  const counts = sample.reduce((groups, item) => ({ ...groups, [item.validation_line]: (groups[item.validation_line] || 0) + 1 }), {});

  assert.deepEqual(counts, { Leve: 2, Pesada: 4, Utilitário: 1 });
});
