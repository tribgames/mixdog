/**
 * How an inline file payload can reach a model.
 *
 * - `pdf`    native document media on every provider that takes documents.
 * - `text`   readable as plain text, so it travels as text.
 * - `office` .docx/.pptx/.xlsx/.xlsm: lowered to extracted text on every provider.
 * - `binary` archives, spreadsheets, unknown blobs: no API accepts them as an
 *            inline block, so they are described instead of sent.
 *
 * The transport MIME type is a hint, not an identity — a browser download with
 * an unfamiliar extension arrives as application/octet-stream even when the
 * bytes are a real PDF — so the magic header decides before the label does.
 */

import { isPdfBuffer } from '../attachments/limits.mjs';

const TEXTUAL_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/toml',
  'application/x-ndjson',
  'application/x-www-form-urlencoded',
]);

/** Byte count of a base64 payload without decoding it. */
export function base64ByteLength(data) {
  const text = String(data || '');
  if (!text) return 0;
  let padding = 0;
  if (text.endsWith('==')) padding = 2;
  else if (text.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

function hasPdfMagic(base64Data) {
  const head = String(base64Data || '').slice(0, 8);
  if (head.length < 8) return false;
  try {
    return isPdfBuffer(Buffer.from(head, 'base64'));
  } catch {
    return false;
  }
}

const OFFICE_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroenabled.12',
]);
const OFFICE_EXTENSION_RE = /\.(?:docx|pptx|xlsx|xlsm)$/i;
const GENERIC_CONTAINER_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
]);

/**
 * @param {string} mimeType
 * @param {string} base64Data
 * @param {string} [filename] only consulted to recognise an Office file that
 *   arrived under a generic container MIME type.
 */
export function inlineFileKind(mimeType, base64Data, filename = '') {
  const mime = String(mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (mime === 'application/pdf' || hasPdfMagic(base64Data)) return 'pdf';
  if (OFFICE_MIME_TYPES.has(mime)) return 'office';
  if (GENERIC_CONTAINER_MIME_TYPES.has(mime) && OFFICE_EXTENSION_RE.test(String(filename || '').trim())) {
    return 'office';
  }
  if (mime.startsWith('text/')) return 'text';
  if (mime.startsWith('application/javascript') || mime.startsWith('application/ecmascript')) return 'text';
  if (mime.endsWith('+json') || mime.endsWith('+xml')) return 'text';
  return TEXTUAL_MIME_TYPES.has(mime) ? 'text' : 'binary';
}
