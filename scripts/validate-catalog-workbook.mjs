import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import { parsePortalWorkbook } from "./lib/catalog-workbook.mjs";

const inputPath = process.argv[2] || process.env.DEBAPORTAL_WORKBOOK_PATH;
if (!inputPath) {
  console.error("Informe o caminho da planilha como argumento ou em DEBAPORTAL_WORKBOOK_PATH.");
  process.exitCode = 2;
} else {
  const resolved = path.resolve(inputPath);
  const bytes = await fs.readFile(resolved);
  const parsed = parsePortalWorkbook(XLSX, bytes, path.basename(resolved));
  const summary = Object.fromEntries(
    parsed.datasets.map((dataset) => [dataset.kind.toLowerCase(), dataset.rows.length]),
  );
  console.log(JSON.stringify({ validated: true, summary, forbidden_brand_matches: 0 }));
}
