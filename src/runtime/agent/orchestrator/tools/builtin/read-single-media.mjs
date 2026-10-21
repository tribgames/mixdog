/**
 * read-single-media.mjs — MEDIA-WINS dispatch for a scalar Read. A .pdf,
 * .ipynb or OOXML file is answered by its extractor BEFORE any cache or
 * read-snapshot fast path: a media file previously read as text can carry a
 * stale cached TEXT entry, and returning that instead of the fresh media
 * shape (PDF document block / ipynb content-block array) is wrong.
 * extractPdfText / extractIpynbText own their size handling (PDF >20MB →
 * text fallback via PDF_DOCUMENT_MAX_BYTES, page-range filter, ipynb range
 * refusal). mediaTextOnly (batch dispatcher) must produce a flat string,
 * never a content-block object, so a batch aggregate's String()+join can't
 * stringify it to "[object Object]"; scalar reads leave it unset and get the
 * rich block shapes.
 */
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { extractOoxmlText } from '../../../../attachments/office-extract.mjs';
import { readImageAsContent } from './read-image.mjs';

const OOXML_EXTENSIONS = new Set(['.docx', '.pptx', '.xlsx', '.xlsm']);

// File signatures of the media an extension-less path may hold: the stored
// attachments a reference points at keep no extension.
const SNIFFED_IMAGE_TYPES = [
  { mimeType: 'image/png', matches: (head) => head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) },
  { mimeType: 'image/jpeg', matches: (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  { mimeType: 'image/gif', matches: (head) => head.subarray(0, 4).toString('latin1') === 'GIF8' },
  {
    mimeType: 'image/webp',
    matches: (head) =>
      head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

async function sniffedMediaType(fullPath, st) {
  if (!st?.isFile?.() || st.size < 5) return null;
  const handle = await open(fullPath, 'r');
  try {
    const head = Buffer.alloc(12);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const bytes = head.subarray(0, bytesRead);
    if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
    return SNIFFED_IMAGE_TYPES.find((type) => type.matches(bytes))?.mimeType || null;
  } finally {
    await handle.close();
  }
}

/**
 * @returns {Promise<{ result: unknown } | null>} null when the path is not a
 *   media file.
 */
export async function readMediaFile({ fullPath, st, args, readStateScope, options, hasRangeArgs }, helpers) {
  const { extractPdfText, extractIpynbText, READ_MAX_OUTPUT_BYTES, _recordReadSnapshot } = helpers;
  const textOnly = options?.mediaTextOnly === true;
  const ext = extname(fullPath).toLowerCase();
  const sniffed = ext === '' ? await sniffedMediaType(fullPath, st) : null;
  if (ext === '.pdf' || sniffed === 'application/pdf') {
    return {
      result: await extractPdfText(fullPath, args.pages, {
        maxOutputBytes: READ_MAX_OUTPUT_BYTES,
        textOnly,
        // The caller's model decides how a scanned page arrives: as a page
        // image for one that reads images, as OCR text for a text-only one;
        // a whole document block only for one that reads PDFs natively.
        pageMode: options?.pdfPageMode === 'ocr' ? 'ocr' : 'image',
        nativeDocument: options?.pdfNativeDocument !== false,
        signal: options?.signal || null,
      }),
    };
  }
  if (sniffed && !textOnly) {
    const image = await readImageAsContent(fullPath, args.path || fullPath, st, sniffed);
    if (image) return { result: image };
  }
  if (OOXML_EXTENSIONS.has(ext)) {
    // OOXML text extraction — always a flat string, so it is batch-safe
    // without a textOnly split. Snapshot recorded on success only.
    const out = await extractOoxmlText(fullPath, { maxOutputBytes: READ_MAX_OUTPUT_BYTES });
    if (typeof out === 'string' && !out.startsWith('Error:')) {
      _recordReadSnapshot(fullPath, st, readStateScope, { source: 'read', replaceExisting: true });
    }
    return { result: out };
  }
  if (ext === '.ipynb') {
    const out = await extractIpynbText(fullPath, {
      maxOutputBytes: READ_MAX_OUTPUT_BYTES,
      hasRangeArgs: hasRangeArgs || args.line !== undefined,
      textOnly,
    });
    // Record a full-file read snapshot for cache/read-state consistency.
    // Skipped on an Error string (no real read).
    if (typeof out !== 'string' || !out.startsWith('Error:')) {
      _recordReadSnapshot(fullPath, st, readStateScope, { source: 'read', replaceExisting: true });
    }
    return { result: out };
  }
  return null;
}
