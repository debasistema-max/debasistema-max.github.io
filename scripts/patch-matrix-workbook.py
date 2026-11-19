import copy
import json
import re
import sys
import unicodedata
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.formula.translate import Translator
from openpyxl.utils.cell import get_column_letter, range_boundaries


CODE_HEADERS = {"codigo", "codigo_ips", "cod_ips", "code", "codigo_produto", "sku", "item"}
FIELDS = {
    "description": ("Descricao", {"descricao", "description", "produto", "nome"}),
    "category": ("Categoria", {"categoria", "category", "grupo"}),
    "product_line": ("Marca", {"marca", "brand", "fabricante"}),
    "commercial_line": ("Linha", {"linha", "commercial_line", "linha_produto", "segmento", "tipo", "tipo_veiculo", "linha_veiculo", "categoria_veiculo", "classificacao"}),
    "synonyms": ("Sinonimos", {"sinonimos", "synonyms", "similares", "similar", "oem"}),
    "application": ("Aplicacao", {"aplicacao", "applications", "application", "aplicacoes", "aplicacao_veiculo", "veiculo", "modelo"}),
    "year": ("Ano", {"ano", "year", "anos"}),
    "base_price": ("Preco base", {"preco_s_imp", "preco_sem_imposto", "preco_base", "valor_base", "base_price"}),
}


def normalize(value):
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(char for char in text if unicodedata.category(char) != "Mn").lower()
    return re.sub(r"^_|_$", "", re.sub(r"[^a-z0-9]+", "_", text))


def clean_code(value):
    return re.sub(r"\.0+$", "", str(value or "").strip())


def matrix_values(row):
    append = row.get("append_data") or {}
    result = {}
    for field in ("description", "category", "product_line", "commercial_line"):
        value = str(append.get(field) or "").strip()
        if value:
            result[field] = value
    if append.get("synonyms"):
        result["synonyms"] = "; ".join(append["synonyms"])
    if append.get("applicationValues"):
        result["application"] = "; ".join(append["applicationValues"])
    if any(str(value or "").strip() for value in append.get("yearValues") or []):
        result["year"] = "; ".join(append["yearValues"])

    for field in ("description", "category", "product_line", "commercial_line"):
        if field in row:
            result[field] = "" if row[field] is None else str(row[field])
    if "synonyms" in row:
        result["synonyms"] = "; ".join(row.get("synonyms") or [])
    if row.get("applicationProvided"):
        result["application"] = "" if row.get("applicationClear") else "; ".join(row.get("applicationValues") or [])
    if row.get("yearProvided"):
        result["year"] = "; ".join(row.get("yearValues") or [])
    if "base_price" in row:
        result["base_price"] = float(row["base_price"])
    return result


def copy_row_template(sheet, source_row, target_row, max_column):
    sheet.row_dimensions[target_row].height = sheet.row_dimensions[source_row].height
    for column in range(1, max_column + 1):
        source = sheet.cell(source_row, column)
        target = sheet.cell(target_row, column)
        if source.has_style:
            target._style = copy.copy(source._style)
        if source.number_format:
            target.number_format = source.number_format
        if source.hyperlink:
            target._hyperlink = copy.copy(source.hyperlink)
        if source.comment:
            target.comment = copy.copy(source.comment)
        if source.data_type == "f" and isinstance(source.value, str):
            try:
                target.value = Translator(source.value, origin=source.coordinate).translate_formula(target.coordinate)
            except Exception:
                target.value = source.value
        else:
            target.value = None


def extend_filters_and_tables(sheet, target_row):
    if sheet.auto_filter.ref:
        min_col, min_row, max_col, max_row = range_boundaries(sheet.auto_filter.ref)
        if target_row > max_row:
            sheet.auto_filter.ref = f"{get_column_letter(min_col)}{min_row}:{get_column_letter(max_col)}{target_row}"
    for table in sheet.tables.values():
        min_col, min_row, max_col, max_row = range_boundaries(table.ref)
        if target_row > max_row:
            table.ref = f"{get_column_letter(min_col)}{min_row}:{get_column_letter(max_col)}{target_row}"


def main():
    if len(sys.argv) != 4:
        raise RuntimeError("Uso: patch-matrix-workbook.py entrada.xlsx saida.xlsx alteracoes.json")
    input_path, output_path, payload_path = map(Path, sys.argv[1:])
    rows = json.loads(payload_path.read_text(encoding="utf-8"))
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("Atualizacao parcial vazia.")

    workbook = load_workbook(input_path, data_only=False, keep_links=True)
    if "MATRIZ" not in workbook.sheetnames:
        raise RuntimeError("Aba MATRIZ nao encontrada.")
    sheet = workbook["MATRIZ"]

    header_row = 0
    headers = []
    for row_number in range(1, min(sheet.max_row, 50) + 1):
        candidate = [normalize(sheet.cell(row_number, column).value) for column in range(1, sheet.max_column + 1)]
        if any(value in CODE_HEADERS for value in candidate):
            header_row = row_number
            headers = candidate
            break
    if not header_row:
        raise RuntimeError("Cabecalho da aba MATRIZ nao reconhecido.")

    code_column = next((index + 1 for index, header in enumerate(headers) if header in CODE_HEADERS), 0)
    field_columns = {
        field: next((index + 1 for index, header in enumerate(headers) if header in aliases), 0)
        for field, (_, aliases) in FIELDS.items()
    }
    wanted = {clean_code(row.get("code")) for row in rows}
    locations = {code: [] for code in wanted}
    last_data_row = 0
    for row_number in range(header_row + 1, sheet.max_row + 1):
        code = clean_code(sheet.cell(row_number, code_column).value)
        if not code:
            continue
        last_data_row = row_number
        if code in locations:
            locations[code].append(row_number)
    if not last_data_row:
        raise RuntimeError("A aba MATRIZ nao possui linha de item para copiar.")

    rows_added = 0
    cells_updated = 0
    for row in rows:
        code = clean_code(row.get("code"))
        values = matrix_values(row)
        target_rows = locations.get(code) or []
        if len(target_rows) > 1 and (row.get("applicationProvided") or row.get("yearProvided")):
            raise RuntimeError(f"O codigo {code} possui varias linhas na MATRIZ. Atualize aplicacao e ano pela planilha completa.")
        if not target_rows:
            if not str(values.get("description") or "").strip():
                raise RuntimeError(f"Codigo {code} sem descricao para inclusao na MATRIZ.")
            last_data_row += 1
            copy_row_template(sheet, last_data_row - 1, last_data_row, sheet.max_column)
            sheet.cell(last_data_row, code_column).value = code
            target_rows = [last_data_row]
            rows_added += 1
            extend_filters_and_tables(sheet, last_data_row)

        explicit_fields = set()
        for field in ("description", "category", "product_line", "commercial_line", "synonyms", "base_price"):
            if field in row:
                explicit_fields.add(field)
        if row.get("applicationProvided"):
            explicit_fields.add("application")
        if row.get("yearProvided"):
            explicit_fields.add("year")
        for field in explicit_fields:
            if not field_columns.get(field):
                raise RuntimeError(f"Coluna {FIELDS[field][0]} nao encontrada na aba MATRIZ.")

        for target_row in target_rows:
            for field, value in values.items():
                column = field_columns.get(field, 0)
                if column:
                    sheet.cell(target_row, column).value = value
                    cells_updated += 1

    if hasattr(workbook, "calculation"):
        workbook.calculation.fullCalcOnLoad = True
        workbook.calculation.forceFullCalc = True
    workbook.save(output_path)
    print(json.dumps({"rows_updated": len(rows), "rows_added": rows_added, "cells_updated": cells_updated}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
