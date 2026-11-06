import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatCnpj, isValidCnpj } from '../src/lib/cnpj.js';

describe('CNPJ', () => {
  it('valida dígitos verificadores sem consultar a internet', () => {
    assert.equal(isValidCnpj('11.222.333/0001-81'), true);
    assert.equal(isValidCnpj('11.222.333/0001-82'), false);
    assert.equal(isValidCnpj('00.000.000/0000-00'), false);
  });

  it('formata apenas os 14 dígitos', () => {
    assert.equal(formatCnpj('11222333000181'), '11.222.333/0001-81');
  });
});
