import { createRequire } from 'node:module';
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  DOMMatrix,
  ImageData,
  Path2D,
} from '@napi-rs/canvas';
import fontkit from '@pdf-lib/fontkit';
import {
  PDFDocument,
  StandardFonts,
  rgb,
} from 'pdf-lib';
import sharp from 'sharp';
import { resolvedPdfJs } from '../attachments/pdfjs-runtime.mjs';
import { renderPdfPages } from './pdf-render.mjs';

const require = createRequire(import.meta.url);
const MAX_QUERY_PAGES = 100;

function installPdfGlobals() {
  globalThis.DOMMatrix ??= DOMMatrix;
  globalThis.ImageData ??= ImageData;
  globalThis.Path2D ??= Path2D;
}

function selectedPages(total, pages) {
  const values = Array.isArray(pages) && pages.length
    ? [...new Set(pages.map(Number))]
    : Array.from({ length: total }, (_, index) => index + 1);
  if (values.length > MAX_QUERY_PAGES) throw new Error(`PDF analysis accepts at most ${MAX_QUERY_PAGES} pages per call`);
  for (const page of values) {
    if (!Number.isInteger(page) || page < 1 || page > total) throw new Error(`PDF page out of range: ${page}`);
  }
  return values;
}

async function openPdfJs(path) {
  installPdfGlobals();
  const pdfjs = await resolvedPdfJs();
  const loading = pdfjs.getDocument({
    data: new Uint8Array(await readFile(path)),
    disableWorker: true,
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  return { pdfjs, document: await loading.promise };
}

export async function extractPdfTextLayout(path, {
  pages = null,
  maxItems = 20_000,
  signal = null,
} = {}) {
  const { pdfjs, document } = await openPdfJs(path);
  try {
    const output = [];
    let truncated = false;
    for (const pageNumber of selectedPages(document.numPages, pages)) {
      if (signal?.aborted) throw new Error('PDF layout extraction was cancelled');
      const page = await document.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const items = [];
        for (const item of content.items || []) {
          if (!item?.str) continue;
          if (output.reduce((sum, entry) => sum + entry.items.length, 0) + items.length >= maxItems) {
            truncated = true;
            break;
          }
          const transform = pdfjs.Util.transform(viewport.transform, item.transform);
          const height = Math.max(1, Math.hypot(transform[2], transform[3]));
          items.push({
            text: item.str,
            x: Number(transform[4].toFixed(2)),
            top: Number((transform[5] - height).toFixed(2)),
            width: Number(Number(item.width || 0).toFixed(2)),
            height: Number(height.toFixed(2)),
            direction: item.dir || '',
            font: item.fontName || '',
          });
        }
        output.push({
          page: pageNumber,
          width: Number(viewport.width.toFixed(2)),
          height: Number(viewport.height.toFixed(2)),
          items,
        });
        if (truncated) break;
      } finally {
        try { page.cleanup?.(); } catch {}
      }
    }
    return { pageCount: document.numPages, pages: output, truncated };
  } finally {
    try { await document.destroy?.(); } catch {}
  }
}

export function evaluatePowerPointCategorySpacing(layout, categories = []) {
  const expected = [...new Set(categories.map((entry) => String(entry || '').trim()).filter(Boolean))];
  const rows = [];
  for (const page of layout?.pages || []) {
    const items = Array.isArray(page.items) ? page.items : [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      let text = String(item?.text || '').trim();
      if (!text) continue;
      if (!expected.includes(text)) {
        let nextIndex = index + 1;
        while (nextIndex < items.length && !String(items[nextIndex]?.text || '').trim()) nextIndex += 1;
        const next = items[nextIndex];
        if (next && Math.abs(Number(next.top) - Number(item.top)) <= 1) {
          const joined = `${text}${String(next.text || '').trim()}`;
          if (expected.includes(joined)) text = joined;
        }
      }
      if (!expected.includes(text)) continue;
      let row = rows.find((entry) => entry.page === page.page && Math.abs(entry.top - Number(item.top)) <= 1);
      if (!row) {
        row = { page: page.page, width: Number(page.width) || 0, top: Number(item.top), labels: [] };
        rows.push(row);
      }
      if (!row.labels.some((entry) => entry.text === text)) {
        row.labels.push({ text, x: Number(item.x) || 0 });
      }
    }
  }
  const complete = rows
    .filter((row) => expected.every((text) => row.labels.some((entry) => entry.text === text)))
    .map((row) => {
      const labels = expected
        .map((text) => row.labels.find((entry) => entry.text === text))
        .sort((left, right) => left.x - right.x);
      const gaps = labels.slice(1).map((entry, index) => entry.x - labels[index].x);
      return {
        ...row,
        labels,
        span: labels.length > 1 ? labels.at(-1).x - labels[0].x : 0,
        minimumGap: gaps.length ? Math.min(...gaps) : 0,
      };
    })
    .sort((left, right) => right.span - left.span);
  const best = complete[0] || null;
  const requiredGap = best ? best.width * 0.1 : 0;
  return {
    ok: expected.length <= 1 || Boolean(best && best.minimumGap >= requiredGap),
    categories: expected,
    page: best?.page || 0,
    labels: best?.labels || [],
    span: Number((best?.span || 0).toFixed(2)),
    minimumGap: Number((best?.minimumGap || 0).toFixed(2)),
    requiredGap: Number(requiredGap.toFixed(2)),
  };
}

function clusterRows(items, tolerance = 3) {
  const rows = [];
  for (const item of [...items].sort((left, right) => left.top - right.top || left.x - right.x)) {
    if (!String(item.text || '').trim()) continue;
    let row = rows.find((entry) => Math.abs(entry.top - item.top) <= tolerance);
    if (!row) {
      row = { top: item.top, cells: [] };
      rows.push(row);
    }
    row.cells.push(item);
    row.top = (row.top * (row.cells.length - 1) + item.top) / row.cells.length;
  }
  return rows.map((row) => ({
    top: Number(row.top.toFixed(2)),
    cells: row.cells.sort((left, right) => left.x - right.x).map((item) => ({
      text: item.text,
      x: item.x,
      width: item.width,
    })),
  }));
}

export function inferPdfTables(layout) {
  const tables = [];
  for (const page of layout.pages || []) {
    const rows = clusterRows(page.items || []).filter((row) => row.cells.length >= 2);
    if (rows.length < 2) continue;
    const counts = new Map();
    for (const row of rows) counts.set(row.cells.length, (counts.get(row.cells.length) || 0) + 1);
    const [columns, repeated] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0] || [0, 0];
    const selected = rows.filter((row) => Math.abs(row.cells.length - columns) <= 1);
    if (columns < 2 || selected.length < 2) continue;
    tables.push({
      page: page.page,
      columns,
      confidence: Number((repeated / rows.length).toFixed(3)),
      rows: selected.map((row) => row.cells.map((cell) => cell.text)),
      geometry: selected,
    });
  }
  return {
    pageCount: layout.pageCount,
    tableCount: tables.length,
    tables,
    truncated: layout.truncated === true,
  };
}

async function pdfImageBuffer(image) {
  if (!image?.data || !image.width || !image.height) return null;
  const channels = Math.round(image.data.length / (image.width * image.height));
  if (![1, 2, 3, 4].includes(channels)) return null;
  return await sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels },
  }).png().toBuffer();
}

function resolvedPdfObject(objects, name) {
  return new Promise((resolve, reject) => {
    try {
      objects.get(name, (value) => resolve(value));
    } catch (error) {
      reject(error);
    }
  });
}

export async function extractPdfImages(path, {
  pages = null,
  signal = null,
} = {}) {
  const { pdfjs, document } = await openPdfJs(path);
  const images = [];
  try {
    for (const pageNumber of selectedPages(document.numPages, pages)) {
      if (signal?.aborted) throw new Error('PDF image extraction was cancelled');
      const page = await document.getPage(pageNumber);
      try {
        const operators = await page.getOperatorList();
        const seen = new Set();
        for (let index = 0; index < operators.fnArray.length; index += 1) {
          const fn = operators.fnArray[index];
          if (![pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject].includes(fn)) continue;
          const args = operators.argsArray[index] || [];
          const key = fn === pdfjs.OPS.paintInlineImageXObject ? `inline-${index}` : String(args[0]);
          if (seen.has(key)) continue;
          seen.add(key);
          const image = fn === pdfjs.OPS.paintInlineImageXObject
            ? args[0]
            : await resolvedPdfObject(page.objs, args[0]);
          const data = await pdfImageBuffer(image);
          if (!data) continue;
          images.push({
            page: pageNumber,
            index: images.length + 1,
            width: image.width,
            height: image.height,
            mimeType: 'image/png',
            data: data.toString('base64'),
          });
        }
      } finally {
        try { page.cleanup?.(); } catch {}
      }
    }
    return {
      pageCount: document.numPages,
      imageCount: images.length,
      images: images.map(({ data, ...image }) => image),
      _images: images,
    };
  } finally {
    try { await document.destroy?.(); } catch {}
  }
}

export function parseOcrTsv(value) {
  const rows = String(value || '').split(/\r?\n/);
  if (!rows.length) return [];
  const header = rows.shift().split('\t');
  const position = Object.fromEntries(header.map((name, index) => [name, index]));
  return rows.map((line) => line.split('\t')).filter((columns) => columns.length >= header.length).map((columns) => ({
    text: columns[position.text] || '',
    confidence: Number(columns[position.conf] || -1),
    left: Number(columns[position.left] || 0),
    top: Number(columns[position.top] || 0),
    width: Number(columns[position.width] || 0),
    height: Number(columns[position.height] || 0),
  })).filter((word) => word.text.trim() && word.width > 0 && word.height > 0);
}

export function parseOcrBlocks(blocks) {
  const words = [];
  for (const block of blocks || []) {
    for (const paragraph of block?.paragraphs || []) {
      for (const line of paragraph?.lines || []) {
        for (const word of line?.words || []) {
          const bbox = word?.bbox || {};
          const left = Number(bbox.x0 || 0);
          const top = Number(bbox.y0 || 0);
          const width = Number(bbox.x1 || 0) - left;
          const height = Number(bbox.y1 || 0) - top;
          if (String(word?.text || '').trim() && width > 0 && height > 0) {
            words.push({
              text: String(word.text),
              confidence: Number(word.confidence || 0),
              left,
              top,
              width,
              height,
            });
          }
        }
      }
    }
  }
  return words;
}

async function existingPath(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return '';
}

async function ocrFontPath(explicit = '') {
  return await existingPath([
    explicit,
    process.env.MIXDOG_OCR_FONT,
    process.platform === 'win32' ? 'C:\\Windows\\Fonts\\malgun.ttf' : '',
    process.platform === 'darwin' ? '/System/Library/Fonts/AppleSDGothicNeo.ttc' : '',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ]);
}

export async function ocrPdf(path, operation, {
  dataDir,
  signal = null,
} = {}) {
  const source = await readFile(path);
  const document = await PDFDocument.load(source, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const pages = selectedPages(document.getPageCount(), operation.pages || (operation.page ? [operation.page] : null));
  const languages = Array.isArray(operation.languages)
    ? operation.languages.map(String).join('+')
    : String(operation.languages || 'eng+kor');
  const cachePath = join(dataDir, 'office', 'ocr', 'languages');
  await mkdir(cachePath, { recursive: true });
  const tesseract = require('tesseract.js');
  const worker = await tesseract.createWorker(languages, tesseract.OEM.LSTM_ONLY, {
    cachePath,
    gzip: true,
  });
  document.registerFontkit(fontkit);
  const fontPath = await ocrFontPath(operation.fontPath);
  const font = fontPath
    ? await document.embedFont(await readFile(fontPath), { subset: true })
    : await document.embedFont(StandardFonts.Helvetica);
  let wordCount = 0;
  let totalConfidence = 0;
  let text = '';
  const temporaryImages = [];
  try {
    for (const pageNumber of pages) {
      if (signal?.aborted) throw new Error('PDF OCR was cancelled');
      const rendered = await renderPdfPages(path, {
        pages: [pageNumber],
        maxWidth: Math.max(1200, Math.min(3200, Number(operation.maxWidth) || 2400)),
        signal,
      });
      const image = rendered.images[0];
      temporaryImages.push(image.path);
      const recognized = await worker.recognize(image.path, {}, { text: true, tsv: true, blocks: true });
      const positionedWords = parseOcrTsv(recognized.data.tsv);
      const words = (positionedWords.length ? positionedWords : parseOcrBlocks(recognized.data.blocks))
        .filter((word) => word.confidence >= Number(operation.minConfidence ?? 40));
      const page = document.getPage(pageNumber - 1);
      const scaleX = page.getWidth() / image.width;
      const scaleY = page.getHeight() / image.height;
      for (const word of words) {
        try {
          page.drawText(word.text, {
            x: word.left * scaleX,
            y: page.getHeight() - (word.top + word.height) * scaleY,
            size: Math.max(4, word.height * scaleY * 0.8),
            font,
            color: rgb(0, 0, 0),
            opacity: 0,
          });
          wordCount += 1;
          totalConfidence += word.confidence;
        } catch (error) {
          if (!fontPath && /encode|WinAnsi/i.test(String(error?.message || ''))) {
            throw new Error('OCR detected non-Latin text but no Unicode OCR font is available; add fontPath or MIXDOG_OCR_FONT');
          }
          throw error;
        }
      }
      text += `${text ? '\n\n' : ''}--- Page ${pageNumber} ---\n${recognized.data.text || ''}`;
    }
    if (wordCount > 0) await writeFile(path, await document.save({ useObjectStreams: true, addDefaultPage: false }));
    return {
      op: operation.op,
      changed: wordCount > 0,
      pages,
      languages,
      wordCount,
      averageConfidence: wordCount ? Number((totalConfidence / wordCount).toFixed(2)) : 0,
      text,
      searchableTextLayer: wordCount > 0,
      fontEmbedded: Boolean(fontPath),
    };
  } finally {
    await worker.terminate().catch(() => {});
    for (const image of temporaryImages) await rm(image, { force: true }).catch(() => {});
  }
}
