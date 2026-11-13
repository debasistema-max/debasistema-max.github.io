import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleProductsByCategory } from '../src/lib/sap-validation.js';

function products(category, count, prefix) {
  return Array.from({ length: count }, (_, index) => ({
    code: `${prefix}-${index + 1}`,
    description: `Produto ${index + 1}`,
    category
  }));
}

test('sorteia no máximo cinco produtos de cada categoria', () => {
  const items = [
    ...products('Amortecedor', 8, 'A'),
    ...products('Caixa de direção', 7, 'C'),
    ...products('Farol', 3, 'F')
  ];
  const sample = sampleProductsByCategory(items, 5, () => 0.25);
  const counts = sample.reduce((groups, item) => {
    groups[item.validation_category] ||= [];
    groups[item.validation_category].push(item);
    return groups;
  }, {});

  assert.equal(counts.Amortecedor.length, 5);
  assert.equal(counts['Caixa de direção'].length, 5);
  assert.equal(counts.Farol.length, 3);
  assert.equal(new Set(sample.map((item) => item.code)).size, sample.length);
});

test('mantém produtos sem classificação no grupo Sem categoria e ignora item sem código', () => {
  const sample = sampleProductsByCategory([
    { code: 'A-1', category: '' },
    { code: 'A-2', category: null },
    { code: '', category: 'Amortecedor' }
  ], 5, () => 0.5);

  assert.deepEqual(sample.map((item) => item.validation_category), ['Sem categoria', 'Sem categoria']);
});

test('aplica a quantidade configurada em todas as categorias', () => {
  const items = [
    ...products('Amortecedor', 8, 'A'),
    ...products('Bomba', 8, 'B'),
    ...products('Farol', 8, 'F')
  ];
  const sample = sampleProductsByCategory(items, 2, () => 0.25);
  const counts = sample.reduce((groups, item) => ({ ...groups, [item.validation_category]: (groups[item.validation_category] || 0) + 1 }), {});

  assert.deepEqual(counts, { Amortecedor: 2, Bomba: 2, Farol: 2 });
});
