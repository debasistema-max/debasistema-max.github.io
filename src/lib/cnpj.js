import { onlyDigits } from './utils.js';

export function isValidCnpj(value) {
  const digits = onlyDigits(value);
  if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) return false;

  const calculate = (length) => {
    let factor = length - 7;
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * factor;
      factor -= 1;
      if (factor < 2) factor = 9;
    }
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };

  return calculate(12) === Number(digits[12]) && calculate(13) === Number(digits[13]);
}

export function formatCnpj(value) {
  const digits = onlyDigits(value).slice(0, 14);
  return digits
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2');
}

export async function lookupCnpj(value, { functionUrl, accessToken } = {}) {
  const cnpj = onlyDigits(value);
  if (!isValidCnpj(cnpj)) throw new Error('CNPJ inválido. Confira os 14 dígitos.');
  if (!functionUrl) throw new Error('A função segura de consulta de CNPJ não foi configurada.');

  const headers = { Accept: 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const response = await fetch(`${functionUrl}?cnpj=${encodeURIComponent(cnpj)}`, { headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Não foi possível consultar o CNPJ.');
  return {
    cnpj,
    legalName: payload.razao_social || payload.legalName || '',
    tradeName: payload.nome_fantasia || payload.tradeName || '',
    state: payload.uf || payload.state || '',
    city: payload.municipio || payload.city || ''
  };
}
