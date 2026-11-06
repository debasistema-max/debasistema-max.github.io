import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inferImportKind, normalizeHeader } from '../src/lib/importer.js';

describe('importação', () => {
  it('normaliza cabeçalhos com acentos e pontuação', () => {
    assert.equal(normalizeHeader('Preço Unitário (c/ I.)'), 'preco_unitario_c_i');
    assert.equal(normalizeHeader('Aplicação / Veículo'), 'aplicacao_veiculo');
  });

  it('detecta os tipos principais de lote', () => {
    assert.equal(inferImportKind(['Código', 'Estoque']), 'stock');
    assert.equal(inferImportKind(['Código', 'Preço']), 'prices');
    assert.equal(inferImportKind(['Código', 'Descrição', 'Aplicação']), 'catalog');
    assert.equal(inferImportKind(['Código', 'Descrição', 'Preço', 'Estoque']), 'complete');
  });
});
