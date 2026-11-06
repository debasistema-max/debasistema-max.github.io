import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { integer, safeFileName, stockLevel } from '../src/lib/utils.js';

describe('regras de apresentação', () => {
  it('aplica exatamente as três faixas de estoque', () => {
    assert.equal(stockLevel(51).key, 'high');
    assert.equal(stockLevel(50).key, 'low');
    assert.equal(stockLevel(1).key, 'low');
    assert.equal(stockLevel(0).key, 'none');
  assert.equal(stockLevel(null).key, 'unknown');
  assert.equal(integer(null), '—');
  });

  it('gera nome de arquivo neutro', () => {
    assert.equal(safeFileName('Lista Comercial SP'), 'lista-comercial-sp');
  });
});
