import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MULTI_FILTER_SEPARATOR,
  encodeFilterSelection,
  matchesFilterSelection,
  normalizeFilterSelection,
  toggleFilterSelection
} from '../src/lib/catalog-filters.js';

test('normaliza e codifica várias opções sem duplicar valores', () => {
  assert.deepEqual(normalizeFilterSelection([' Suspensão ', 'Direção', 'Suspensão', '']), ['Suspensão', 'Direção']);
  assert.equal(encodeFilterSelection(['Suspensão', 'Direção']), `Suspensão${MULTI_FILTER_SEPARATOR}Direção`);
  assert.equal(encodeFilterSelection([]), null);
});

test('adiciona e remove opções mantendo os demais filtros', () => {
  const selected = toggleFilterSelection(['Leve'], 'Pesada', true);
  assert.deepEqual(selected, ['Leve', 'Pesada']);
  assert.deepEqual(toggleFilterSelection(selected, 'Leve', false), ['Pesada']);
});

test('combina opções com lógica OU dentro do mesmo filtro', () => {
  assert.equal(matchesFilterSelection('Direção', ['Suspensão', 'Direção']), true);
  assert.equal(matchesFilterSelection('Freios', ['Suspensão', 'Direção']), false);
  assert.equal(matchesFilterSelection('Freios', []), true);
});
