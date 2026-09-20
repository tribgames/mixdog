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
import { extname } from 'node:path';
import { extractOoxmlText } from './read-office-files.mjs';

const OOXML_EXTENSIONS = new Set(['.docx', '.pptx', '.xlsx', '.xlsm']);

/**
 * @returns {Promise<{ result: unknown } | null>} null when the path is not a
 *   media file.
 */
export async function readMediaFile({ fullPath, st, args, readStateScope, options, hasRangeArgs }, helpers) {
  const { extractPdfText, extractIpynbText, READ_MAX_OUTPUT_BYTES, _recordReadSnapshot } = helpers;
  const textOnly = options?.mediaTextOnly === true;
  const ext = extname(fullPath).toLowerCase();
  if (ext === '.pdf') {
    return { result: await extractPdfText(fullPath, args.pages, { maxOutputBytes: READ_MAX_OUTPUT_BYTES, textOnly }) };
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
