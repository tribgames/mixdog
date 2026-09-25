// A contents field written by the portable backend caches its entries without pages: nothing had laid the document
// out, so a report opened on "1. 요약 / 2. 원인" with no number beside either — an unfinished page in every preview
// and in any reader that does not update fields. The preview render is that layout: the entries are found on its
// pages, the numbers written into the cache, and the caller renders once more so the preview shows them.
import { extractPdfTextLayout } from '../pdf/pdf-analysis.mjs';
import { writeDocxTocPages } from '../portable/portable-docx-operations.mjs';
import { loadPackage, savePackage, zipText } from '../portable/portable-opc.mjs';

export async function numberDocxTableOfContents(docxPath, pdfPath) {
  const zip = await loadPackage(docxPath);
  const xml = await zipText(zip, 'word/document.xml');
  if (!/<w:fldSimple\b[^>]*\bw:instr="[^"]*TOC/.test(xml || '')) return false;
  const layout = await extractPdfTextLayout(pdfPath, { shapes: false });
  const pageTexts = layout.pages.map((page) => page.items.map((item) => item.text).join('').replace(/\s+/g, ''));
  if (!(await writeDocxTocPages(zip, pageTexts))) return false;
  await savePackage(zip, docxPath);
  return true;
}
