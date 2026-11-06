const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 20_000;

export function normalizeHeader(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

export function inferImportKind(headers) {
  const keys = headers.map(normalizeHeader);
  const hasDescription = keys.some((key) => /descricao|description/.test(key));
  const hasPrice = keys.some((key) => /preco|price|valor/.test(key));
  const hasStock = keys.some((key) => /estoque|stock|quantidade|quantity|disp_/.test(key));
  if (hasDescription && (hasPrice || hasStock)) return 'complete';
  if (hasStock && !hasPrice) return 'stock';
  if (hasPrice && !hasDescription) return 'prices';
  return 'catalog';
}

function first(row, aliases) {
  for (const alias of aliases) {
    const value = row[alias];
    if (value !== null && value !== undefined && String(value).trim() !== '') return value;
  }
  return null;
}

function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value ?? '').trim().replace(/\s/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.').replace(/[^0-9.-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function splitValues(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return String(value || '').split(/[;|\n]+/).map((part) => part.trim()).filter(Boolean);
}

function canonicalizeRow(row) {
  const applicationValues = splitValues(first(row, ['applications', 'application', 'aplicacoes', 'aplicacao', 'veiculo', 'modelo']));
  return {
    _row: row._row,
    code: String(first(row, ['code', 'codigo', 'codigo_produto', 'sku', 'item']) || '').trim(),
    description: String(first(row, ['description', 'descricao', 'produto', 'nome']) || '').trim(),
    category: first(row, ['category', 'categoria', 'grupo']),
    product_line: first(row, ['product_line', 'linha', 'linha_produto']),
    synonyms: splitValues(first(row, ['synonyms', 'sinonimos', 'similares', 'similar', 'oem'])),
    applications: applicationValues.map((application) => ({ application })),
    price: numberValue(first(row, ['price', 'preco', 'valor', 'preco_unitario', 'pr_unit_c_i', 'pr_apos_desc'])),
    quantity: numberValue(first(row, ['quantity', 'quantidade', 'estoque', 'stock', 'qtde', 'disp_geral', 'disp_venda'])),
    price_table_code: first(row, ['price_table_code', 'codigo_tabela', 'tabela']),
    origin_code: String(first(row, ['origin_code', 'origem', 'filial', 'uf_origem']) || '').toUpperCase() || null
  };
}

export async function parseImportFile(file) {
  if (!file) throw new Error('Selecione um arquivo Excel ou CSV.');
  if (file.size > MAX_FILE_BYTES) throw new Error('O arquivo excede o limite de 20 MB.');
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error('Formato não suportado. Use XLSX, XLS ou CSV.');

  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('O arquivo não possui planilha legível.');
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
  if (!rawRows.length) throw new Error('A planilha está vazia.');
  if (rawRows.length > MAX_ROWS) throw new Error(`A planilha excede ${MAX_ROWS.toLocaleString('pt-BR')} linhas por importação.`);

  const headers = Object.keys(rawRows[0]);
  const rows = rawRows.map((row, index) => {
    const normalized = { _row: index + 2 };
    headers.forEach((header) => { normalized[normalizeHeader(header)] = row[header]; });
    return canonicalizeRow(normalized);
  });

  return { sheetName: workbook.SheetNames[0], headers, rows, inferredKind: inferImportKind(headers) };
}
