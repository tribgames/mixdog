import { readFile, stat } from 'node:fs/promises';
import { MAX_PDF_BYTES, isPdfBuffer } from '../../../../attachments/limits.mjs';
import { READ_PDF_MAX_PAGES_PER_CALL } from '../../../../attachments/attachment-reference.mjs';
import { READ_MAX_SIZE_BYTES } from './read-constants.mjs';
import { capMarker } from './tool-output-limit.mjs';
import { imageBlocksFromBuffer } from './read-image-resize.mjs';
import { boundedUtf8, inspectPdfBuffer, pageHasTextLayer } from '../../../../attachments/pdf-extract.mjs';

const DEFAULT_READ_MAX_OUTPUT_BYTES = 100 * 1024;

// A whole-PDF read (no pages) returns a PDF of up to this many pages whole —
// as the canonical base64 document block for a model that reads PDFs natively
// (providers convert it to their native file shape; MAX_PDF_BYTES keeps it
// under the request cap). A longer PDF returns its outline and first pages:
// the model then reads the pages it needs.
const PDF_WHOLE_READ_MAX_PAGES = 10;
const PDF_PREVIEW_PAGES = 5;
// Scanned pages render at this width: past the point where text in a page
// image stays legible, below the vision ceiling that would downscale it again.
const PDF_PAGE_IMAGE_WIDTH = 1200;
// The renderer takes at most 12 explicit pages per call.
const PDF_RENDER_BATCH = 12;

// Per-output text ceiling inside a notebook. A single cell output larger than
// this is replaced with a jq hint (large-notebook guidance) so a
// runaway stdout / data dump can't blow the read budget.
const IPYNB_OUTPUT_MAX_CHARS = 10_000;

// Validate / parse a pages arg ("N" or "N-M", 1-based, span <=20). Returns
// { filter } on success, { error } (a string) on rejection, or { filter: null }
// when no pages arg was supplied.
function parsePagesArg(pagesArg) {
  if (pagesArg == null || pagesArg === '') return { filter: null };
  if (typeof pagesArg !== 'string') {
    return { error: `Error: pages must be a string like "1-5"; got ${typeof pagesArg}` };
  }
  const trimmed = pagesArg.trim();
  const m = trimmed.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) {
    return { error: `Error: pages "${trimmed}" not in "N" or "N-M" form (1-based positive integers)` };
  }
  const from = parseInt(m[1], 10);
  const to = m[2] ? parseInt(m[2], 10) : from;
  if (from < 1 || to < 1) {
    return { error: `Error: pages "${trimmed}" out of range — page numbers are 1-based` };
  }
  if (to < from) {
    return { error: `Error: pages "${trimmed}" inverted — end (${to}) precedes start (${from})` };
  }
  if (to - from + 1 > READ_PDF_MAX_PAGES_PER_CALL) {
    return {
      error: `Error: pages "${trimmed}" spans ${to - from + 1} pages; max ${READ_PDF_MAX_PAGES_PER_CALL} per request — narrow the range`,
    };
  }
  return { filter: { from, to } };
}

// PDF.js text extraction for a file without the %PDF- signature: pdf.js
// surfaces the parse error as text instead of a document block.
async function extractPdfTextBody(fullPath, pageFilter, maxOutputBytes) {
  const buf = await readFile(fullPath);
  const result = await inspectPdfBuffer(buf, {
    extractText: true,
    maxPages: Infinity,
    maxOutputBytes,
    pageRange: pageFilter,
  });
  return result.text || '(no text content extracted from PDF)';
}

// Bounded UTF-8 cut for the text a paged read returns.
function capPdfText(text, maxOutputBytes) {
  const bounded = boundedUtf8(text, maxOutputBytes);
  if (!bounded.truncated) return text;
  return `${bounded.text}\n\n${capMarker({ limit: maxOutputBytes, shown: 'PDF text cut', narrow: 'read a narrower pages range' })}`;
}

async function renderPdfPageImages(fullPath, pages, signal) {
  const { renderPdfPages } = await import('../../../../office/pdf/pdf-render.mjs');
  const out = [];
  for (let offset = 0; offset < pages.length; offset += PDF_RENDER_BATCH) {
    const rendered = await renderPdfPages(fullPath, {
      pages: pages.slice(offset, offset + PDF_RENDER_BATCH),
      maxWidth: PDF_PAGE_IMAGE_WIDTH,
      signal,
      writeImages: false,
    });
    out.push(...rendered.images);
  }
  return out;
}

async function recognizePdfPages(fullPath, pages, signal) {
  const [{ recognizePdfPageTexts }, { defaultOfficeDataDir }] = await Promise.all([
    import('../../../../office/pdf/pdf-ocr.mjs'),
    import('../../../../office/core/journal.mjs'),
  ]);
  return recognizePdfPageTexts(fullPath, pages, { dataDir: defaultOfficeDataDir(), signal });
}

function pageList(pages) {
  return pages.length > 6 ? `${pages.slice(0, 6).join(', ')}, …` : pages.join(', ');
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function pdfFileLabel(fullPath) {
  return fullPath.split(/[\\/]/).pop();
}

// The scanned pages of one paged read, as page images or OCR text. A page the
// renderer or the OCR engine cannot produce says so instead of failing the
// whole read: the text pages are still returned.
async function scannedPageBodies(fullPath, scanned, { pageMode, signal, renderPages, recognizePages }) {
  const bodies = new Map();
  if (!scanned.length) return bodies;
  if (pageMode === 'text') {
    for (const page of scanned) {
      bodies.set(page, {
        text: `(no text layer: a scanned page. Read this PDF on its own with pages="${page}" to see it as an image or OCR text.)`,
      });
    }
    return bodies;
  }
  if (pageMode === 'image') {
    try {
      for (const image of await renderPages(fullPath, scanned, signal)) {
        bodies.set(image.page, { image });
      }
    } catch (error) {
      for (const page of scanned) {
        bodies.set(page, { text: `(no text layer, and the page image could not be rendered: ${errorText(error)})` });
      }
    }
    return bodies;
  }
  try {
    for (const { page, text } of await recognizePages(fullPath, scanned, signal)) {
      bodies.set(page, { ocr: text || '(OCR found no text on this page)' });
    }
  } catch (error) {
    const note =
      `(no text layer, and OCR is unavailable here: ${errorText(error)}. OCR language data downloads on first ` +
      'use, so this needs a network connection once; after that it works offline. A model that accepts images ' +
      'can read these pages as page images instead.)';
    for (const page of scanned) bodies.set(page, { text: note });
  }
  return bodies;
}

// One page range: text pages as their text, scanned pages (no text layer) as
// page images for a model that reads images, OCR text for a text-only model,
// or a note in a flat-text context. Order follows the pages.
async function readPdfPageRange(fullPath, buf, pageCount, range, options) {
  const { maxOutputBytes, note = '' } = options;
  const extracted = await inspectPdfBuffer(buf, {
    extractText: true,
    maxPages: Infinity,
    maxOutputBytes,
    pageRange: range,
  });
  const scanned = extracted.pages.filter((entry) => !pageHasTextLayer(entry.text)).map((entry) => entry.page);
  const bodies = await scannedPageBodies(fullPath, scanned, options);
  const label = pdfFileLabel(fullPath);
  const textPages = extracted.pages.length - scanned.length;
  const header =
    `[PDF ${label}: pages ${range.from}-${range.to} of ${pageCount}; ` +
    `${textPages === extracted.pages.length ? 'every page has a text layer' : `scanned (no text layer): ${pageList(scanned)}`}` +
    `${note ? `. ${note}` : ''}]`;
  const blocks = [];
  let text = header;
  let textBytes = 0;
  const flush = () => {
    if (!text) return;
    blocks.push({ type: 'text', text: capPdfText(text, Math.max(1, maxOutputBytes - textBytes)) });
    textBytes += Buffer.byteLength(text, 'utf8');
    text = '';
  };
  for (const entry of extracted.pages) {
    const body = bodies.get(entry.page);
    if (body?.image) {
      text += `${text ? '\n\n' : ''}--- Page ${entry.page} (scanned; page image follows) ---`;
      flush();
      const { data, mimeType, width, height } = body.image;
      blocks.push({ type: 'image', data, mimeType, width, height });
      continue;
    }
    let pageText = entry.text;
    let title = `--- Page ${entry.page} ---`;
    if (body?.ocr) {
      title = `--- Page ${entry.page} (OCR of a scanned page) ---`;
      pageText = body.ocr;
    } else if (body?.text) {
      pageText = body.text;
    }
    text += `${text ? '\n\n' : ''}${title}\n${pageText}`;
  }
  flush();
  if (blocks.every((block) => block.type === 'text')) return blocks.map((block) => block.text).join('\n\n');
  return { content: blocks };
}

function pdfInspectError(fullPath, error) {
  const label = pdfFileLabel(fullPath);
  const protectedPdf = error?.name === 'PasswordException' || /password/i.test(String(error?.message || ''));
  return protectedPdf
    ? `Error: this PDF is password-protected and cannot be read (${label}).`
    : `Error: ${label} is not a valid PDF (${errorText(error)}).`;
}

/**
 * Reads a PDF: whole for a short one, by page range otherwise.
 *
 * pages "N" / "N-M" (≤20) reads that range: text first; pages without a text
 * layer come back as page images (`pageMode: 'image'`, a model that sees
 * images), OCR text (`pageMode: 'ocr'`, a text-only model) or a note
 * (`textOnly`, a batch that must stay flat text). Without pages a PDF of up to
 * 10 pages is returned whole (a document block when `nativeDocument`, the
 * model reading PDFs natively, else every page through the range path), a
 * longer one as the outline and its first 5 pages. offset/limit do not apply.
 */
export async function extractPdfText(
  fullPath,
  pagesArg,
  {
    maxOutputBytes = DEFAULT_READ_MAX_OUTPUT_BYTES,
    textOnly = false,
    pageMode = 'image',
    nativeDocument = true,
    signal = null,
    renderPages = renderPdfPageImages,
    recognizePages = recognizePdfPages,
  } = {}
) {
  try {
    let pdfStat;
    try {
      pdfStat = await stat(fullPath);
    } catch (e) {
      return `Error: pdf stat failed — ${errorText(e)}`;
    }

    const pages = parsePagesArg(pagesArg);
    if (pages.error) return pages.error;

    const buf = await readFile(fullPath);
    // Not a real PDF (mislabelled extension) — pdf.js surfaces a clean parse
    // error rather than a bad document block entering history.
    if (!isPdfBuffer(buf)) return await extractPdfTextBody(fullPath, pages.filter, maxOutputBytes);
    // A password-protected or invalid PDF is rejected by every provider and
    // would wedge the session if it entered history as a block.
    let pageCount;
    try {
      ({ pageCount } = await inspectPdfBuffer(buf, { maxPages: Infinity }));
    } catch (inspectErr) {
      return pdfInspectError(fullPath, inspectErr);
    }
    const mode = textOnly ? 'text' : pageMode;
    const rangeOptions = { maxOutputBytes, pageMode: mode, signal, renderPages, recognizePages };
    if (pages.filter) {
      if (pages.filter.from > pageCount) {
        return `Error: pages "${pagesArg}" out of range — this PDF has ${pageCount} page${pageCount === 1 ? '' : 's'}`;
      }
      const range = { from: pages.filter.from, to: Math.min(pages.filter.to, pageCount) };
      return await readPdfPageRange(fullPath, buf, pageCount, range, rangeOptions);
    }
    if (pageCount > PDF_WHOLE_READ_MAX_PAGES) {
      return await readPdfPageRange(
        fullPath,
        buf,
        pageCount,
        { from: 1, to: PDF_PREVIEW_PAGES },
        {
          ...rangeOptions,
          note: `Showing the first ${PDF_PREVIEW_PAGES} pages; pass pages (e.g. "${PDF_PREVIEW_PAGES + 1}-${Math.min(pageCount, PDF_PREVIEW_PAGES + 10)}", up to ${READ_PDF_MAX_PAGES_PER_CALL} per call) to read the pages the request needs`,
        }
      );
    }
    // A short PDF whole: a model that reads PDFs natively gets the canonical
    // document block (figures, layout, tables) with its page and text-layer
    // counts for the estimate; others get every page through the range path.
    if (mode === 'image' && nativeDocument && pdfStat.size <= MAX_PDF_BYTES) {
      const { textPages, textChars } = await inspectPdfBuffer(buf, { maxPages: Infinity, measureText: true });
      return {
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: buf.toString('base64'),
            },
            pageCount,
            textPages,
            textChars,
          },
        ],
      };
    }
    return await readPdfPageRange(fullPath, buf, pageCount, { from: 1, to: Math.max(1, pageCount) }, rangeOptions);
  } catch (err) {
    return `Error: PDF extraction failed — ${errorText(err)}`;
  }
}

const joinedNotebookText = (value) => (Array.isArray(value) ? value.join('') : value);

// A code cell's source followed by its outputs as text: text outputs inline
// (a single huge one replaced with a jq hint rather than dumped), image
// outputs as placeholders plus the images to embed AFTER the code block.
function renderIpynbCodeCell(cell, cellIndex, fullPath) {
  let block = joinedNotebookText(cell.source) || '';
  const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
  const pendingImages = [];
  for (const out of outputs) {
    const data = out.data || {};
    if (data['text/plain'] || out.text) {
      const rawTxt = joinedNotebookText(data['text/plain'] || out.text);
      if (typeof rawTxt === 'string' && rawTxt.length > IPYNB_OUTPUT_MAX_CHARS) {
        block += `\n# Output: [large output omitted — ${rawTxt.length} chars; inspect with: cat "${fullPath}" | jq '.cells[${cellIndex}].outputs']`;
      } else {
        block += `\n# Output:\n${rawTxt}`;
      }
    } else if (data['image/png'] || data['image/jpeg']) {
      const isPng = !!data['image/png'];
      const b64 = joinedNotebookText(isPng ? data['image/png'] : data['image/jpeg']);
      pendingImages.push({ mimeType: isPng ? 'image/png' : 'image/jpeg', b64 });
      block += `\n# Output: [image output — cell ${cellIndex}]`;
    }
  }
  return { block, pendingImages };
}

// Keeps text blocks until `maxOutputBytes` of text, cutting the one that
// crosses it, then marks the cut. Image blocks pass through uncounted.
function capNotebookText(blocks, maxOutputBytes) {
  let running = 0;
  const capped = [];
  let truncated = false;
  for (const b of blocks) {
    if (b.type !== 'text') {
      capped.push(b);
      continue;
    }
    if (running >= maxOutputBytes) {
      truncated = true;
      continue;
    }
    if (running + b.text.length > maxOutputBytes) {
      capped.push({ type: 'text', text: b.text.slice(0, maxOutputBytes - running) });
      running = maxOutputBytes;
      truncated = true;
    } else {
      capped.push(b);
      running += b.text.length;
    }
  }
  if (truncated) {
    capped.push({
      type: 'text',
      text: `\n\n${capMarker({ limit: maxOutputBytes, shown: 'notebook cells cut', narrow: 'grep the notebook for the cell text you need' })}`,
    });
  }
  return capped;
}

// The image blocks (each after its resize note, when it has one) for one
// cell's image outputs. An image the resize helper cannot take (sharp
// unavailable) stays the text placeholder already in the cell's text.
async function notebookImageBlocks(pendingImages, fullPath, cellIndex) {
  const blocks = [];
  for (const img of pendingImages) {
    let buf;
    try {
      buf = Buffer.from(img.b64, 'base64');
    } catch {
      buf = null;
    }
    if (!buf || buf.length === 0) continue;
    const built = await imageBlocksFromBuffer(buf, img.mimeType, {
      sourcePath: `${fullPath} [cell ${cellIndex}]`,
    });
    if (built) {
      if (built.textBlock) blocks.push(built.textBlock);
      blocks.push(built.imageBlock);
    }
  }
  return blocks;
}

export async function extractIpynbText(
  fullPath,
  { maxOutputBytes = DEFAULT_READ_MAX_OUTPUT_BYTES, hasRangeArgs = false, textOnly = false } = {}
) {
  // Range args (offset/limit/line) don't map cleanly onto a Jupyter
  // notebook: cells aren't line-addressable in the source JSON, so applying
  // offset:200 against rendered code+markdown would slice mid-cell without
  // matching the line numbers a follow-up `edit` would target. Refuse the
  // range up front and direct the caller to the underlying .ipynb JSON.
  if (hasRangeArgs) {
    return 'Error: range args (offset/limit/line) are not supported for .ipynb extraction — cells are not line-addressable; rename to .json or call read on a converted file for line-level access';
  }
  try {
    let nbStat;
    try {
      nbStat = await stat(fullPath);
    } catch (e) {
      return `Error: ipynb stat failed — ${errorText(e)}`;
    }
    if (nbStat.size > READ_MAX_SIZE_BYTES) {
      return `Error: notebook too large (size: ${nbStat.size}B, cap: ${READ_MAX_SIZE_BYTES}B) — use a cell range to narrow`;
    }
    const raw = await readFile(fullPath, 'utf-8');
    const nb = JSON.parse(raw);
    const cells = Array.isArray(nb.cells) ? nb.cells : [];

    // Accumulate rendered cells as text, flushing to a text block whenever
    // an image output is hit so block ORDER matches notebook order.
    const blocks = [];
    const textParts = [];
    let textLen = 0;
    const flushText = () => {
      if (textParts.length === 0) return;
      blocks.push({ type: 'text', text: textParts.join('\n\n') });
      textParts.length = 0;
    };
    const pushText = (s) => {
      textParts.push(s);
      textLen += s.length;
    };

    let cellIndex = -1;
    for (const cell of cells) {
      cellIndex += 1;
      if (cell.cell_type === 'markdown') {
        pushText(joinedNotebookText(cell.source) || '');
      } else if (cell.cell_type === 'code') {
        const { block, pendingImages } = renderIpynbCodeCell(cell, cellIndex, fullPath);
        pushText(`\`\`\`python\n${block}\n\`\`\``);
        // Embed each image output as a real image block (resized via the
        // shared helper). On fallback (sharp absent / decode failure) the
        // image is left as the text placeholder already in `block`.
        // textOnly (batch context) skips embedding entirely — the text
        // placeholder in `block` is the only representation.
        if (!textOnly && pendingImages.length > 0) {
          flushText();
          blocks.push(...(await notebookImageBlocks(pendingImages, fullPath, cellIndex)));
        }
      }
    }
    flushText();

    // Output-byte cap on the combined TEXT. Image blocks are not counted
    // (they're already size-bounded by the resize helper).
    if (textLen > maxOutputBytes) {
      const capped = capNotebookText(blocks, maxOutputBytes);
      blocks.length = 0;
      blocks.push(...capped);
    }

    const hasImageBlock = blocks.some((b) => b.type === 'image');
    if (blocks.length === 0) return '(empty notebook)';
    // No embedded images → return the joined TEXT string (backwards
    // compatible: works in batch reads and the loop's text path). Images
    // present → return a content-block ARRAY so the model can see them.
    if (!hasImageBlock) {
      return blocks.map((b) => b.text).join('\n\n') || '(empty notebook)';
    }
    return { content: blocks };
  } catch (err) {
    return `Error: ipynb parse failed — ${errorText(err)}`;
  }
}
