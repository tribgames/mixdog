import { definePDFJSModule } from 'unpdf';

let configuredPromise = null;

export async function resolvedPdfJs() {
  configuredPromise ??= Promise.resolve().then(async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    await definePDFJSModule(() => Promise.resolve(pdfjs));
    return pdfjs;
  });
  return await configuredPromise;
}
