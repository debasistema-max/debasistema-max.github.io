import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import { parsePortalWorkbook } from "./lib/catalog-workbook.mjs";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Configuracao ausente: ${name}.`);
  return value;
}

async function importDataset({ url, publishableKey, accessToken, sourceName, dataset }) {
  const response = await fetch(`${url}/rest/v1/rpc/import_catalog_batch`, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      import_kind: dataset.kind,
      source_name: sourceName,
      rows: dataset.rows,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${dataset.kind}: importacao recusada (${result.message || response.status}).`);
  }
  if (result?.ok === false) {
    throw new Error(`${dataset.kind}: ${result.error || "falha de validacao no banco"}.`);
  }
  return { kind: dataset.kind, rows: dataset.rows.length };
}

const inputPath = process.argv.find((argument) => !argument.startsWith("--") && argument !== process.argv[0] && argument !== process.argv[1])
  || process.env.DEBAPORTAL_WORKBOOK_PATH;
const shouldImport = process.argv.includes("--import");
const kindsArgument = process.argv.find((argument) => argument.startsWith("--kinds="));
const selectedKinds = kindsArgument
  ? new Set(kindsArgument.slice("--kinds=".length).split(",").map((value) => value.trim().toUpperCase()).filter(Boolean))
  : null;

if (!inputPath) {
  console.error("Informe o caminho da planilha como argumento ou em DEBAPORTAL_WORKBOOK_PATH.");
  process.exitCode = 2;
} else {
  const resolved = path.resolve(inputPath);
  const [bytes, stat] = await Promise.all([fs.readFile(resolved), fs.stat(resolved)]);
  const parsed = parsePortalWorkbook(XLSX, bytes, path.basename(resolved));
  const summary = Object.fromEntries(
    parsed.datasets.map((dataset) => [dataset.kind.toLowerCase(), dataset.rows.length]),
  );

  if (!shouldImport) {
    console.log(JSON.stringify({ validated: true, summary, imported: false }));
  } else {
    const url = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || serviceRoleKey;
    const accessToken = process.env.SUPABASE_ACCESS_TOKEN?.trim() || serviceRoleKey;
    if (!publishableKey || !accessToken) {
      throw new Error("Informe a sessao administrativa ou a chave segura do executor.");
    }
    const sourceName = `onedrive:authorized-workbook:${stat.mtime.toISOString()}`;
    const results = [];
    for (const dataset of parsed.datasets.filter((candidate) => !selectedKinds || selectedKinds.has(candidate.kind))) {
      results.push(await importDataset({ url, publishableKey, accessToken, sourceName, dataset }));
    }
    console.log(JSON.stringify({ validated: true, imported: true, summary, results }));
  }
}
