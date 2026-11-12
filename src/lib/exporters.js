import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { money, safeFileName, stockLevel } from './utils.js';

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
  return items.map((item) => {
    const stockOrigin = itemValue(item, 'stock_origin', null);
    return {
      Código: itemValue(item, 'code'),
      Descrição: itemValue(item, 'description'),
      Aplicação: itemValue(item, 'applications', []).join('; '),
      Ano: itemValue(item, 'years', []).join('; '),
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
