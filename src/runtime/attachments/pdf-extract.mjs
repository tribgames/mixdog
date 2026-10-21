/**
 * Bounded PDF inspection/text extraction shared by prompt intake and `read`.
 *
 * Native PDF-capable providers receive the original content-addressed file.
 * OpenAI-compatible providers without a document contract receive page-ordered
 * text extracted here, so they never see an unsupported inline Base64 block.
 */
import { stripTrailingReplacementChars } from '../shared/utf8-cut.mjs';
import { MAX_PDF_PAGES } from './limits.mjs';
import { resolvedPdfJs } from './pdfjs-runtime.mjs';

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** `value` cut to at most `maxBytes` of UTF-8, never inside a multi-byte sequence. */
export function boundedUtf8(value, maxBytes) {
  const buffer = Buffer.from(String(value || ''), 'utf8');
  if (buffer.length <= maxBytes) return { text: buffer.toString('utf8'), bytes: buffer.length, truncated: false };
  if (maxBytes <= 0) return { text: '', bytes: 0, truncated: true };
  const text = stripTrailingReplacementChars(buffer.subarray(0, maxBytes).toString('utf8'));
  return { text, bytes: Buffer.byteLength(text, 'utf8'), truncated: true };
}

// Where a text run sits on its line: the baseline identifies the line, and the
// start and end positions say whether the next run continues a word or stands
// apart from it. Rotated or skewed runs have no horizontal line to measure.
function runPlacement(item) {
  const transform = Array.isArray(item?.transform) ? item.transform.map(Number) : null;
  if (!transform || transform.length < 6 || transform.some((value) => !Number.isFinite(value))) return null;
  const [a, b, , d, e, f] = transform;
  if (b !== 0) return null;
  const size = Math.abs(d) || Math.abs(a) || 1;
  const width = Number(item.width);
  return {
    line: Math.round(f * 10) / 10,
    start: e,
    end: e + (Number.isFinite(width) ? width : 0),
    size,
  };
}

// One page's text. pdf.js marks where each text line ends; keeping that as a
// newline preserves paragraphs and table rows instead of one long run.
function pageBodyText(content) {
  let body = '';
  let cursor = null;
  for (const item of content?.items || []) {
    if (typeof item?.str !== 'string') continue;
    if (item.str) {
      const placement = runPlacement(item);
      // A run on another baseline is another line even when the writer marked no line end (a browser's
      // print does not): "784" over its label read as "784office". A baseline shift under half the
      // smaller run's size (a superscript, a mixed-size run) stays on the line.
      const shift = placement && cursor ? Math.abs(placement.line - cursor.line) : 0;
      const newLine = shift > Math.min(placement?.size || 0, cursor?.size || 0) * 0.5;
      if (newLine && body && !body.endsWith('\n')) body += '\n';
      // A writer splits one word into several runs for kerning, and a
      // Korean line into a run per token; joining those with a space
      // invents "2026 년". Only a gap the page itself leaves is a space.
      const separated =
        placement && cursor && !newLine ? placement.start - cursor.end > cursor.size * 0.22 : !placement || !cursor;
      const glued = !body || body.endsWith('\n') || body.endsWith(' ') || item.str.startsWith(' ') || !separated;
      body += (glued ? '' : ' ') + item.str;
      cursor = placement;
    }
    if (item.hasEOL && !body.endsWith('\n')) {
      body += '\n';
      cursor = null;
    }
  }
  return body
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The deadline prompt intake passes: it runs inside a room's post queue, which
 *  a document that never loads would otherwise hold forever. */
export const PDF_INTAKE_TIMEOUT_MS = 60_000;

// A page counts as carrying a text layer when its extracted text holds at
// least this many non-whitespace characters. A scan often keeps a stamped page
// number or a few stray glyphs; those alone do not make its content readable
// as text, so such a page still needs its image (or OCR).
export const PDF_TEXT_LAYER_MIN_CHARS = 16;

/** Whether one page's extracted text is a real text layer (see above). */
export function pageHasTextLayer(text) {
  return String(text || '').replace(/\s+/g, '').length >= PDF_TEXT_LAYER_MIN_CHARS;
}

function timeoutError(timeoutMs) {
  return Object.assign(new Error(`PDF inspection timed out after ${timeoutMs} ms`), {
    code: 'PDF_INSPECTION_TIMEOUT',
  });
}

/** Inspect a PDF. With `timeoutMs`, a document that has not finished by then
 *  is destroyed and the call rejects (`code: 'PDF_INSPECTION_TIMEOUT'`);
 *  without it there is no deadline. */
export async function inspectPdfBuffer(buffer, { timeoutMs = null, ...options } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new TypeError('PDF payload is empty');
  const hold = { pdf: null, expired: false };
  if (!(timeoutMs > 0)) return inspectLoaded(buffer, options, hold);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      hold.expired = true;
      // A document still loading is destroyed as soon as it arrives (below).
      Promise.resolve(hold.pdf?.destroy?.()).catch(() => {});
      reject(timeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([inspectLoaded(buffer, options, hold), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function inspectLoaded(
  buffer,
  {
    extractText = false,
    measureText = false,
    maxPages = MAX_PDF_PAGES,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    pageRange = null,
    password = '',
  },
  hold
) {
  await resolvedPdfJs();
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer), password ? { password: String(password) } : {});
  hold.pdf = pdf;
  try {
    if (hold.expired) throw timeoutError(0);
    const pageCount = Math.max(0, Number(pdf?.numPages) || 0);
    const pageLimit = Number.isFinite(Number(maxPages)) ? Math.max(1, Math.floor(Number(maxPages))) : Infinity;
    if (pageCount > pageLimit) {
      throw new RangeError(`PDF has ${pageCount} pages; maximum supported attachment is ${pageLimit} pages`);
    }
    if (measureText) return { pageCount, ...(await measureTextLayer(pdf, pageCount, hold)) };
    if (!extractText) return { pageCount, text: '', truncated: false };

    const from = Math.max(1, Number(pageRange?.from) || 1);
    const to = Math.min(pageCount, Math.max(from, Number(pageRange?.to) || pageCount));
    const byteLimit = Math.max(1, Number(maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES);
    const chunks = [];
    // Each page's own text (before the output budget cuts it), so a caller can
    // tell text pages from scanned ones.
    const pages = [];
    let bytes = 0;
    let truncated = false;
    for (let pageNumber = from; pageNumber <= to; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const body = pageBodyText(await page.getTextContent());
        pages.push({ page: pageNumber, text: body });
        const block = `--- Page ${pageNumber} ---\n${body || '(no extractable text on this page)'}`;
        const separatorBytes = chunks.length ? 2 : 0;
        const remaining = byteLimit - bytes - separatorBytes;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const bounded = boundedUtf8(block, remaining);
        if (chunks.length) {
          chunks.push('\n\n');
          bytes += 2;
        }
        chunks.push(bounded.text);
        bytes += bounded.bytes;
        if (bounded.truncated) {
          truncated = true;
          break;
        }
      } finally {
        try {
          page.cleanup?.();
        } catch {}
      }
    }
    if (truncated) {
      const suffix = '\n\n... [PDF text truncated to the prompt input budget]';
      const room = Math.max(0, byteLimit - Buffer.byteLength(suffix, 'utf8'));
      const bounded = boundedUtf8(chunks.join(''), room);
      return { pageCount, text: `${bounded.text}${suffix}`, truncated: true, pages };
    }
    return { pageCount, text: chunks.join(''), truncated: false, pages };
  } finally {
    try {
      await pdf.destroy?.();
    } catch {}
  }
}

// How much of the document reads as text: the pages that carry a text layer
// and the characters they hold. Nothing is kept but the counts.
async function measureTextLayer(pdf, pageCount, hold) {
  let textPages = 0;
  let textChars = 0;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    if (hold.expired) throw timeoutError(0);
    const page = await pdf.getPage(pageNumber);
    try {
      const body = pageBodyText(await page.getTextContent());
      if (pageHasTextLayer(body)) {
        textPages += 1;
        textChars += body.length;
      }
    } finally {
      try {
        page.cleanup?.();
      } catch {}
    }
  }
  return { textPages, textChars };
}
