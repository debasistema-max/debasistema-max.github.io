import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowedOrigins, choosePriceTable, resolveCommercialContext, tableSupportsContext } from '../src/lib/commercial-context.js';

const tables = [
  { id: 'pr-pr', destination_state: 'PR', origin_code: 'PR', version: 1 },
  { id: 'sp-sp', destination_state: 'SP', origin_code: 'SP', version: 1 },
  { id: 'pr-sc', destination_state: 'SC', origin_code: 'PR', version: 1 }
];

describe('contexto comercial', () => {
  it('limita a filial às rotas com preço para o destino', () => {
    assert.deepEqual(allowedOrigins(tables, 'SC'), ['PR']);
    assert.deepEqual(allowedOrigins(tables, 'SP'), ['SP']);
  });

  it('corrige a filial incompatível e seleciona a tabela válida', () => {
    assert.deepEqual(resolveCommercialContext(tables, {
      destinationState: 'SC', originCode: 'SP', priceTableId: 'sp-sp'
    }), { originCode: 'PR', priceTableId: 'pr-sc', origins: ['PR'] });
  });

  it('aceita tabelas genéricas e prefere a mais específica', () => {
    const generic = { id: 'geral', destination_state: null, origin_code: null, version: 2 };
    assert.equal(tableSupportsContext(generic, 'SP', 'PR'), true);
    assert.equal(choosePriceTable([generic, ...tables], 'SP', 'SP').id, 'sp-sp');
  });
});
