/**
 * How an inline file payload can reach a model.
 *
 * - `pdf`    native document media on every provider that takes documents.
 * - `text`   readable as plain text, so it travels as text.
 * - `binary` archives, spreadsheets, unknown blobs: no API accepts them as an
 *            inline block, so they are described instead of sent.
 *
 * The transport MIME type is a hint, not an identity — a browser download with
 * an unfamiliar extension arrives as application/octet-stream even when the
 * bytes are a real PDF — so the magic header decides before the label does.
 */

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
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

function hasPdfMagic(base64Data) {
  const head = String(base64Data || '').slice(0, 8);
  if (head.length < 8) return false;
  try {
    return Buffer.from(head, 'base64').subarray(0, 5).toString('latin1') === '%PDF-';
  } catch {
    return false;
  }
}

export function inlineFileKind(mimeType, base64Data) {
  const mime = String(mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (mime === 'application/pdf' || hasPdfMagic(base64Data)) return 'pdf';
  if (mime.startsWith('text/')) return 'text';
  if (mime.startsWith('application/javascript') || mime.startsWith('application/ecmascript')) return 'text';
  if (mime.endsWith('+json') || mime.endsWith('+xml')) return 'text';
  return TEXTUAL_MIME_TYPES.has(mime) ? 'text' : 'binary';
}
