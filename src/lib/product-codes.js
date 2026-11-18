const HEADER_NAMES = new Set([
  'codigo',
  'codigoips',
  'cod',
  'codips',
  'item',
  'sku'
]);

function normalizedHeader(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9]/g, '');
}

function cleanCell(value) {
  return String(value || '').trim().replace(/^["']+|["']+$/g, '').trim();
}

export function parseProductCodes(value, limit = 500) {
  const codes = [];
  const seen = new Set();

  for (const rawLine of String(value || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || HEADER_NAMES.has(normalizedHeader(line))) continue;

    // Ao copiar mais de uma coluna do Excel, somente a primeira é o código.
    const cells = line.includes('\t')
      ? [line.split('\t', 1)[0]]
      : line.split(/[;,\s]+/);

    for (const rawCell of cells) {
      const cell = cleanCell(rawCell);
      if (!cell || HEADER_NAMES.has(normalizedHeader(cell))) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(cell)) {
        throw new Error(`Código inválido: ${cell}.`);
      }
      const key = cell.toLocaleUpperCase('pt-BR');
      if (seen.has(key)) continue;
      seen.add(key);
      codes.push(key);
      if (codes.length > limit) throw new Error(`O limite é de ${limit} códigos por operação.`);
    }
  }

  if (!codes.length) throw new Error('Cole ao menos um código.');
  return codes;
}
