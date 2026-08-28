import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  DOMMatrix,
  ImageData,
  Path2D,
  createCanvas,
} from '@napi-rs/canvas';
import { resolvedPdfJs } from '../attachments/pdfjs-runtime.mjs';

function installPdfJsCanvasGlobals() {
  globalThis.DOMMatrix ??= DOMMatrix;
  globalThis.ImageData ??= ImageData;
  globalThis.Path2D ??= Path2D;
}

function requestedPages(pageCount, pages) {
  const selected = Array.isArray(pages) && pages.length
    ? pages
    : Array.from({ length: pageCount }, (_, index) => index + 1);
  const unique = [...new Set(selected.map(Number))];
  if (Array.isArray(pages) && pages.length && unique.length > 12) {
    throw new Error('render accepts at most 12 explicit pages per call');
  }
  for (const page of unique) {
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      throw new Error(`render page out of range: ${page} (document has ${pageCount})`);
    }
  }
  return unique;
}

export async function renderPdfPages(path, {
  pages = null,
  maxWidth = 1400,
  signal = null,
} = {}) {
  if (signal?.aborted) throw new Error('PDF rendering was cancelled');
  installPdfJsCanvasGlobals();
  const { getDocument, VerbosityLevel } = await resolvedPdfJs();
  const loading = getDocument({
    data: new Uint8Array(await readFile(path)),
    disableWorker: true,
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: VerbosityLevel.ERRORS,
  });
  const document = await loading.promise;
  try {
    const selected = requestedPages(document.numPages, pages);
    const stem = basename(path, extname(path));
    const output = [];
    const renderPage = async (pageNumber, targetWidth, minimumScale = 0.25) => {
      if (signal?.aborted) throw new Error('PDF rendering was cancelled');
      const page = await document.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2, Math.max(minimumScale, Number(targetWidth || 1400) / base.width));
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        await page.render({
          canvas,
          canvasContext: context,
          viewport,
          background: 'rgb(255,255,255)',
        }).promise;
        if (signal?.aborted) throw new Error('PDF rendering was cancelled');
        return canvas;
      } finally {
        try { page.cleanup?.(); } catch {}
      }
    };
    if (selected.length <= 12) {
      for (const pageNumber of selected) {
        const canvas = await renderPage(pageNumber, maxWidth);
        const data = canvas.toBuffer('image/png');
        const imagePath = join(dirname(path), `${stem}-page-${pageNumber}.png`);
        await writeFile(imagePath, data);
        output.push({
          page: pageNumber,
          path: imagePath,
          width: canvas.width,
          height: canvas.height,
          mimeType: 'image/png',
          data: data.toString('base64'),
        });
      }
    } else {
      const width = Math.max(256, Number(maxWidth) || 1400);
      const pagesPerSheet = Math.ceil(selected.length / 12);
      for (let offset = 0; offset < selected.length; offset += pagesPerSheet) {
        const group = selected.slice(offset, offset + pagesPerSheet);
        const columns = group.length <= 2
          ? 1
          : Math.max(2, Math.ceil(Math.sqrt(group.length * 0.75)));
        const rows = Math.ceil(group.length / columns);
        const gap = 12;
        const labelHeight = 24;
        const cellWidth = Math.max(64, Math.floor((width - (columns + 1) * gap) / columns));
        const thumbnails = [];
        for (const pageNumber of group) {
          thumbnails.push({
            page: pageNumber,
            canvas: await renderPage(pageNumber, cellWidth, 0.05),
          });
        }
        const cellHeight = Math.max(...thumbnails.map(({ canvas }) => canvas.height));
        const sheet = createCanvas(
          width,
          gap + rows * (labelHeight + cellHeight + gap),
        );
        const context = sheet.getContext('2d');
        context.fillStyle = 'rgb(238,240,244)';
        context.fillRect(0, 0, sheet.width, sheet.height);
        context.font = '16px sans-serif';
        context.textBaseline = 'middle';
        for (let index = 0; index < thumbnails.length; index += 1) {
          const { page: pageNumber, canvas } = thumbnails[index];
          const column = index % columns;
          const row = Math.floor(index / columns);
          const x = gap + column * (cellWidth + gap);
          const y = gap + row * (labelHeight + cellHeight + gap);
          context.fillStyle = 'rgb(45,50,60)';
          context.fillText(`Page ${pageNumber}`, x, y + labelHeight / 2);
          context.fillStyle = 'rgb(255,255,255)';
          context.fillRect(x, y + labelHeight, cellWidth, cellHeight);
          context.drawImage(canvas, x, y + labelHeight);
          context.strokeStyle = 'rgb(180,185,195)';
          context.strokeRect(x, y + labelHeight, canvas.width, canvas.height);
        }
        const data = sheet.toBuffer('image/png');
        const first = group[0];
        const last = group.at(-1);
        const imagePath = join(dirname(path), `${stem}-pages-${first}-${last}.png`);
        await writeFile(imagePath, data);
        output.push({
          page: first,
          pages: group,
          path: imagePath,
          width: sheet.width,
          height: sheet.height,
          mimeType: 'image/png',
          data: data.toString('base64'),
        });
      }
    }
    const reviewedPages = output.flatMap((image) => image.pages || [image.page]);
    const reviewedPageSet = new Set(reviewedPages);
    return {
      pageCount: document.numPages,
      images: output,
      visualCoverage: {
        reviewedPages,
        reviewed: reviewedPages.length,
        total: document.numPages,
        complete: reviewedPages.length === document.numPages,
        remainingPages: Array.from(
          { length: document.numPages },
          (_, index) => index + 1,
        ).filter((page) => !reviewedPageSet.has(page)),
      },
    };
  } finally {
    try { await document.destroy?.(); } catch {}
  }
}
