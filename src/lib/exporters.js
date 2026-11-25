import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { classifyCommercialLine } from './commercial-line.js';
import { commercialApplicationValues, commercialYearValues, money, safeFileName, stockLevel, stockQuantity } from './utils.js';

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function localDateStamp(date = new Date()) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}-${month}-${date.getFullYear()}`;
}

export function exportFileName(payload, extension, date = new Date()) {
  const routeCode = payload.context?.routeCode
    || [payload.context?.originCode, payload.context?.destinationState].filter(Boolean).join('-');
  const shortListName = routeCode ? `lista-${routeCode}` : 'lista-comercial';
  const baseName = safeFileName(payload.variant === 'commercial-list' ? shortListName : payload.title).replace(/-+/g, '-');
  const datedName = payload.variant === 'commercial-list' ? `${baseName}-${localDateStamp(date)}` : baseName;
  return `${datedName}.${extension}`;
}

function itemValue(item, key, fallback = '') {
  return item.product?.[key] ?? item[key] ?? fallback;
}

export function rowsForExport(items) {
  return items.map((item) => ({
    Código: itemValue(item, 'code'),
    Descrição: itemValue(item, 'description'),
    Aplicação: itemValue(item, 'applications', []).join('; '),
    Quantidade: item.quantity ?? '',
    'Preço unitário': Number(itemValue(item, 'price', 0)),
    'Estoque PR': stockQuantity(itemValue(item, 'stock_pr', null)),
    'Estoque SP': stockQuantity(itemValue(item, 'stock_sp', null)),
    'Estoque origem': stockQuantity(itemValue(item, 'stock_origin', null)),
    Total: item.quantity == null ? '' : Number(item.quantity) * Number(itemValue(item, 'price', 0)),
    Atualização: itemValue(item, 'updated_at')
  }));
}

export function commercialRows(items, stockMode = 'ORIGIN') {
  const uniqueItems = new Map();
  for (const item of items) {
    const code = String(itemValue(item, 'code') || '').trim().toLocaleUpperCase('pt-BR');
    const key = code || String(itemValue(item, 'id') || uniqueItems.size);
    if (!uniqueItems.has(key)) uniqueItems.set(key, item);
  }
  return [...uniqueItems.values()].map((item) => {
    const stockOrigin = itemValue(item, 'stock_origin', null);
    const common = {
      'Código IPS': itemValue(item, 'code'),
      Descrição: itemValue(item, 'description'),
      Marca: itemValue(item, 'brand'),
      Linha: classifyCommercialLine({
        commercialLine: itemValue(item, 'product_line'),
        description: itemValue(item, 'description'),
        category: itemValue(item, 'category'),
        applications: itemValue(item, 'applications', []),
      }),
      Aplicação: commercialApplicationValues(itemValue(item, 'applications', [])).join('; '),
      Ano: commercialYearValues(itemValue(item, 'years', []), itemValue(item, 'applications', [])).join('; '),
      'Preço s/ impostos': itemValue(item, 'base_price', null),
      'Preço c/ impostos': itemValue(item, 'price', null)
    };
    if (stockMode === 'BOTH') {
      const stockPr = itemValue(item, 'stock_pr', null);
      const stockSp = itemValue(item, 'stock_sp', null);
      return {
        ...common,
        'Estoque PR': stockPr === null ? 'SEM DADOS' : stockLevel(stockPr).label.toLocaleUpperCase('pt-BR'),
        'Qtd. PR': stockQuantity(stockPr),
        'Estoque SP': stockSp === null ? 'SEM DADOS' : stockLevel(stockSp).label.toLocaleUpperCase('pt-BR'),
        'Qtd. SP': stockQuantity(stockSp)
      };
    }
    return {
      ...common,
      Estoque: stockOrigin === null ? 'SEM DADOS' : stockLevel(stockOrigin).label.toLocaleUpperCase('pt-BR'),
      Quantidade: stockQuantity(stockOrigin)
    };
  });
}

function styleCommercialSheet(sheet, rowCount, headers) {
  const headerStyle = {
    font: { bold: true, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '0B1F3A' } },
    alignment: { vertical: 'center' }
  };
  const titleStyle = {
    font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 18 },
    fill: { fgColor: { rgb: '0B1F3A' } },
    alignment: { vertical: 'center' }
  };
  if (sheet.A1) sheet.A1.s = titleStyle;
  headers.forEach((header, index) => {
    const column = XLSX.utils.encode_col(index);
    if (sheet[`${column}2`]) sheet[`${column}2`].s = headerStyle;
  });
  const currencyColumns = ['Preço s/ impostos', 'Preço c/ impostos'].map((header) => XLSX.utils.encode_col(headers.indexOf(header)));
  for (let row = 3; row <= rowCount + 2; row += 1) {
    for (const column of currencyColumns) if (sheet[`${column}${row}`]) sheet[`${column}${row}`].z = 'R$ #,##0.00';
  }
  sheet['!rows'] = [{ hpt: 28 }, { hpt: 24 }];
  const widths = { 'Código IPS': 17, Descrição: 38, Marca: 18, Linha: 14, Aplicação: 48, Ano: 18, 'Preço s/ impostos': 20, 'Preço c/ impostos': 20, Estoque: 18, Quantidade: 14, 'Estoque PR': 18, 'Qtd. PR': 12, 'Estoque SP': 18, 'Qtd. SP': 12 };
  sheet['!cols'] = headers.map((header) => ({ wch: widths[header] || 16 }));
  const lastColumn = XLSX.utils.encode_col(headers.length - 1);
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];
  sheet['!autofilter'] = { ref: `A2:${lastColumn}${Math.max(2, rowCount + 2)}` };
  sheet['!freeze'] = { xSplit: 0, ySplit: 2, topLeftCell: 'A3', activePane: 'bottomLeft', state: 'frozen' };
}

export function buildExcelWorkbook({ title, items, context = {}, variant = 'document' }) {
  const workbook = XLSX.utils.book_new();
  if (variant === 'commercial-list') {
    const stockMode = context.stockMode === 'BOTH' ? 'BOTH' : 'ORIGIN';
    const rows = commercialRows(items, stockMode);
    const routeCode = context.routeCode || `${context.originCode || '—'}-${context.destinationState || '—'}`;
    const headers = ['Código IPS', 'Descrição', 'Marca', 'Linha', 'Aplicação', 'Ano', 'Preço s/ impostos', 'Preço c/ impostos', ...(stockMode === 'BOTH' ? ['Estoque PR', 'Qtd. PR', 'Estoque SP', 'Qtd. SP'] : ['Estoque', 'Quantidade'])];
    const values = [
      [`LISTA ${routeCode}`],
      headers,
      ...rows.map((row) => headers.map((header) => row[header]))
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(values);
    styleCommercialSheet(worksheet, rows.length, headers);
    XLSX.utils.book_append_sheet(workbook, worksheet, `LISTA ${routeCode}`.slice(0, 31));
  } else {
    const worksheet = XLSX.utils.json_to_sheet(rowsForExport(items));
    worksheet['!cols'] = [{ wch: 16 }, { wch: 42 }, { wch: 50 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 20 }];
    const metadata = XLSX.utils.aoa_to_sheet([
      ['DebaPortal', title], ['Destino', context.destinationState || ''], ['Origem', context.originCode || ''], ['Atualização', context.updatedAt || '']
    ]);
    XLSX.utils.book_append_sheet(workbook, metadata, 'Resumo');
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Itens');
  }
  workbook.Props = { Title: `DebaPortal - ${title}`, Subject: title, Company: 'DebaPortal' };
  return workbook;
}

export function exportExcel(payload) {
  XLSX.writeFile(buildExcelWorkbook(payload), exportFileName(payload, 'xlsx'), { compression: true, cellStyles: true });
}

export function buildSapValidationWorkbook({ items, context = {} }) {
  const headers = [
    'Categoria', 'Código', 'Descrição', 'Tabela', 'Preço portal', 'Preço SAP', 'Diferença preço', 'Diferença %',
    'Estoque PR portal', 'Estoque PR SAP', 'Diferença PR', 'Estoque SP portal', 'Estoque SP SAP',
    'Diferença SP', 'Status', 'Observações'
  ];
  const tableLabel = [context.tableCode, context.tableName].filter(Boolean).join(' · ') || '—';
  const sampleDescription = `${context.samplePerCategory || 5} itens por categoria`;
  const headerRow = 7;
  const firstDataRow = headerRow + 1;
  const values = [
    ['DebaPortal · Conferência manual SAP'],
    [`Amostra aleatória · ${sampleDescription}`],
    ['Destino', context.destinationState || '—', 'Origem', context.originCode || '—', 'Tabela', tableLabel],
    ['Gerada em', context.generatedAt || new Date().toLocaleString('pt-BR'), 'Dados atualizados em', context.updatedAt || '—'],
    ['Responsável', '', 'Conferido em', ''],
    [],
    headers,
    ...items.map((item) => [
      item.validation_category || itemValue(item, 'category', 'Sem categoria'),
      itemValue(item, 'code'),
      itemValue(item, 'description'),
      tableLabel,
      itemValue(item, 'price', null),
      '', '', '',
      itemValue(item, 'stock_pr', null),
      '', '',
      itemValue(item, 'stock_sp', null),
      '', '', '', ''
    ])
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(values);
  const lastRow = Math.max(headerRow, items.length + headerRow);
  const titleStyle = { font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 18 }, fill: { fgColor: { rgb: '0B1F3A' } }, alignment: { vertical: 'center' } };
  const headerStyle = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0B1F3A' } }, alignment: { vertical: 'center', wrapText: true } };
  const inputStyle = { fill: { fgColor: { rgb: 'FFF2CC' } }, alignment: { vertical: 'center' } };
  const formulaStyle = { fill: { fgColor: { rgb: 'DDEBF7' } }, alignment: { vertical: 'center' } };
  worksheet.A1.s = titleStyle;
  for (let column = 0; column < headers.length; column += 1) {
    const address = XLSX.utils.encode_cell({ r: headerRow - 1, c: column });
    worksheet[address].s = headerStyle;
  }
  for (const address of ['B5', 'D5']) {
    worksheet[address] = worksheet[address] || { t: 's', v: '' };
    worksheet[address].s = inputStyle;
  }
  for (let row = firstDataRow; row <= lastRow; row += 1) {
    worksheet[`G${row}`] = { t: 'n', f: `IF(F${row}="","",ROUND(F${row}-E${row},2))`, s: formulaStyle, z: 'R$ #,##0.00' };
    worksheet[`H${row}`] = { t: 'n', f: `IF(OR(F${row}="",E${row}="",E${row}=0),"",F${row}/E${row}-1)`, s: formulaStyle, z: '0.00%' };
    worksheet[`K${row}`] = { t: 'n', f: `IF(J${row}="","",J${row}-I${row})`, s: formulaStyle, z: '0' };
    worksheet[`N${row}`] = { t: 'n', f: `IF(M${row}="","",M${row}-L${row})`, s: formulaStyle, z: '0' };
    worksheet[`O${row}`] = {
      t: 's',
      f: `IF(E${row}="","PORTAL SEM PREÇO",IF(OR(I${row}="",L${row}=""),"PORTAL SEM ESTOQUE",IF(COUNTA(F${row},J${row},M${row})=0,"PENDENTE",IF(COUNTA(F${row},J${row},M${row})<3,"INCOMPLETO",IF(AND(ABS(G${row})<=0.01,K${row}=0,N${row}=0),"OK","DIVERGENTE")))))`,
      s: formulaStyle
    };
    for (const column of ['F', 'J', 'M', 'P']) {
      const address = `${column}${row}`;
      worksheet[address] = worksheet[address] || { t: 's', v: '' };
      worksheet[address].s = inputStyle;
    }
    for (const column of ['E', 'F']) if (worksheet[`${column}${row}`]) worksheet[`${column}${row}`].z = 'R$ #,##0.00';
    for (const column of ['I', 'J', 'L', 'M']) if (worksheet[`${column}${row}`]) worksheet[`${column}${row}`].z = '0';
  }
  worksheet['!ref'] = `A1:P${lastRow}`;
  worksheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 15 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 15 } }
  ];
  worksheet['!rows'] = [{ hpt: 28 }, { hpt: 20 }, { hpt: 20 }, { hpt: 20 }, { hpt: 22 }, { hpt: 8 }, { hpt: 32 }];
  worksheet['!cols'] = [
    { wch: 17 }, { wch: 17 }, { wch: 42 }, { wch: 25 }, { wch: 15 }, { wch: 15 }, { wch: 17 }, { wch: 14 },
    { wch: 17 }, { wch: 15 }, { wch: 14 }, { wch: 17 }, { wch: 15 }, { wch: 14 }, { wch: 21 }, { wch: 34 }
  ];
  worksheet['!autofilter'] = { ref: `A${headerRow}:P${lastRow}` };
  worksheet['!freeze'] = { xSplit: 2, ySplit: headerRow, topLeftCell: `C${firstDataRow}`, activePane: 'bottomRight', state: 'frozen' };

  const categories = [...new Set(items.map((item) => item.validation_category || itemValue(item, 'category', 'Sem categoria')))];
  const summaryValues = [
    ['DebaPortal · Resumo da conferência SAP'],
    ['O resumo será atualizado automaticamente conforme os valores do SAP forem preenchidos.'],
    ['Destino', context.destinationState || '—', 'Origem', context.originCode || '—', 'Tabela', tableLabel],
    ['Gerada em', context.generatedAt || new Date().toLocaleString('pt-BR'), 'Dados atualizados em', context.updatedAt || '—'],
    [],
    ['Indicador', 'Quantidade'],
    ['Total da amostra'], ['OK'], ['Divergentes'], ['Pendentes'], ['Incompletos'], ['Portal sem preço'], ['Portal sem estoque'],
    [],
    ['Resultado por categoria'],
    ['Categoria', 'Total', 'OK', 'Divergentes', 'Pendentes', 'Problemas no portal'],
    ...categories.map((category) => [category])
  ];
  const summary = XLSX.utils.aoa_to_sheet(summaryValues);
  const statusRange = `'Conferência SAP'!$O$${firstDataRow}:$O$${lastRow}`;
  const categoryRange = `'Conferência SAP'!$A$${firstDataRow}:$A$${lastRow}`;
  summary.B7 = { t: 'n', f: `COUNTA('Conferência SAP'!$B$${firstDataRow}:$B$${lastRow})` };
  summary.B8 = { t: 'n', f: `COUNTIF(${statusRange},"OK")` };
  summary.B9 = { t: 'n', f: `COUNTIF(${statusRange},"DIVERGENTE")` };
  summary.B10 = { t: 'n', f: `COUNTIF(${statusRange},"PENDENTE")` };
  summary.B11 = { t: 'n', f: `COUNTIF(${statusRange},"INCOMPLETO")` };
  summary.B12 = { t: 'n', f: `COUNTIF(${statusRange},"PORTAL SEM PREÇO")` };
  summary.B13 = { t: 'n', f: `COUNTIF(${statusRange},"PORTAL SEM ESTOQUE")` };
  for (let row = 17; row < 17 + categories.length; row += 1) {
    summary[`B${row}`] = { t: 'n', f: `COUNTIF(${categoryRange},A${row})` };
    summary[`C${row}`] = { t: 'n', f: `COUNTIFS(${categoryRange},A${row},${statusRange},"OK")` };
    summary[`D${row}`] = { t: 'n', f: `COUNTIFS(${categoryRange},A${row},${statusRange},"DIVERGENTE")` };
    summary[`E${row}`] = { t: 'n', f: `COUNTIFS(${categoryRange},A${row},${statusRange},"PENDENTE")+COUNTIFS(${categoryRange},A${row},${statusRange},"INCOMPLETO")` };
    summary[`F${row}`] = { t: 'n', f: `COUNTIFS(${categoryRange},A${row},${statusRange},"PORTAL SEM PREÇO")+COUNTIFS(${categoryRange},A${row},${statusRange},"PORTAL SEM ESTOQUE")` };
  }
  summary.A1.s = titleStyle;
  for (const address of ['A6', 'B6', 'A16', 'B16', 'C16', 'D16', 'E16', 'F16']) if (summary[address]) summary[address].s = headerStyle;
  for (let row = 7; row <= 13; row += 1) {
    summary[`A${row}`].s = { font: { bold: row === 7 }, alignment: { vertical: 'center' } };
    summary[`B${row}`].s = formulaStyle;
  }
  summary['!ref'] = `A1:F${Math.max(17, 16 + categories.length)}`;
  summary['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 5 } },
    { s: { r: 14, c: 0 }, e: { r: 14, c: 5 } }
  ];
  summary['!cols'] = [{ wch: 25 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 21 }];
  summary['!rows'] = [{ hpt: 28 }, { hpt: 22 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, summary, 'Resumo');
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Conferência SAP');
  workbook.Props = { Title: 'DebaPortal - Conferência manual SAP', Subject: 'Validação manual de preços e estoques', Company: 'DebaPortal' };
  workbook.Workbook = { CalcPr: { calcMode: 'auto', fullCalcOnLoad: true, forceFullCalc: true } };
  return workbook;
}

export function exportSapValidationExcel(payload) {
  const date = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(buildSapValidationWorkbook(payload), `conferencia-manual-sap-${date}.xlsx`, { compression: true, cellStyles: true });
}

export function buildSapValidationQuoteWorkbook({ items, context = {} }) {
  const headers = ['Código', 'Descrição', 'Quantidade'];
  const values = [
    ['DebaPortal · Cotação para validação SAP'],
    ['Identificação', context.requestId || '—', 'Destino', context.destinationState || '—', 'Origem', context.originCode || '—'],
    ['Tabela', [context.tableCode, context.tableName].filter(Boolean).join(' · ') || '—', 'Gerada em', context.generatedAt || new Date().toLocaleString('pt-BR')],
    [],
    headers,
    ...items.map((item) => [itemValue(item, 'code'), itemValue(item, 'description'), 1])
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(values);
  const headerStyle = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0B1F3A' } }, alignment: { vertical: 'center' } };
  worksheet.A1.s = { ...headerStyle, font: { ...headerStyle.font, sz: 18 } };
  for (const column of ['A', 'B', 'C']) worksheet[`${column}5`].s = headerStyle;
  worksheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];
  worksheet['!cols'] = [{ wch: 18 }, { wch: 55 }, { wch: 13 }, { wch: 12 }, { wch: 18 }, { wch: 12 }];
  worksheet['!autofilter'] = { ref: `A5:C${Math.max(5, items.length + 5)}` };
  worksheet['!freeze'] = { xSplit: 0, ySplit: 5, topLeftCell: 'A6', activePane: 'bottomLeft', state: 'frozen' };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Cotação para SAP');
  workbook.Props = { Title: 'DebaPortal - Cotação para validação SAP', Subject: 'Cotação para validação SAP', Company: 'DebaPortal' };
  return workbook;
}

export function exportSapValidationQuoteExcel(payload) {
  const requestId = safeFileName(payload.context?.requestId || new Date().toISOString().slice(0, 10));
  XLSX.writeFile(buildSapValidationQuoteWorkbook(payload), `cotacao-validacao-${requestId}.xlsx`, { compression: true, cellStyles: true });
}

function drawCommercialHeader(doc, title, context, itemCount) {
  const routeCode = context.routeCode || `${context.originCode || '—'}-${context.destinationState || '—'}`;
  doc.setFillColor(11, 31, 58);
  doc.rect(0, 0, 297, 34, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('DebaPortal', 12, 12);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  doc.text(`LISTA ${routeCode}`, 12, 20);
  doc.setFontSize(8);
  doc.setTextColor(207, 225, 241);
  doc.text(`${itemCount} item(ns)  •  Destino ${context.destinationState || '—'}  •  Origem ${context.originCode || '—'}`, 12, 27);
  doc.setFont('helvetica', 'bold');
  doc.text(`LINHAS  ${(context.lines || ['Leve', 'Pesada', 'Utilitário']).join('  •  ')}`, 285, 13, { align: 'right' });
  doc.setFont('helvetica', 'normal');
}

function buildCommercialPdf(doc, payload) {
  const stockMode = payload.context?.stockMode === 'BOTH' ? 'BOTH' : 'ORIGIN';
  const rows = commercialRows(payload.items, stockMode);
  const bothStocks = stockMode === 'BOTH';
  const stockHeaders = bothStocks ? ['Estoque PR', 'Qtd. PR', 'Estoque SP', 'Qtd. SP'] : ['Estoque', 'Quantidade'];
  drawCommercialHeader(doc, payload.title, payload.context || {}, rows.length);
  autoTable(doc, {
    startY: 40,
    margin: { top: 12, right: 12, bottom: 12, left: 12 },
    tableWidth: 273,
    head: [['Código IPS', 'Descrição', 'Marca', 'Linha', 'Aplicação', 'Ano', 'Preço s/ impostos', 'Preço c/ impostos', ...stockHeaders]],
    body: rows.map((row) => [
      row['Código IPS'],
      row.Descrição,
      row.Marca || '—',
      row.Linha || 'Leve',
      row.Aplicação || '—',
      row.Ano || '—',
      row['Preço s/ impostos'] === null ? '—' : money(row['Preço s/ impostos']),
      row['Preço c/ impostos'] === null ? 'Sem preço' : money(row['Preço c/ impostos']),
      ...(bothStocks
        ? [row['Estoque PR'], row['Qtd. PR'], row['Estoque SP'], row['Qtd. SP']]
        : [row.Estoque, row.Quantidade])
    ]),
    theme: 'plain',
    styles: { fontSize: bothStocks ? 6.5 : 7.2, minCellWidth: 0, cellPadding: { top: 2.5, right: 1, bottom: 2.5, left: 1 }, overflow: 'linebreak', valign: 'middle', lineColor: [222, 230, 238], lineWidth: { bottom: .15 } },
    headStyles: { fillColor: [227, 238, 247], textColor: [11, 31, 58], fontStyle: 'bold', fontSize: bothStocks ? 6.4 : 7.2, minCellHeight: 8 },
    alternateRowStyles: { fillColor: [248, 251, 253] },
    columnStyles: {
      0: { cellWidth: bothStocks ? 18 : 20, fontStyle: 'bold', textColor: [11, 31, 58] },
      1: { cellWidth: bothStocks ? 34 : 38 },
      2: { cellWidth: bothStocks ? 16 : 18 },
      3: { cellWidth: 18 },
      4: { cellWidth: bothStocks ? 42 : 56 },
      5: { cellWidth: bothStocks ? 16 : 18 },
      6: { cellWidth: bothStocks ? 20 : 24, halign: 'right' },
      7: { cellWidth: bothStocks ? 20 : 24, halign: 'right', fontStyle: 'bold' },
      8: { cellWidth: bothStocks ? 23 : 29 },
      9: { cellWidth: bothStocks ? 14 : 18, halign: 'right' },
      ...(bothStocks ? { 10: { cellWidth: 23 }, 11: { cellWidth: 14, halign: 'right' } } : {})
    },
    didDrawPage: () => {
      doc.setFontSize(7);
      doc.setTextColor(100, 111, 125);
      doc.text(`Página ${doc.getNumberOfPages()}`, 285, 202, { align: 'right' });
    }
  });
}

export function buildPdfDocument({ title, items, context = {}, customer = null, variant = 'document' }) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape', compress: true });
  doc.setProperties({ title: `DebaPortal - ${title}`, subject: title, author: 'DebaPortal', creator: 'DebaPortal' });
  if (variant === 'commercial-list') {
    buildCommercialPdf(doc, { title, items, context });
    return doc;
  }
  doc.setTextColor(11, 31, 58);
  doc.setFontSize(19);
  doc.text('DebaPortal', 14, 15);
  doc.setFontSize(12);
  doc.text(title, 14, 23);
  doc.setTextColor(75, 85, 99);
  doc.setFontSize(9);
  doc.text([
    `Destino: ${context.destinationState || '-'}`,
    `Origem: ${context.originCode || '-'}`,
    customer?.legalName ? `Cliente: ${customer.legalName}` : null,
    context.updatedAt ? `Atualização: ${context.updatedAt}` : null
  ].filter(Boolean).join('  |  '), 14, 30);
  autoTable(doc, {
    startY: 36,
    head: [['Código', 'Descrição', 'Aplicação', 'Qtd.', 'Preço', 'PR', 'SP', 'Origem', 'Total']],
    body: rowsForExport(items).map((row) => [row.Código, row.Descrição, row.Aplicação, row.Quantidade, money(row['Preço unitário']), row['Estoque PR'], row['Estoque SP'], row['Estoque origem'], row.Total === '' ? '' : money(row.Total)]),
    theme: 'striped',
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
    headStyles: { fillColor: [11, 31, 58], textColor: 255 },
    columnStyles: { 1: { cellWidth: 43 }, 2: { cellWidth: 57 }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' } },
    didDrawPage: () => {
      doc.setFontSize(8);
      doc.setTextColor(100);
      doc.text(`Página ${doc.getNumberOfPages()}`, 280, 202, { align: 'right' });
    }
  });
  return doc;
}

export function exportPdf(payload) {
  triggerDownload(buildPdfDocument(payload).output('blob'), exportFileName(payload, 'pdf'));
}
