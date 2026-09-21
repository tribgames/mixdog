// PDF OCR: tesseract TSV/block parsing, readiness probe and the ocr operation.
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import { SAVE_OPTIONS } from './pdf-draw.mjs';
import { embedDocumentFont, fontCovers } from './pdf-fonts.mjs';
import { renderPdfPages } from './pdf-render.mjs';
import { selectedPages } from './pdf-document.mjs';

const require = createRequire(import.meta.url);

// The engine's own column order. Tesseract writes this table with a header
// row through its command line and without one through the worker API, so the
// reader accepts both: taking the first data row as a header dropped that word
// and left every lookup undefined, which is an empty result, not an error.
const OCR_TSV_COLUMNS = Object.freeze([
  'level',
  'page_num',
  'block_num',
  'par_num',
  'line_num',
  'word_num',
  'left',
  'top',
  'width',
  'height',
  'conf',
  'text',
]);

function ocrTsvRows(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (!lines.length) return { at: {}, rows: [] };
  const first = lines[0].split('\t');
  const headed = first.includes('text') && first.includes('conf');
  const at = headed
    ? Object.fromEntries(first.map((name, index) => [name, index]))
    : Object.fromEntries(OCR_TSV_COLUMNS.map((name, index) => [name, index]));
  const rows = (headed ? lines.slice(1) : lines)
    .map((line) => line.split('\t'))
    .filter((columns) => columns.length >= OCR_TSV_COLUMNS.length);
  return { at, rows };
}

function ocrTsvWord(columns, at) {
  return {
    text: columns[at.text] || '',
    confidence: Number(columns[at.conf] || -1),
    left: Number(columns[at.left] || 0),
    top: Number(columns[at.top] || 0),
    width: Number(columns[at.width] || 0),
    height: Number(columns[at.height] || 0),
  };
}

export function parseOcrTsv(value) {
  const { at, rows } = ocrTsvRows(value);
  if (at.text === undefined) return [];
  return rows
    .map((columns) => ocrTsvWord(columns, at))
    .filter((word) => word.text.trim() && word.width > 0 && word.height > 0);
}

// One text line per recognized row, with the words that belong to it.
//
// A word box is where ink sits, not where a word begins and ends: Korean and
// CJK come back split at syllable boundaries ("출" "고" "율" for 출고율) while a
// real word break can measure a single pixel. Geometry therefore cannot rebuild
// the line, but the engine's own line text can — it is the reading the OCR
// result already reports. The rows and the text come back in the same order, so
// a line takes that text when it carries exactly the same characters, and falls
// back to its word boxes when it does not.
// The word boxes of each OCR line, keyed by the engine's page/block/paragraph/line ids.
function ocrLineGroups(rows, at) {
  const groups = new Map();
  for (const columns of rows) {
    const word = ocrTsvWord(columns, at);
    if (!word.text.trim() || !(word.width > 0) || !(word.height > 0)) continue;
    const key = [at.page_num, at.block_num, at.par_num, at.line_num].map((index) => columns[index]).join('/');
    const group = groups.get(key) || { words: [] };
    group.words.push(word);
    groups.set(key, group);
  }
  return [...groups.values()];
}

// A line whose boxes were all discarded leaves its reading without a group,
// and pairing by position then hands every later line the text of its
// predecessor — one dropped line makes the rest of the page fall back to its
// word boxes. A reading is therefore taken from the next line that carries
// exactly these characters, never from one that differs.
function spokenReader(plainText) {
  const spoken = String(plainText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const compact = (line) => line.replace(/\s+/g, '');
  let spokenAt = 0;
  return (joined) => {
    const target = compact(joined);
    if (!target) return '';
    for (let at = spokenAt; at < spoken.length; at += 1) {
      if (compact(spoken[at]) !== target) continue;
      spokenAt = at + 1;
      return spoken[at];
    }
    return '';
  };
}

function ocrLine(group, spokenReading) {
  const words = group.words.slice().sort((left, right) => left.left - right.left);
  const left = Math.min(...words.map((word) => word.left));
  const top = Math.min(...words.map((word) => word.top));
  const width = Math.max(...words.map((word) => word.left + word.width)) - left;
  const height = Math.max(...words.map((word) => word.top + word.height)) - top;
  const joined = words.map((word) => word.text).join(' ');
  const engine = spokenReading(joined);
  // The widest space between two boxes on this row. A column gap means the
  // row is really two, and one stretched run would put every character in it
  // at the wrong place.
  const columnGap = words.slice(1).reduce((widest, word, position) => {
    const previous = words[position];
    return Math.max(widest, word.left - (previous.left + previous.width));
  }, 0);
  return {
    text: engine || joined,
    fromEngine: Boolean(engine),
    words,
    left,
    top,
    width,
    height,
    columnGap,
  };
}

export function ocrTextLines(value, plainText = '') {
  const { at, rows } = ocrTsvRows(value);
  if (['line_num', 'left', 'text'].some((name) => at[name] === undefined)) return [];
  const spokenReading = spokenReader(plainText);
  return ocrLineGroups(rows, at).map((group) => ocrLine(group, spokenReading));
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

// Whether a scanned page can be read here and now. The engine ships with the
// runtime, but each language's data is downloaded on first use and kept in the
// cache: promising OCR of a Korean scan on a machine with no network and no
// cached kor data fails in the middle of the task instead of before it.
export async function pdfOcrReadiness(dataDir) {
  const cachePath = join(dataDir, 'office', 'ocr', 'languages');
  let available = true;
  try {
    require.resolve('tesseract.js');
  } catch {
    available = false;
  }
  let languages = [];
  try {
    languages = (await readdir(cachePath))
      .map((name) => /^(.+?)\.traineddata(?:\.gz)?$/.exec(name)?.[1])
      .filter(Boolean)
      .sort();
  } catch {}
  return {
    available,
    backend: 'tesseract',
    cachedLanguages: languages,
    cachePath,
    note: 'A language not listed is downloaded on first use; without network access only the cached ones work.',
  };
}

// Renders and recognizes one page; the rendered image path is recorded on
// `temporaryImages` for cleanup.
async function recognizePage(worker, path, pageNumber, operation, signal, temporaryImages) {
  const rendered = await renderPdfPages(path, {
    pages: [pageNumber],
    maxWidth: Math.max(1200, Math.min(3200, Number(operation.maxWidth) || 2400)),
    signal,
  });
  const image = rendered.images[0];
  temporaryImages.push(image.path);
  const recognized = await worker.recognize(image.path, {}, { text: true, tsv: true, blocks: true });
  const lines = ocrTextLines(recognized.data.tsv, recognized.data.text);
  const minConfidence = Number(operation.minConfidence ?? 40);
  const words = (lines.length ? lines.flatMap((line) => line.words) : parseOcrBlocks(recognized.data.blocks)).filter(
    (word) => word.confidence >= minConfidence
  );
  return { pageNumber, image, lines, words, text: recognized.data.text || '' };
}

// One font for all the recognized text: Helvetica when it is Latin, an
// installed Unicode face otherwise. OCR noise can contain glyphs no installed
// face has; keep the words a font does cover rather than failing the whole
// page.
async function selectOcrFont(document, operation, recognizedPages) {
  const coverage = recognizedPages.flatMap((entry) => entry.words.map((word) => word.text)).join(' ');
  try {
    return await embedDocumentFont(document, { fontPath: operation.fontPath, text: coverage });
  } catch (error) {
    if (operation.fontPath) throw error;
    return await embedDocumentFont(document, { text: '' });
  }
}

// Draws the invisible text layer for one page onto the document, whole lines
// where the row is intact and single words otherwise; counts land on `tally`.
function placeRecognizedText(document, { pageNumber, image, lines, words }, font, minConfidence, tally) {
  const page = document.getPage(pageNumber - 1);
  const scaleX = page.getWidth() / image.width;
  const scaleY = page.getHeight() / image.height;
  // Fit the invisible text to its box in both directions so extraction reads
  // it as one phrase and layout queries land where the picture shows it.
  const place = (value, box) => {
    const naturalWidth = font.widthOfTextAtSize(value, 1);
    const byWidth = naturalWidth > 0 ? (box.width * scaleX) / naturalWidth : Infinity;
    page.drawText(value, {
      x: box.left * scaleX,
      y: page.getHeight() - (box.top + box.height) * scaleY,
      size: Math.max(3, Math.min(box.height * scaleY * 0.8, byWidth)),
      font,
      color: rgb(0, 0, 0),
      opacity: 0,
    });
  };
  const settled = new Set();
  for (const line of lines) {
    const kept = line.words.filter((word) => word.confidence >= minConfidence);
    // A dropped word, a column gap, or a glyph the font lacks sends this row
    // back to its boxes: a stretched run would then carry text the page does
    // not show, or show it in the wrong place.
    if (kept.length !== line.words.length) continue;
    if (line.columnGap > line.height * 1.5) continue;
    if (!line.text || !fontCovers(font, line.text)) continue;
    place(line.text, line);
    for (const word of line.words) settled.add(word);
    tally.wordCount += kept.length;
    tally.totalConfidence += kept.reduce((sum, word) => sum + word.confidence, 0);
  }
  for (const word of words) {
    if (settled.has(word)) continue;
    if (!fontCovers(font, word.text)) {
      tally.skippedWords += 1;
      continue;
    }
    place(word.text, word);
    tally.wordCount += 1;
    tally.totalConfidence += word.confidence;
  }
}

async function createOcrWorker(operation, dataDir) {
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
  return { worker, languages };
}

function ocrResult(operation, { pages, languages, text, tally, fontPath, embedded }) {
  const { wordCount, skippedWords, totalConfidence } = tally;
  return {
    op: operation.op,
    changed: wordCount > 0,
    pages,
    languages,
    wordCount,
    ...(skippedWords
      ? { skippedWords, skippedReason: 'no installed font has glyphs for these words; pass fontPath to keep them' }
      : {}),
    averageConfidence: wordCount ? Number((totalConfidence / wordCount).toFixed(2)) : 0,
    text,
    searchableTextLayer: wordCount > 0,
    fontEmbedded: embedded,
    ...(fontPath ? { fontPath } : {}),
  };
}

export async function ocrPdf(path, operation, { dataDir, signal = null } = {}) {
  const source = await readFile(path);
  const document = await PDFDocument.load(source, {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const pages = selectedPages(document.getPageCount(), operation.pages || (operation.page ? [operation.page] : null));
  const { worker, languages } = await createOcrWorker(operation, dataDir);
  const tally = { wordCount: 0, skippedWords: 0, totalConfidence: 0 };
  let text = '';
  const temporaryImages = [];
  const recognizedPages = [];
  try {
    // Recognize every page first so one font can be chosen for all the text
    // it produced.
    for (const pageNumber of pages) {
      if (signal?.aborted) throw new Error('PDF OCR was cancelled');
      const recognized = await recognizePage(worker, path, pageNumber, operation, signal, temporaryImages);
      recognizedPages.push(recognized);
      text += `${text ? '\n\n' : ''}--- Page ${pageNumber} ---\n${recognized.text}`;
    }
    const { font, fontPath, embedded } = await selectOcrFont(document, operation, recognizedPages);
    const minConfidence = Number(operation.minConfidence ?? 40);
    for (const entry of recognizedPages) placeRecognizedText(document, entry, font, minConfidence, tally);
    if (tally.wordCount > 0) {
      await writeFile(path, await document.save(SAVE_OPTIONS));
    }
    return ocrResult(operation, { pages, languages, text, tally, fontPath, embedded });
  } finally {
    await worker.terminate().catch(() => {});
    for (const image of temporaryImages) await rm(image, { force: true }).catch(() => {});
  }
}
