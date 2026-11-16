function normalizedText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizedCode(value) {
  return String(value ?? '').trim().replace(/\.0+$/, '').replace(/\s+/g, '');
}

export function sapNumber(value) {
  const text = String(value ?? '').replace(/R\$/gi, '').replace(/\s+/g, '').trim();
  if (!text) return null;
  const normalized = text.includes(',')
    ? text.replace(/\./g, '').replace(',', '.')
    : text;
  const number = Number(normalized.replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function findHeaderIndex(headers, predicate) {
  return headers.findIndex((header) => predicate(normalizedText(header)));
}

export function parseSapClipboard(text) {
  const rows = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.split('\t').map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean));
  const headerIndex = rows.findIndex((row) => row.some((cell) => /^(cod|codigo)$/.test(normalizedText(cell)))
    && row.some((cell) => /pr unit|preco unit|total c imp/.test(normalizedText(cell))));
  if (headerIndex < 0) throw new Error('Cabeçalho do Excel não reconhecido. Copie também a linha com Cód., Qtde e Pr.Unit.(c/i).');

  const headers = rows[headerIndex];
  const codeIndex = findHeaderIndex(headers, (header) => /^(cod|codigo)$/.test(header));
  const descriptionIndex = findHeaderIndex(headers, (header) => header === 'descricao');
  const quantityIndex = findHeaderIndex(headers, (header) => /^(qtd|qtde|quantidade)$/.test(header));
  const stockSaleIndex = findHeaderIndex(headers, (header) => header.includes('disp venda'));
  const stockGeneralIndex = findHeaderIndex(headers, (header) => header.includes('disp geral'));
  const finalPriceIndex = findHeaderIndex(headers, (header) => (header.includes('pr unit') || header.includes('preco unit')) && header.includes('c i'));
  const totalWithTaxIndex = findHeaderIndex(headers, (header) => header.includes('total c imp'));
  const basePriceIndex = findHeaderIndex(headers, (header) => header.includes('pr apos desc')
    || ((header.includes('pr unit') || header.includes('preco unit')) && !header.includes('c i')));
  if (codeIndex < 0 || quantityIndex < 0 || (finalPriceIndex < 0 && totalWithTaxIndex < 0)) {
    throw new Error('A colagem precisa conter Código, Qtde e Pr.Unit.(c/i) ou Total c/Imp.');
  }

  const items = rows.slice(headerIndex + 1).map((row) => {
    const code = normalizedCode(row[codeIndex]);
    const quantity = sapNumber(row[quantityIndex]);
    const totalWithTax = totalWithTaxIndex >= 0 ? sapNumber(row[totalWithTaxIndex]) : null;
    const unitPriceFinal = finalPriceIndex >= 0
      ? sapNumber(row[finalPriceIndex])
      : (quantity && totalWithTax !== null ? totalWithTax / quantity : null);
    return {
      code,
      description: descriptionIndex >= 0 ? row[descriptionIndex] || '' : '',
      quantity,
      stock: sapNumber(row[stockSaleIndex >= 0 ? stockSaleIndex : stockGeneralIndex]),
      unitPriceBase: basePriceIndex >= 0 ? sapNumber(row[basePriceIndex]) : null,
      unitPriceFinal,
      source: 'EXCEL'
    };
  }).filter((item) => item.code && item.quantity !== null);
  if (!items.length) throw new Error('Nenhum item válido foi encontrado na colagem do Excel.');
  return { quoteNumber: '', items, source: 'EXCEL' };
}

function groupPdfRows(items) {
  const rows = [];
  for (const item of items || []) {
    const text = String(item?.str || '').trim();
    if (!text || !Array.isArray(item.transform)) continue;
    const x = Number(item.transform[4]);
    const y = Number(item.transform[5]);
    let row = rows.find((candidate) => Math.abs(candidate.y - y) < 2);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push({ x, text });
  }
  return rows
    .map((row) => ({ ...row, items: row.items.sort((left, right) => left.x - right.x) }))
    .sort((left, right) => right.y - left.y);
}

export function parseSapPdfPages(pages) {
  const parsedItems = [];
  let quoteNumber = '';
  for (const pageItems of pages || []) {
    const rows = groupPdfRows(pageItems);
    for (const row of rows) {
      const rowText = row.items.map((item) => item.text).join(' ');
      if (!quoteNumber && normalizedText(rowText).includes('orcamento')) {
        quoteNumber = row.items.map((item) => item.text).find((text) => /^\d{2,}$/.test(text)) || '';
      }
    }
    const header = rows.find((row) => {
      const text = normalizedText(row.items.map((item) => item.text).join(' '));
      return text.includes('codigo') && text.includes('qtd') && text.includes('pr unit') && text.includes('c i');
    });
    if (!header) continue;
    const headerPosition = (pattern) => header.items.find((item) => pattern.test(normalizedText(item.text)))?.x ?? null;
    const codeX = headerPosition(/^codigo$/);
    const quantityX = headerPosition(/^qtd/);
    const basePriceX = headerPosition(/pr unit s i/);
    const finalPriceX = headerPosition(/pr unit c i/);
    if ([codeX, quantityX, basePriceX, finalPriceX].some((value) => value === null)) continue;

    for (const row of rows.filter((candidate) => candidate.y < header.y)) {
      const codeItem = row.items.find((item) => item.x >= codeX - 20 && item.x < quantityX - 30 && /^\d{6,}$/.test(normalizedCode(item.text)));
      if (!codeItem) continue;
      const quantityItem = row.items.find((item) => item.x >= quantityX - 18 && item.x < basePriceX - 8);
      const basePriceItem = row.items.find((item) => item.x >= basePriceX - 12 && item.x < finalPriceX - 8);
      const finalPriceItem = row.items.find((item) => item.x >= finalPriceX - 15);
      const description = row.items
        .filter((item) => item.x > codeItem.x && item.x < quantityX - 25 && !/^(un|pc|pç)$/i.test(item.text))
        .map((item) => item.text).join(' ');
      const quantity = sapNumber(quantityItem?.text);
      const unitPriceFinal = sapNumber(finalPriceItem?.text);
      if (quantity === null || unitPriceFinal === null) continue;
      parsedItems.push({
        code: normalizedCode(codeItem.text),
        description,
        quantity,
        stock: null,
        unitPriceBase: sapNumber(basePriceItem?.text),
        unitPriceFinal,
        source: 'PDF'
      });
    }
  }
  if (!parsedItems.length) throw new Error('Nenhum item foi reconhecido no PDF da cotação SAP.');
  return { quoteNumber, items: parsedItems, source: 'PDF' };
}

function sameStock(portalStock, sapStock) {
  if (portalStock === null || portalStock === undefined || sapStock === null || sapStock === undefined) return null;
  const portal = Number(portalStock);
  const sap = Number(sapStock);
  if (!Number.isFinite(portal) || !Number.isFinite(sap)) return null;
  return portal >= 50 && sap >= 50 ? true : portal === sap;
}

export function validateSapQuote(portalItems, sapQuote, { expectedQuantity = 1 } = {}) {
  const sapByCode = new Map();
  const duplicateCodes = new Set();
  for (const item of sapQuote?.items || []) {
    const code = normalizedCode(item.code);
    if (sapByCode.has(code)) duplicateCodes.add(code);
    else sapByCode.set(code, item);
  }
  const portalCodes = new Set((portalItems || []).map((item) => normalizedCode(item.code)));
  const rows = (portalItems || []).map((portal) => {
    const code = normalizedCode(portal.code);
    const sap = sapByCode.get(code);
    if (!sap) return { code, description: portal.description || '', status: 'AUSENTE', issues: ['Item não encontrado na cotação SAP'], portal, sap: null };
    const issues = [];
    const portalPrice = Number(portal.price);
    const sapPrice = Number(sap.unitPriceFinal);
    if (Number(sap.quantity) !== expectedQuantity) issues.push(`Quantidade SAP ${sap.quantity} (esperado ${expectedQuantity})`);
    if (!Number.isFinite(portalPrice)) issues.push('Preço do portal indisponível');
    else if (!Number.isFinite(sapPrice)) issues.push('Preço final do SAP indisponível');
    else if (Math.abs(sapPrice - portalPrice) > 0.011) issues.push(`Preço diferente em R$ ${(sapPrice - portalPrice).toFixed(2).replace('.', ',')}`);
    const stockMatches = sameStock(portal.stock_origin, sap.stock);
    if (stockMatches === false) issues.push(`Estoque SAP ${sap.stock} diferente do portal ${portal.stock_origin}`);
    if (duplicateCodes.has(code)) issues.push('Código duplicado na cotação SAP');
    return {
      code,
      description: portal.description || sap.description || '',
      status: issues.length ? 'DIVERGENTE' : 'OK',
      issues,
      portal,
      sap,
      priceDifference: Number.isFinite(portalPrice) && Number.isFinite(sapPrice) ? sapPrice - portalPrice : null,
      stockMatches
    };
  });
  for (const sap of sapQuote?.items || []) {
    const code = normalizedCode(sap.code);
    if (!portalCodes.has(code)) rows.push({ code, description: sap.description || '', status: 'EXTRA', issues: ['Item não solicitado pelo portal'], portal: null, sap });
  }
  return {
    quoteNumber: sapQuote?.quoteNumber || '',
    source: sapQuote?.source || '',
    rows,
    summary: {
      total: rows.length,
      ok: rows.filter((row) => row.status === 'OK').length,
      divergent: rows.filter((row) => row.status === 'DIVERGENTE').length,
      missing: rows.filter((row) => row.status === 'AUSENTE').length,
      extra: rows.filter((row) => row.status === 'EXTRA').length
    }
  };
}
