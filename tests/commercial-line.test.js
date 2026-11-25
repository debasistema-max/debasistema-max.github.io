import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCommercialLine, normalizeCommercialLine } from '../src/lib/commercial-line.js';

test('normaliza as três linhas comerciais', () => {
  assert.equal(normalizeCommercialLine('leves'), 'Leve');
  assert.equal(normalizeCommercialLine('PESADO'), 'Pesada');
  assert.equal(normalizeCommercialLine('utilitários'), 'Utilitário');
});

test('classifica produtos pela aplicação sem substituir uma linha informada', () => {
  assert.equal(classifyCommercialLine({ applications: ['ASTRA 93/95'] }), 'Leve');
  assert.equal(classifyCommercialLine({ applications: ['VOLVO FH 2018'] }), 'Pesada');
  assert.equal(classifyCommercialLine({ applications: ['HILUX / SW4'] }), 'Utilitário');
  assert.equal(classifyCommercialLine({ commercialLine: 'Caminhão' }), 'Pesada');
  assert.equal(classifyCommercialLine({ commercialLine: 'Pesada', applications: ['HILUX'] }), 'Pesada');
});
