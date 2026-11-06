import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { money, safeFileName } from './utils.js';

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

function rowsForExport(items) {
  return items.map((item) => ({
    Código: item.product?.code || item.code,
    Descrição: item.product?.description || item.description,
    Aplicação: (item.product?.applications || item.applications || []).join('; '),
    Quantidade: item.quantity ?? '',
    'Preço unitário': Number(item.product?.price ?? item.price ?? 0),
    'Estoque PR': Number(item.product?.stock_pr ?? item.stock_pr ?? 0),
    'Estoque SP': Number(item.product?.stock_sp ?? item.stock_sp ?? 0),
    'Estoque origem': Number(item.product?.stock_origin ?? item.stock_origin ?? 0),
    Total: item.quantity == null ? '' : Number(item.quantity) * Number(item.product?.price ?? item.price ?? 0),
    Atualização: item.product?.updated_at || item.updated_at || ''
  }));
}

export function exportExcel({ title, items, context = {} }) {
  const worksheet = XLSX.utils.json_to_sheet(rowsForExport(items));
  worksheet['!cols'] = [{ wch: 16 }, { wch: 42 }, { wch: 50 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 20 }];
  const metadata = XLSX.utils.aoa_to_sheet([
    ['DebaPortal', title], ['Destino', context.destinationState || ''], ['Origem', context.originCode || ''], ['Atualização', context.updatedAt || '']
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, metadata, 'Resumo');
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Itens');
  workbook.Props = { Title: `DebaPortal - ${title}`, Subject: title, Company: 'DebaPortal' };
  XLSX.writeFile(workbook, `${safeFileName(title)}.xlsx`, { compression: true });
}

export function exportPdf({ title, items, context = {}, customer = null }) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape', compress: true });
  doc.setProperties({ title: `DebaPortal - ${title}`, subject: title, author: 'DebaPortal', creator: 'DebaPortal' });
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
  triggerDownload(doc.output('blob'), `${safeFileName(title)}.pdf`);
}
