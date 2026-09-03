import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads';
import {
  DOMMatrix,
  ImageData,
  Path2D,
  createCanvas,
  loadImage,
} from '@napi-rs/canvas';
import { resolvedPdfJs } from '../../attachments/pdfjs-runtime.mjs';

function installPdfJsCanvasGlobals() {
  globalThis.DOMMatrix ??= DOMMatrix;
  globalThis.ImageData ??= ImageData;
  globalThis.Path2D ??= Path2D;
}

const PAGE_NUMBER_PATTERN = /^\s*(?:(?:page\s*)?\d+\s*(?:of|\/)\s*\d+|페이지\s*\d+|\d+\s*페이지)\s*$/i;

// Word/PowerPoint page-number fields sometimes reach the PDF as glyphs the
// rasterizer cannot shape. Repaint only those items, inside their own bounds,
// with a family that covers Latin and Hangul; every other bottom-band element
// (takeaway bands, source lines, footnotes) is left exactly as rendered.
async function repairBottomPageNumberText(page, viewport, canvas, context, Util) {
  const content = await page.getTextContent();
  const base = page.getViewport({ scale: 1 });
  const numbers = content.items.filter((item) => (
    PAGE_NUMBER_PATTERN.test(String(item.str || ''))
    && Number(item.transform?.[5]) < base.height * 0.12
  ));
  if (!numbers.length) return;
  context.save();
  context.textBaseline = 'alphabetic';
  for (const item of numbers) {
    const transform = Util.transform(viewport.transform, item.transform);
    const x = transform[4];
    const baseline = transform[5];
    const fontHeight = Math.max(1, Math.hypot(transform[2], transform[3]));
    const width = Math.max(1, Number(item.width || 0) * viewport.scale);
    const top = Math.max(0, Math.floor(baseline - fontHeight * 0.95));
    const bottom = Math.min(canvas.height, Math.ceil(baseline + fontHeight * 0.3));
    const sampleX = Math.min(canvas.width - 1, Math.max(0, Math.round(x - 3)));
    const sample = context.getImageData(sampleX, Math.min(canvas.height - 1, top), 1, 1).data;
    context.fillStyle = `rgb(${sample[0]},${sample[1]},${sample[2]})`;
    context.fillRect(Math.max(0, Math.floor(x - 1)), top, Math.ceil(width + 2), Math.max(1, bottom - top));
    const luminance = (sample[0] * 299 + sample[1] * 587 + sample[2] * 114) / 1000;
    context.fillStyle = luminance > 128 ? 'rgb(23,23,23)' : 'rgb(235,235,235)';
    context.font = `${fontHeight}px "Segoe UI", "Malgun Gothic", sans-serif`;
    const measuredWidth = Math.max(1, context.measureText(item.str).width);
    context.save();
    context.translate(x, baseline);
    context.scale(width / measuredWidth, 1);
    context.fillText(item.str, 0, 0);
    context.restore();
  }
  context.restore();
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

const PDF_RENDER_WORKER_KIND = 'mixdog-office-pdf-render';
const PDF_RENDER_PAGE_WORKER_KIND = 'mixdog-office-pdf-render-page';

async function renderPdfPageDirect(path, pageNumber, targetWidth, minimumScale = 0.25) {
  installPdfJsCanvasGlobals();
  const { getDocument, Util, VerbosityLevel } = await resolvedPdfJs();
  const loadingTask = getDocument({
    data: new Uint8Array(await readFile(path)),
    disableWorker: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: VerbosityLevel.ERRORS,
  });
  try {
    const document = await loadingTask.promise;
    const page = await document.getPage(pageNumber);
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
    await repairBottomPageNumberText(page, viewport, canvas, context, Util);
    return {
      width: canvas.width,
      height: canvas.height,
      data: canvas.toBuffer('image/png').toString('base64'),
    };
  } finally {
    try { await loadingTask.destroy?.(); } catch {}
  }
}

async function runPdfRenderWorker(data, signal = null) {
  const worker = new Worker(new URL(import.meta.url), {
    execArgv: process.execArgv.filter((argument) => !(
      /^--(?:input-type|max-old-space-size|max-semi-space-size|stack-size|heapsnapshot-near-heap-limit)(?:=|$)/
        .test(argument)
    )),
    workerData: data,
  });
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      void worker.terminate();
      finish(reject, new Error('PDF rendering was cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (message) => {
      if (message?.ok) {
        finish(resolve, message.value);
      } else {
        const error = new Error(message?.error?.message || 'PDF rendering failed');
        if (message?.error?.stack) error.stack = message.error.stack;
        finish(reject, error);
      }
    });
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => {
      if (!settled) finish(reject, new Error(`PDF rendering worker exited with code ${code}`));
    });
  });
}

async function renderPdfPagesDirect(path, {
  pages = null,
  maxWidth = 1400,
  signal = null,
} = {}) {
  if (signal?.aborted) throw new Error('PDF rendering was cancelled');
  installPdfJsCanvasGlobals();
  const { getDocument, VerbosityLevel } = await resolvedPdfJs();
  const pdfData = await readFile(path);
  const openDocument = async () => {
    const loadingTask = getDocument({
      data: Uint8Array.from(pdfData),
      disableWorker: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: VerbosityLevel.ERRORS,
    });
    try {
      return { loadingTask, document: await loadingTask.promise };
    } catch (error) {
      try { await loadingTask.destroy?.(); } catch {}
      throw error;
    }
  };
  const { loadingTask, document } = await openDocument();
  try {
    const selected = requestedPages(document.numPages, pages);
    const stem = basename(path, extname(path));
    const output = [];
    const renderPage = async (pageNumber, targetWidth, minimumScale = 0.25) => {
      if (signal?.aborted) throw new Error('PDF rendering was cancelled');
      const rendered = await runPdfRenderWorker({
        kind: PDF_RENDER_PAGE_WORKER_KIND,
        path,
        pageNumber,
        targetWidth,
        minimumScale,
      }, signal);
      if (signal?.aborted) throw new Error('PDF rendering was cancelled');
      return {
        canvas: { width: rendered.width, height: rendered.height },
        data: Buffer.from(rendered.data, 'base64'),
      };
    };
    if (selected.length <= 12) {
      for (const pageNumber of selected) {
        const { canvas, data } = await renderPage(pageNumber, maxWidth);
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
          const rendered = await renderPage(pageNumber, cellWidth, 0.05);
          thumbnails.push({
            page: pageNumber,
            image: await loadImage(rendered.data),
          });
        }
        const cellHeight = Math.max(...thumbnails.map(({ image }) => image.height));
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
          const { page: pageNumber, image } = thumbnails[index];
          const column = index % columns;
          const row = Math.floor(index / columns);
          const x = gap + column * (cellWidth + gap);
          const y = gap + row * (labelHeight + cellHeight + gap);
          context.fillStyle = 'rgb(45,50,60)';
          context.fillText(`Page ${pageNumber}`, x, y + labelHeight / 2);
          context.fillStyle = 'rgb(255,255,255)';
          context.fillRect(x, y + labelHeight, cellWidth, cellHeight);
          context.drawImage(image, x, y + labelHeight);
          context.strokeStyle = 'rgb(180,185,195)';
          context.strokeRect(x, y + labelHeight, image.width, image.height);
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
    try { await loadingTask.destroy?.(); } catch {}
  }
}

export async function renderPdfPages(path, options = {}) {
  const signal = options.signal || null;
  if (signal?.aborted) throw new Error('PDF rendering was cancelled');
  if (!isMainThread) return await renderPdfPagesDirect(path, options);
  return await runPdfRenderWorker({
    kind: PDF_RENDER_WORKER_KIND,
    path,
    options: {
      pages: options.pages ?? null,
      maxWidth: options.maxWidth ?? 1400,
    },
  }, signal);
}

if (!isMainThread && [PDF_RENDER_WORKER_KIND, PDF_RENDER_PAGE_WORKER_KIND].includes(workerData?.kind)) {
  try {
    const value = workerData.kind === PDF_RENDER_PAGE_WORKER_KIND
      ? await renderPdfPageDirect(
        workerData.path,
        workerData.pageNumber,
        workerData.targetWidth,
        workerData.minimumScale,
      )
      : await renderPdfPagesDirect(workerData.path, workerData.options);
    parentPort?.postMessage({ ok: true, value });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : '',
      },
    });
  } finally {
    parentPort?.close();
  }
}
