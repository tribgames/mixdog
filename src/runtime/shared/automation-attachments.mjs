/**
 * Stored automation attachments (schedule/webhook rows) → askSession content.
 * Attachment shape (persisted as jsonb): { kind: 'image'|'text'|'pdf', name,
 * mimeType, data } — image/pdf data is base64, text data is plain text.
 * Text files inline into the prompt body; images/PDFs become the same
 * content parts the desktop composer submits ({type:'image'} /
 * {type:'file'}), so provider media normalization treats them identically.
 */

export const AUTOMATION_ATTACHMENT_KINDS = ['image', 'text', 'pdf'];
export const MAX_AUTOMATION_ATTACHMENTS = 8;
// Base64 total across image/pdf items; text totals separately.
export const MAX_AUTOMATION_BINARY_TOTAL = 8_000_000;
export const MAX_AUTOMATION_TEXT_TOTAL = 200_000;

/** Validate + strip a stored/list attachments value to the persisted shape (or null). */
export function normalizeAutomationAttachments(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out = [];
  let binaryTotal = 0;
  let textTotal = 0;
  for (const entry of value.slice(0, MAX_AUTOMATION_ATTACHMENTS)) {
    if (!entry || typeof entry !== 'object') continue;
    const kind = String(entry.kind || '').trim();
    const data = typeof entry.data === 'string' ? entry.data : '';
    if (!AUTOMATION_ATTACHMENT_KINDS.includes(kind) || !data) continue;
    if (kind === 'text') {
      textTotal += data.length;
      if (textTotal > MAX_AUTOMATION_TEXT_TOTAL) {
        throw new Error('text attachments are too large together (200 KB max)');
      }
    } else {
      binaryTotal += data.length;
      if (binaryTotal > MAX_AUTOMATION_BINARY_TOTAL) {
        throw new Error('image/PDF attachments are too large together (8 MB max)');
      }
    }
    out.push({
      kind,
      name: String(entry.name || '').slice(0, 200) || `attachment-${out.length + 1}`,
      mimeType: String(entry.mimeType || (kind === 'pdf' ? 'application/pdf' : kind === 'image' ? 'image/png' : 'text/plain')),
      data,
    });
  }
  return out.length ? out : null;
}

/**
 * Build the askSession prompt content: plain string when there are no
 * attachments, otherwise a parts array (text + image/file blocks).
 */
export function automationPromptContent(promptText, attachments) {
  const rows = Array.isArray(attachments) ? attachments : [];
  let text = String(promptText || '');
  const textFiles = rows.filter((entry) => entry?.kind === 'text' && entry.data);
  if (textFiles.length) {
    text += '\n\n' + textFiles
      .map((entry) => `--- Attached file: ${entry.name} ---\n${entry.data}`)
      .join('\n\n');
  }
  const parts = [];
  for (const entry of rows) {
    if (!entry || typeof entry.data !== 'string' || !entry.data) continue;
    if (entry.kind === 'image') {
      parts.push({ type: 'image', data: entry.data, mimeType: entry.mimeType || 'image/png' });
    } else if (entry.kind === 'pdf') {
      parts.push({ type: 'file', data: entry.data, mimeType: entry.mimeType || 'application/pdf', filename: entry.name });
    }
  }
  if (parts.length === 0) return text;
  return [{ type: 'text', text }, ...parts];
}
