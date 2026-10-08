// Browser-safe (no Node APIs) feedback attachment validator shared by the UI,
// the desktop client and the relay. Output carries only {name, mimeType, data}.
export const FEEDBACK_ATTACHMENT_MAX_COUNT = 3;
export const FEEDBACK_ATTACHMENT_MAX_BYTES = 2_097_152;
export const FEEDBACK_ATTACHMENT_MAX_TOTAL_BYTES = 6_291_456;
export const FEEDBACK_ATTACHMENT_MAX_NAME_CHARS = 100;
export const FEEDBACK_ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const MAX_BASE64_CHARS = Math.ceil(FEEDBACK_ATTACHMENT_MAX_BYTES / 3) * 4;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// No separators, wildcards, control characters, or leading dot / trailing dot or space.
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\\/:*?"<>|]/;

const invalid = () => new TypeError('Feedback attachments are invalid.');

function decodedLength(data) {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

function prefixBytes(data, count) {
  const chars = Math.ceil(count / 3) * 4;
  const binary = atob(data.slice(0, Math.min(chars, data.length)));
  return Array.from(binary, (c) => c.charCodeAt(0));
}

function hasSignature(mimeType, data) {
  const head = prefixBytes(data, 12);
  const at = (offset, text) => [...text].every((c, i) => head[offset + i] === c.charCodeAt(0));
  if (mimeType === 'image/png') {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b);
  }
  if (mimeType === 'image/jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  return head.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP');
}

/** Strict canonical base64: alphabet, padding and zeroed trailing bits. */
function canonicalBase64(data) {
  if (!data || data.length % 4 !== 0 || !BASE64.test(data)) return false;
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  if (!pad) return true;
  const last = BASE64_ALPHABET.indexOf(data[data.length - pad - 1]);
  return last % (pad === 2 ? 16 : 4) === 0;
}

/** Raw byte total of already-normalized attachments. */
export function feedbackAttachmentBytes(attachments) {
  let total = 0;
  for (const attachment of attachments) total += decodedLength(attachment.data);
  return total;
}

/** undefined/empty -> []; anything invalid throws TypeError. Unknown fields are dropped. */
export function normalizeFeedbackAttachments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid();
  if (value.length > FEEDBACK_ATTACHMENT_MAX_COUNT) throw invalid();
  let total = 0;
  const result = [];
  for (let i = 0; i < value.length; i++) {
    if (!(i in value)) throw invalid();
    const item = value[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid();
    const { name, mimeType, data } = item;
    if (typeof name !== 'string' || typeof mimeType !== 'string' || typeof data !== 'string') throw invalid();
    if (!FEEDBACK_ATTACHMENT_MIME_TYPES.includes(mimeType)) throw invalid();
    if (
      !name ||
      name.length > FEEDBACK_ATTACHMENT_MAX_NAME_CHARS ||
      name !== name.trim() ||
      name.startsWith('.') ||
      name.endsWith('.') ||
      UNSAFE_NAME.test(name)
    ) {
      throw invalid();
    }
    if (data.length > MAX_BASE64_CHARS || !canonicalBase64(data)) throw invalid();
    const bytes = decodedLength(data);
    total += bytes;
    if (bytes < 12 || bytes > FEEDBACK_ATTACHMENT_MAX_BYTES || total > FEEDBACK_ATTACHMENT_MAX_TOTAL_BYTES) {
      throw invalid();
    }
    if (!hasSignature(mimeType, data)) throw invalid();
    result.push({ name, mimeType, data });
  }
  return result;
}
