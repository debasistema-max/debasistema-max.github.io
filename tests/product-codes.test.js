import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProductCodes } from '../src/lib/product-codes.js';

test('lê códigos colados em linhas e remove repetições', () => {
  assert.deepEqual(parseProductCodes('Código IPS\n6111032201\n6111032202\n6111032201'), [
    '6111032201',
    '6111032202'
  ]);
});

test('usa somente a primeira coluna ao colar do Excel', () => {
  assert.deepEqual(parseProductCodes('Código\tDescrição\nDP-1001\tAmortecedor dianteiro\nDP-1002\tCaixa de direção'), [
    'DP-1001',
    'DP-1002'
  ]);
});

test('aceita códigos separados por vírgula, ponto e vírgula ou espaço', () => {
  assert.deepEqual(parseProductCodes('dp-1, DP-2; dp-3 DP-1'), ['DP-1', 'DP-2', 'DP-3']);
});

test('rejeita conteúdo inválido e mais códigos que o limite', () => {
  assert.throws(() => parseProductCodes('DP-1\nCÓDIGO INVÁLIDO'), /Código inválido/);
  assert.throws(() => parseProductCodes('DP-1\nDP-2', 1), /limite é de 1/);
  assert.throws(() => parseProductCodes('Código IPS'), /Cole ao menos um código/);
});
