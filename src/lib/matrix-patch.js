const CLEAR_MARKERS = new Set(['limpar', '[limpar]', '__clear__']);

const FIELD_DEFINITIONS = {
  description: { label: 'Descrição', aliases: ['description', 'descricao', 'produto', 'nome'] },
  category: { label: 'Categoria', aliases: ['category', 'categoria', 'grupo'] },
  product_line: { label: 'Marca', aliases: ['brand', 'marca', 'fabricante'] },
  commercial_line: {
    label: 'Linha',
    aliases: ['commercial_line', 'linha', 'linha_produto', 'segmento', 'tipo', 'tipo_veiculo', 'linha_veiculo', 'categoria_veiculo', 'classificacao']
  },
  synonyms: { label: 'Sinônimos', aliases: ['synonyms', 'sinonimos', 'similares', 'similar', 'oem'] },
  application: { label: 'Aplicação', aliases: ['applications', 'application', 'aplicacoes', 'aplicacao', 'aplicacao_veiculo', 'veiculo', 'modelo'] },
  year: { label: 'Ano', aliases: ['year', 'ano', 'anos'] },
  base_price: { label: 'Preço base', aliases: ['base_price', 'preco_base', 'preco_s_imp', 'preco_sem_imposto', 'prc_list_02', 'prc_lista_02'] }
};

const CODE_ALIASES = ['code', 'codigo', 'codigo_produto', 'sku', 'item'];

function normalizeHeader(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function normalizeCompare(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function isClearMarker(value) {
  return CLEAR_MARKERS.has(normalizeHeader(value));
}

function splitValues(value) {
  if (Array.isArray(value)) return value.map(normalizeCompare).filter(Boolean);
  return String(value ?? '').split(/[;|\n]+/).map(normalizeCompare).filter(Boolean);
}

function priceValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const text = String(value ?? '').trim().replace(/\s/g, '');
  if (!text) return null;
  const normalized = text.includes(',') && text.includes('.')
    ? text.replace(/\./g, '').replace(',', '.')
    : text.replace(',', '.');
  const parsed = Number(normalized.replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

export function parsePriceList02Matrix(matrix) {
  if (!Array.isArray(matrix)) return null;
  const rows = [];
  const seenCodes = new Set();
  let columns = null;
  let foundHeader = false;
  for (const rawRow of matrix) {
    const row = Array.isArray(rawRow) ? rawRow : [];
    const headers = row.map(normalizeHeader);
    const priceIndex = headers.findIndex((header) => [
      'prc_list_02', 'prc_lista_02', 'preco_lista_02', 'preco_list_02', 'lista_02', 'lista_2'
    ].includes(header));
    if (priceIndex >= 0) {
      foundHeader = true;
      const itemIndex = headers.findIndex((header) => header === 'item');
      let codeIndex = headers.findIndex((header) => /^(?:codigo|cod|codigo_item|cod_item|codigo_produto)$/.test(header));
      if (codeIndex < 0 && itemIndex > 0) codeIndex = itemIndex - 1;
      if (codeIndex < 0) codeIndex = itemIndex;
      if (codeIndex < 0) throw new Error('Não foi possível localizar a coluna de código antes de ITEM.');
      columns = { codeIndex, priceIndex, itemIndex };
      continue;
    }
    if (!columns) continue;
    if (columns.itemIndex >= 0 && columns.itemIndex !== columns.codeIndex
      && String(row[columns.itemIndex] ?? '').trim() === '') continue;
    const rawCode = row[columns.codeIndex];
    const rawPrice = row[columns.priceIndex];
    if (rawCode === null || rawCode === undefined || String(rawCode).trim() === '') continue;
    if (rawPrice === null || rawPrice === undefined || String(rawPrice).trim() === '') continue;
    const code = normalizeCompare(rawCode).replace(/\.0+$/, '');
    const basePrice = priceValue(rawPrice);
    if (!code || basePrice === null || basePrice <= 0) {
      throw new Error(`Preço da LISTA 02 inválido para o código ${code || 'não informado'}.`);
    }
    if (seenCodes.has(code)) throw new Error(`Código duplicado na LISTA 02: ${code}.`);
    seenCodes.add(code);
    rows.push({ code, base_price: basePrice });
  }
  if (!foundHeader) return null;
  if (!rows.length) throw new Error('Nenhum código com preço foi encontrado na PRC.LIST 02.');
  return { rows, fields: [{ key: 'base_price', label: 'Preço base (PRC.LIST 02)' }] };
}

export function parsePriceList02Clipboard(text) {
  const value = String(text || '').trim();
  if (!value) throw new Error('Cole os códigos e preços copiados do Excel.');
  if (value.length > 250_000) throw new Error('Os dados colados excedem o limite permitido.');
  const matrix = value.split(/\r?\n/).map((line) => line.split('\t'));
  const report = parsePriceList02Matrix(matrix);
  if (report) {
    if (report.rows.length > 200) throw new Error('A atualização parcial aceita até 200 itens por vez.');
    return report;
  }
  const rows = [];
  const seenCodes = new Set();
  for (const line of matrix) {
    if (line.length < 2) continue;
    const first = normalizeHeader(line[0]);
    const second = normalizeHeader(line[1]);
    if (/^(?:codigo|cod|item)$/.test(first) && /preco|price|prc|lista/.test(second)) continue;
    const code = normalizeCompare(line[0]).replace(/\.0+$/, '');
    const basePrice = priceValue(line[1]);
    if (!code && basePrice === null) continue;
    if (!code || basePrice === null || basePrice <= 0) throw new Error(`Código ou preço inválido na linha ${rows.length + 1}.`);
    if (seenCodes.has(code)) throw new Error(`Código duplicado nos dados colados: ${code}.`);
    seenCodes.add(code);
    rows.push({ code, base_price: basePrice });
  }
  if (!rows.length) throw new Error('Nenhum código com preço foi encontrado nos dados colados.');
  if (rows.length > 200) throw new Error('A atualização parcial aceita até 200 itens por vez.');
  return { rows, fields: [{ key: 'base_price', label: 'Preço base (PRC.LIST 02)' }] };
}

function commercialLineValue(value) {
  if (isClearMarker(value)) return null;
  const normalized = normalizeHeader(value);
  if (/^(?:u|utilitario|utilitarios)$|utilit/.test(normalized)) return 'Utilitário';
  if (/^(?:p|pesada|pesado|pesadas|pesados)$|pesad|caminh|onibus|truck/.test(normalized)) return 'Pesada';
  if (/^(?:l|leve|leves)$|leve|passeio/.test(normalized)) return 'Leve';
  throw new Error(`Linha comercial inválida: ${value}. Use Leve, Pesada ou Utilitário.`);
}

function sameText(left, right) {
  return normalizeCompare(left) === normalizeCompare(right);
}

function sameList(left, right) {
  const normalize = (values) => [...new Set((values || []).map((value) => normalizeCompare(value)).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function applicationLabel(values) {
  return (values || []).map((item) => [item.application, item.year].filter(Boolean).join(' | ')).join('; ');
}

function buildApplications(patch, current) {
  const existing = Array.isArray(current) ? current : [];
  if (!patch.applicationProvided && !patch.yearProvided) return existing;
  if (patch.applicationClear) return [];
  const applications = patch.applicationProvided ? patch.applicationValues : existing.map((item) => item.application);
  const years = patch.yearProvided ? patch.yearValues : [];
  if (!applications.length) throw new Error(`Informe a aplicação para atualizar o ano do código ${patch.code}.`);
  if (patch.yearProvided && years.length > 1 && years.length !== applications.length) {
    throw new Error(`O código ${patch.code} possui quantidades diferentes de aplicações e anos.`);
  }
  if (patch.yearProvided && years.length === 1 && applications.length > 1) {
    throw new Error(`O código ${patch.code} possui várias aplicações. Separe um ano para cada aplicação usando ponto e vírgula.`);
  }
  return applications.map((application, index) => {
    const matching = existing.find((item) => sameText(item.application, application));
    const year = patch.yearProvided ? (years[index] || '') : (matching?.year || '');
    return { application, ...(year ? { year } : {}) };
  });
}

export function parseMatrixPatchRecords(rawRows) {
  if (!Array.isArray(rawRows) || !rawRows.length) throw new Error('A planilha está vazia.');
  const normalizedRows = rawRows.map((raw) => Object.fromEntries(Object.entries(raw).map(([key, value]) => [normalizeHeader(key), value])));
  const headers = Object.keys(normalizedRows[0]);
  const codeHeader = CODE_ALIASES.find((alias) => headers.includes(alias));
  if (!codeHeader) throw new Error('A atualização parcial precisa conter a coluna Código.');
  const fieldHeaders = Object.fromEntries(Object.entries(FIELD_DEFINITIONS).map(([field, definition]) => [
    field,
    definition.aliases.find((alias) => headers.includes(alias)) || null
  ]));
  const fields = Object.entries(fieldHeaders).filter(([, header]) => header).map(([field]) => ({ key: field, label: FIELD_DEFINITIONS[field].label }));
  if (!fields.length) throw new Error('Inclua ao menos uma coluna para atualizar: Descrição, Aplicação, Ano, Categoria, Linha, Marca, Sinônimos ou Preço base.');

  const seenCodes = new Set();
  const rows = normalizedRows.map((row, index) => {
    const code = normalizeCompare(row[codeHeader]).replace(/\.0+$/, '');
    if (!code) throw new Error(`Código vazio na linha ${index + 2}.`);
    if (seenCodes.has(code)) throw new Error(`Código duplicado na planilha: ${code}.`);
    seenCodes.add(code);
    const patch = { code };
    for (const [field, header] of Object.entries(fieldHeaders)) {
      if (!header) continue;
      const value = row[header];
      if (value === null || value === undefined || normalizeCompare(value) === '') continue;
      if (field === 'application') {
        patch.applicationProvided = true;
        patch.applicationClear = isClearMarker(value);
        patch.applicationValues = patch.applicationClear ? [] : splitValues(value);
      } else if (field === 'year') {
        patch.yearProvided = true;
        patch.yearValues = isClearMarker(value) ? [] : splitValues(value);
      } else if (field === 'synonyms') {
        patch.synonyms = isClearMarker(value) ? [] : splitValues(value);
      } else if (field === 'commercial_line') {
        patch.commercial_line = commercialLineValue(value);
      } else if (field === 'base_price') {
        const parsedPrice = priceValue(value);
        if (parsedPrice === null || parsedPrice <= 0) throw new Error(`Preço base inválido para o código ${code}.`);
        patch.base_price = parsedPrice;
      } else {
        if (field === 'description' && isClearMarker(value)) throw new Error(`A descrição do código ${code} não pode ser apagada.`);
        patch[field] = isClearMarker(value) ? null : normalizeCompare(value);
      }
    }
    return patch;
  });
  return { rows, fields };
}

export function prepareMatrixPatch(patches, currentProducts) {
  const currentByCode = new Map((currentProducts || []).map((product) => [normalizeCompare(product.code), product]));
  const missingCodes = [];
  const mergedRows = [];
  const changes = [];
  let unchanged = 0;
  let hasBasePrice = false;
  for (const patch of patches || []) {
    const current = currentByCode.get(normalizeCompare(patch.code));
    if (!current) { missingCodes.push(patch.code); continue; }
    const merged = {
      code: current.code,
      description: current.description || '',
      category: current.category || null,
      product_line: current.product_line || null,
      commercial_line: current.commercial_line || null,
      synonyms: Array.isArray(current.synonyms) ? current.synonyms : [],
      applications: Array.isArray(current.applications) ? current.applications : []
    };
    let productChanged = false;
    for (const field of ['description', 'category', 'product_line', 'commercial_line', 'synonyms']) {
      if (!Object.hasOwn(patch, field)) continue;
      const before = merged[field];
      const after = patch[field];
      const equal = field === 'synonyms' ? sameList(before, after) : sameText(before, after);
      if (!equal) {
        changes.push({ code: current.code, field: FIELD_DEFINITIONS[field].label, before: field === 'synonyms' ? (before || []).join('; ') : before, after: field === 'synonyms' ? (after || []).join('; ') : after });
        productChanged = true;
      }
      merged[field] = after;
    }
    if (patch.applicationProvided || patch.yearProvided) {
      const applications = buildApplications(patch, merged.applications);
      if (!sameText(applicationLabel(merged.applications), applicationLabel(applications))) {
        changes.push({ code: current.code, field: 'Aplicação / Ano', before: applicationLabel(merged.applications), after: applicationLabel(applications) });
        productChanged = true;
      }
      merged.applications = applications;
    }
    if (Object.hasOwn(patch, 'base_price')) {
      merged.base_price = patch.base_price;
      changes.push({ code: current.code, field: 'Preço base', before: '—', after: patch.base_price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) });
      hasBasePrice = true;
      productChanged = true;
    }
    if (productChanged) mergedRows.push(merged);
    else unchanged += 1;
  }
  return { mergedRows, changes, missingCodes, unchanged, hasBasePrice };
}
