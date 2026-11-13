import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { commercialApplicationValues, commercialYearValues, money, safeFileName, stockLevel } from './utils.js';

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
    'Estoque PR': Number(itemValue(item, 'stock_pr', 0)),
    'Estoque SP': Number(itemValue(item, 'stock_sp', 0)),
    'Estoque origem': Number(itemValue(item, 'stock_origin', 0)),
    Total: item.quantity == null ? '' : Number(item.quantity) * Number(itemValue(item, 'price', 0)),
    Atualização: itemValue(item, 'updated_at')
  }));
}

export function commercialRows(items) {
  const uniqueItems = new Map();
  for (const item of items) {
    const code = String(itemValue(item, 'code') || '').trim().toLocaleUpperCase('pt-BR');
    const key = code || String(itemValue(item, 'id') || uniqueItems.size);
    if (!uniqueItems.has(key)) uniqueItems.set(key, item);
  }
  return [...uniqueItems.values()].map((item) => {
    const stockOrigin = itemValue(item, 'stock_origin', null);
    return {
      Código: itemValue(item, 'code'),
      Descrição: itemValue(item, 'description'),
      Aplicação: commercialApplicationValues(itemValue(item, 'applications', [])).join('; '),
      Ano: commercialYearValues(itemValue(item, 'years', []), itemValue(item, 'applications', [])).join('; '),
      Preço: itemValue(item, 'price', null),
      'Estoque PR': itemValue(item, 'stock_pr', null),
      'Estoque SP': itemValue(item, 'stock_sp', null),
      Disponibilidade: stockOrigin === null ? 'Sem dados' : stockLevel(stockOrigin).label
    };
  });
}

function styleCommercialSheet(sheet, rowCount) {
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
  for (const column of 'ABCDEFGH') if (sheet[`${column}5`]) sheet[`${column}5`].s = headerStyle;
  for (let row = 6; row <= rowCount + 5; row += 1) if (sheet[`E${row}`]) sheet[`E${row}`].z = 'R$ #,##0.00';
  sheet['!rows'] = [{ hpt: 28 }, { hpt: 20 }, { hpt: 20 }, { hpt: 8 }, { hpt: 22 }];
  sheet['!cols'] = [{ wch: 17 }, { wch: 40 }, { wch: 55 }, { wch: 18 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 20 }];
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }];
  sheet['!autofilter'] = { ref: `A5:H${Math.max(5, rowCount + 5)}` };
  sheet['!freeze'] = { xSplit: 0, ySplit: 5, topLeftCell: 'A6', activePane: 'bottomLeft', state: 'frozen' };
}

export function buildExcelWorkbook({ title, items, context = {}, variant = 'document' }) {
  const workbook = XLSX.utils.book_new();
  if (variant === 'commercial-list') {
    const rows = commercialRows(items);
    const headers = ['Código', 'Descrição', 'Aplicação', 'Ano', 'Preço', 'Estoque PR', 'Estoque SP', 'Disponibilidade'];
    const values = [
      [`DebaPortal · ${title}`],
      ['Destino', context.destinationState || '—', 'Origem', context.originCode || '—'],
      ['Linhas', (context.lines || ['Leve', 'Pesada', 'Utilitário']).join(' • ')],
      [],
      headers,
      ...rows.map((row) => headers.map((header) => row[header]))
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(values);
    styleCommercialSheet(worksheet, rows.length);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Lista comercial');
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
  XLSX.writeFile(buildExcelWorkbook(payload), `${safeFileName(payload.title)}.xlsx`, { compression: true, cellStyles: true });
}

export function buildSapValidationWorkbook({ items, context = {} }) {
  const headers = [
    'Linha', 'Código', 'Descrição', 'Tabela', 'Preço portal', 'Preço SAP', 'Diferença preço', 'Diferença %',
    'Estoque PR portal', 'Estoque PR SAP', 'Diferença PR', 'Estoque SP portal', 'Estoque SP SAP',
    'Diferença SP', 'Status', 'Observações'
  ];
  const tableLabel = [context.tableCode, context.tableName].filter(Boolean).join(' · ') || '—';
  const headerRow = 7;
  const firstDataRow = headerRow + 1;
  const values = [
    ['DebaPortal · Conferência manual SAP'],
    [`Amostra aleatória de ${context.sampleSize || 5} itens por linha`],
    ['Destino', context.destinationState || '—', 'Origem', context.originCode || '—', 'Tabela', tableLabel],
    ['Gerada em', context.generatedAt || new Date().toLocaleString('pt-BR'), 'Dados atualizados em', context.updatedAt || '—'],
    ['Responsável', '', 'Conferido em', ''],
    [],
    headers,
    ...items.map((item) => [
      item.validation_line || itemValue(item, 'product_line', 'Sem linha'),
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

  const lines = [...new Set(items.map((item) => item.validation_line || itemValue(item, 'product_line', 'Sem linha')))];
  const summaryValues = [
    ['DebaPortal · Resumo da conferência SAP'],
    ['O resumo será atualizado automaticamente conforme os valores do SAP forem preenchidos.'],
    ['Destino', context.destinationState || '—', 'Origem', context.originCode || '—', 'Tabela', tableLabel],
    ['Gerada em', context.generatedAt || new Date().toLocaleString('pt-BR'), 'Dados atualizados em', context.updatedAt || '—'],
    [],
    ['Indicador', 'Quantidade'],
    ['Total da amostra'], ['OK'], ['Divergentes'], ['Pendentes'], ['Incompletos'], ['Portal sem preço'], ['Portal sem estoque'],
    [],
    ['Resultado por linha'],
    ['Linha', 'Total', 'OK', 'Divergentes', 'Pendentes', 'Problemas no portal'],
    ...lines.map((line) => [line])
  ];
  const summary = XLSX.utils.aoa_to_sheet(summaryValues);
  const statusRange = `'Conferência SAP'!$O$${firstDataRow}:$O$${lastRow}`;
  const lineRange = `'Conferência SAP'!$A$${firstDataRow}:$A$${lastRow}`;
  summary.B7 = { t: 'n', f: `COUNTA('Conferência SAP'!$B$${firstDataRow}:$B$${lastRow})` };
  summary.B8 = { t: 'n', f: `COUNTIF(${statusRange},"OK")` };
  summary.B9 = { t: 'n', f: `COUNTIF(${statusRange},"DIVERGENTE")` };
  summary.B10 = { t: 'n', f: `COUNTIF(${statusRange},"PENDENTE")` };
  summary.B11 = { t: 'n', f: `COUNTIF(${statusRange},"INCOMPLETO")` };
  summary.B12 = { t: 'n', f: `COUNTIF(${statusRange},"PORTAL SEM PREÇO")` };
  summary.B13 = { t: 'n', f: `COUNTIF(${statusRange},"PORTAL SEM ESTOQUE")` };
  for (let row = 17; row < 17 + lines.length; row += 1) {
    summary[`B${row}`] = { t: 'n', f: `COUNTIF(${lineRange},A${row})` };
    summary[`C${row}`] = { t: 'n', f: `COUNTIFS(${lineRange},A${row},${statusRange},"OK")` };
    summary[`D${row}`] = { t: 'n', f: `COUNTIFS(${lineRange},A${row},${statusRange},"DIVERGENTE")` };
    summary[`E${row}`] = { t: 'n', f: `COUNTIFS(${lineRange},A${row},${statusRange},"PENDENTE")+COUNTIFS(${lineRange},A${row},${statusRange},"INCOMPLETO")` };
    summary[`F${row}`] = { t: 'n', f: `COUNTIFS(${lineRange},A${row},${statusRange},"PORTAL SEM PREÇO")+COUNTIFS(${lineRange},A${row},${statusRange},"PORTAL SEM ESTOQUE")` };
  }
  summary.A1.s = titleStyle;
  for (const address of ['A6', 'B6', 'A16', 'B16', 'C16', 'D16', 'E16', 'F16']) if (summary[address]) summary[address].s = headerStyle;
  for (let row = 7; row <= 13; row += 1) {
    summary[`A${row}`].s = { font: { bold: row === 7 }, alignment: { vertical: 'center' } };
    summary[`B${row}`].s = formulaStyle;
  }
  summary['!ref'] = `A1:F${Math.max(17, 16 + lines.length)}`;
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

function drawCommercialHeader(doc, title, context, itemCount) {
  doc.setFillColor(11, 31, 58);
  doc.rect(0, 0, 297, 34, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('DebaPortal', 12, 12);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  doc.text(title, 12, 20);
  doc.setFontSize(8);
  doc.setTextColor(207, 225, 241);
  doc.text(`${itemCount} item(ns)  •  Destino ${context.destinationState || '—'}  •  Origem ${context.originCode || '—'}`, 12, 27);
  doc.setFont('helvetica', 'bold');
  doc.text(`LINHAS  ${(context.lines || ['Leve', 'Pesada', 'Utilitário']).join('  •  ')}`, 285, 13, { align: 'right' });
  doc.setFont('helvetica', 'normal');
}

function buildCommercialPdf(doc, payload) {
  const rows = commercialRows(payload.items);
  drawCommercialHeader(doc, payload.title, payload.context || {}, rows.length);
  autoTable(doc, {
    startY: 40,
    margin: { top: 12, right: 12, bottom: 12, left: 12 },
    tableWidth: 253,
    head: [['Código', 'Descrição', 'Aplicação', 'Ano', 'Preço', 'PR', 'SP', 'Disponibilidade']],
    body: rows.map((row) => [
      row.Código,
      row.Descrição,
      row.Aplicação || '—',
      row.Ano || '—',
      row.Preço === null ? 'Sem preço' : money(row.Preço),
      row['Estoque PR'] === null ? '—' : row['Estoque PR'],
      row['Estoque SP'] === null ? '—' : row['Estoque SP'],
      row.Disponibilidade
    ]),
    theme: 'plain',
    styles: { fontSize: 7.2, minCellWidth: 0, cellPadding: { top: 2.5, right: 2, bottom: 2.5, left: 2 }, overflow: 'linebreak', valign: 'middle', lineColor: [222, 230, 238], lineWidth: { bottom: .15 } },
    headStyles: { fillColor: [227, 238, 247], textColor: [11, 31, 58], fontStyle: 'bold', fontSize: 7.2, minCellHeight: 8 },
    alternateRowStyles: { fillColor: [248, 251, 253] },
    columnStyles: {
      0: { cellWidth: 23, fontStyle: 'bold', textColor: [11, 31, 58] },
      1: { cellWidth: 45 },
      2: { cellWidth: 73 },
      3: { cellWidth: 28 },
      4: { cellWidth: 25, halign: 'right', fontStyle: 'bold' },
      5: { cellWidth: 15, halign: 'right' },
      6: { cellWidth: 15, halign: 'right' },
      7: { cellWidth: 29 }
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
  triggerDownload(buildPdfDocument(payload).output('blob'), `${safeFileName(payload.title)}.pdf`);
}
