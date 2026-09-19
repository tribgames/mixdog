// pdf.js document loading shared by the analysis and OCR paths: canvas
// globals, page selection and the loader.
import { readFile } from 'node:fs/promises';
import { DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { resolvedPdfJs } from '../../attachments/pdfjs-runtime.mjs';
import { MAX_PDF_ANALYSIS_PAGES } from './pdf-limits.mjs';

function installPdfGlobals() {
  globalThis.DOMMatrix ??= DOMMatrix;
  globalThis.ImageData ??= ImageData;
  globalThis.Path2D ??= Path2D;
}

export function selectedPages(total, pages) {
  const values =
    Array.isArray(pages) && pages.length
      ? [...new Set(pages.map(Number))]
      : Array.from({ length: total }, (_, index) => index + 1);
  if (values.length > MAX_PDF_ANALYSIS_PAGES)
    throw new Error(`PDF analysis accepts at most ${MAX_PDF_ANALYSIS_PAGES} pages per call`);
  for (const page of values) {
    if (!Number.isInteger(page) || page < 1 || page > total) throw new Error(`PDF page out of range: ${page}`);
  }
  return values;
}

// A path reads the file; bytes let a batch measure the document it is editing
// before anything reaches the disk.
export async function openPdfJs(source) {
  installPdfGlobals();
  const pdfjs = await resolvedPdfJs();
  const bytes = typeof source === 'string' ? await readFile(source) : source;
  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  return { pdfjs, document: await loading.promise };
}
