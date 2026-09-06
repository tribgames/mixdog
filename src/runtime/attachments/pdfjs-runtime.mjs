import { fileURLToPath } from 'node:url';
import { definePDFJSModule } from 'unpdf';

let configuredPromise = null;

/**
 * Directory (trailing slash, forward slashes) holding pdf.js's bundled
 * standard fonts. Without it a page set in Helvetica or Times renders with a
 * canvas fallback face whose widths do not match, which shows up as
 * letter-spaced text in previews.
 */
export function pdfjsStandardFontDataUrl() {
  const directory = fileURLToPath(new URL('../../standard_fonts/', import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')));
  return `${directory.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
}

export async function resolvedPdfJs() {
  configuredPromise ??= Promise.resolve().then(async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    await definePDFJSModule(() => Promise.resolve(pdfjs));
    return pdfjs;
  });
  return await configuredPromise;
}
