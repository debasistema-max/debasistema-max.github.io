const ROUTES = ["PR-PR", "SP-SP", "PR-SC"];
const BRANCHES = ["PR", "SP"];
const FORBIDDEN_BRANDS = new RegExp(
  `\\b(?:${["I", "P", "S"].join("")}(?:\\s+do\\s+Brasil)?|${["Yoko", "mitsu"].join("")}|${["R", "T"].join("\\s*")}\\s*Group)\\b`,
  "gi",
);

function cleanText(value, max = 2_000) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

export function publicText(value, max = 2_000) {
  return cleanText(value, max)
    .replace(FORBIDDEN_BRANDS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function headerKey(value) {
  return publicText(value, 200)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function productCode(value) {
  const text = cleanText(value, 100);
  return text ? text.replace(/\.0+$/, "") : "";
}

export function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = cleanText(value, 80).replace(/\s/g, "");
  if (!text) return null;
  const normalized = text.includes(",") && text.includes(".")
    ? text.replace(/\./g, "").replace(",", ".")
    : text.replace(",", ".");
  const parsed = Number(normalized.replace(/[^0-9.+-]/g, "").replace(/\+$/, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function sheetMatrix(XLSX, bytes, sheetName, required = true) {
  const workbook = XLSX.read(bytes, {
    type: bytes instanceof ArrayBuffer ? "array" : "buffer",
    dense: true,
    cellDates: false,
    cellFormula: false,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    cellText: false,
    bookDeps: false,
    sheets: sheetName,
  });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    if (required) throw new Error(`Aba obrigatoria ausente: ${sheetName}.`);
    return null;
  }
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: true,
    blankrows: false,
  });
}

function findHeader(rows, required, sheetName) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 40); rowIndex += 1) {
    const keys = rows[rowIndex].map(headerKey);
    if (!required.every((name) => keys.includes(name))) continue;
    const columns = new Map();
    keys.forEach((name, index) => {
      if (name && !columns.has(name)) columns.set(name, index);
    });
    return { rowIndex, columns };
  }
  throw new Error(`${sheetName}: cabecalho obrigatorio nao encontrado (${required.join(", ")}).`);
}

function valueAt(row, columns, name) {
  const index = columns.get(name);
  return index === undefined ? "" : row[index];
}

function ensureProduct(store, code) {
  let product = store.get(code);
  if (!product) {
    product = {
      code,
      description: "",
      category: "",
      product_line: "",
      synonyms: new Set(),
      applications: new Map(),
    };
    store.set(code, product);
  }
  return product;
}

function addApplication(product, application, model = "") {
  const text = publicText(application);
  const modelText = publicText(model, 300);
  if (!text && !modelText) return;
  const label = [text, modelText].filter(Boolean).join(" · ");
  product.applications.set(headerKey(label), {
    application: label,
    ...(modelText ? { model: modelText } : {}),
  });
}

function assertPublicFields(datasets) {
  const serialized = JSON.stringify(datasets);
  FORBIDDEN_BRANDS.lastIndex = 0;
  if (FORBIDDEN_BRANDS.test(serialized)) {
    throw new Error("A normalizacao manteve uma marca empresarial proibida.");
  }
}

export function parsePortalWorkbook(XLSX, bytes, name, maxRows = 50_000) {
  const products = new Map();
  const prices = [];
  const stock = [];

  {
    const matrix = sheetMatrix(XLSX, bytes, "MATRIZ");
    const matrixHeader = findHeader(matrix, ["codigo", "descricao", "preco s imp"], "MATRIZ");
    for (const row of matrix.slice(matrixHeader.rowIndex + 1)) {
      const code = productCode(valueAt(row, matrixHeader.columns, "codigo"));
      if (!code) continue;
      const product = ensureProduct(products, code);
      product.description ||= publicText(valueAt(row, matrixHeader.columns, "descricao"));
      product.product_line ||= publicText(valueAt(row, matrixHeader.columns, "marca"), 200);
      const application = publicText(valueAt(row, matrixHeader.columns, "aplicacao"));
      const year = publicText(valueAt(row, matrixHeader.columns, "ano"), 100);
      addApplication(product, [application, year].filter(Boolean).join(" "));
    }
  }

  {
    const sap = sheetMatrix(XLSX, bytes, "Cadastro Item SAP", false);
    if (sap) {
    const sapHeader = findHeader(sap, ["n do item", "descricao do item", "codigo ncm"], "Cadastro Item SAP");
    for (const row of sap.slice(sapHeader.rowIndex + 1)) {
      const code = productCode(valueAt(row, sapHeader.columns, "n do item"));
      if (!code) continue;
      const product = ensureProduct(products, code);
      product.description ||= publicText(valueAt(row, sapHeader.columns, "descricao do item"));
      product.category ||= publicText(valueAt(row, sapHeader.columns, "grupo de itens"), 200);
      product.product_line ||= publicText(valueAt(row, sapHeader.columns, "marca"), 200)
        || publicText(valueAt(row, sapHeader.columns, "fabricante"), 200);
      const model = publicText(valueAt(row, sapHeader.columns, "modelo"), 300);
      const year = publicText(valueAt(row, sapHeader.columns, "ano"), 100);
      addApplication(product, year, model);
      for (const synonymField of ["oem 01", "codigo de barras"]) {
        const synonym = publicText(valueAt(row, sapHeader.columns, synonymField), 300);
        if (synonym) product.synonyms.add(synonym);
      }
    }
    }
  }

  for (const route of ROUTES) {
    const sheetName = `LISTA ${route}`;
    const rows = sheetMatrix(XLSX, bytes, sheetName, false);
    if (!rows) continue;
    const header = findHeader(rows, ["codigo", "preco s imp", "preco c impostos"], sheetName);
    for (const row of rows.slice(header.rowIndex + 1)) {
      const code = productCode(valueAt(row, header.columns, "codigo"));
      if (!code) continue;
      const product = ensureProduct(products, code);
      product.description ||= publicText(valueAt(row, header.columns, "descricao"));
      const price = finiteNumber(valueAt(row, header.columns, "preco c impostos"));
      if (price !== null && price > 0) prices.push({ code, price, price_table_code: route });
    }
  }

  const validCodes = new Set(
    [...products.values()].filter((product) => product.description).map((product) => product.code),
  );
  for (const branch of BRANCHES) {
    const sheetName = `PORTAL ESTOQUE ${branch}`;
    const rows = sheetMatrix(XLSX, bytes, sheetName, false);
    if (!rows) continue;
    if (!rows.length) continue;
    const header = findHeader(rows, ["codigo", "estoque", "disp geral"], sheetName);
    for (const row of rows.slice(header.rowIndex + 1)) {
      const code = productCode(valueAt(row, header.columns, "codigo"));
      if (!code || !validCodes.has(code)) continue;
      const quantity = finiteNumber(valueAt(row, header.columns, "disp geral"));
      if (quantity !== null && quantity >= 0) stock.push({ code, quantity, origin_code: branch });
    }
  }

  const productRows = [...products.values()]
    .filter((product) => product.description)
    .map((product) => ({
      code: product.code,
      description: product.description,
      category: product.category,
      product_line: product.product_line,
      synonyms: [...product.synonyms],
      applications: [...product.applications.values()],
    }));
  const priceByProductAndTable = new Map();
  for (const row of prices.filter((candidate) => validCodes.has(String(candidate.code)))) {
    const key = `${row.price_table_code}|${row.code}`;
    const existing = priceByProductAndTable.get(key);
    if (existing && existing.price !== row.price) {
      throw new Error(`${name}: precos conflitantes para o mesmo produto e tabela.`);
    }
    priceByProductAndTable.set(key, row);
  }
  const filteredPrices = [...priceByProductAndTable.values()];
  const datasets = [
    { kind: "PRODUTOS", rows: productRows },
    { kind: "PRECOS", rows: filteredPrices },
    { kind: "ESTOQUE", rows: stock },
  ];

  for (const dataset of datasets) {
    if (!dataset.rows.length) throw new Error(`${name}: nenhuma linha valida para ${dataset.kind}.`);
    if (dataset.rows.length > maxRows) {
      throw new Error(`${name}: ${dataset.kind} excede o limite de ${maxRows} linhas.`);
    }
  }
  assertPublicFields(datasets);
  return { datasets };
}
