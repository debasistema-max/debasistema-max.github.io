import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { parseSapPdfPages } from './sap-quote-validation.js';

export async function parseSapPdf(file) {
  if (!file || !/\.pdf$/i.test(file.name || '')) throw new Error('Selecione uma cotação SAP em PDF.');
  if (file.size > 10_000_000) throw new Error('O PDF excede o limite de 10 MB.');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const document = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    pages.push((await page.getTextContent()).items);
  }
  return parseSapPdfPages(pages);
}
