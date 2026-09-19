import type { RecordValue } from './desktop-types';
import type { ComposerAttachment } from './composer-support';
import { asRecord } from './text-format';

/** Ids for restored attachments: keep a stored id when it is free, otherwise
 *  allocate past every reserved id and advance the composer's sequence. */
function createRestoredIdAllocator(reservedIds: Set<number>, sequence: { current: number }) {
  return (rawId: number) => {
    let id = rawId > 0 ? rawId : sequence.current;
    while (reservedIds.has(id)) id = Math.max(id + 1, sequence.current++);
    reservedIds.add(id);
    sequence.current = Math.max(sequence.current, id + 1);
    return id;
  };
}

function withoutToken(text: string, token: string): string {
  return text
    .replace(token, ' ')
    .replace(/ {2,}/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/**
 * Rebuild the composer's attachments from a stored draft/recovery record.
 * Image chips lose their inline token (it is stripped from the text); pasted
 * text/file chips keep the token found in the text, renumbered when the stored
 * id collided with a live attachment.
 */
export function restoreAttachmentsFromRecord(
  value: RecordValue,
  restoredText: string,
  ids: { reservedIds: Set<number>; sequence: { current: number } }
): { attachments: ComposerAttachment[]; text: string } {
  const restored: ComposerAttachment[] = [];
  const uniqueId = createRestoredIdAllocator(ids.reservedIds, ids.sequence);
  let textValue = restoredText;
  for (const [key, raw] of Object.entries(asRecord(value.pastedImages) || {})) {
    const image = asRecord(raw);
    if (!image || typeof image.content !== 'string') continue;
    const rawId = Number(image.id || key) || 0;
    const name = String(image.filename || `Image ${rawId || ids.sequence.current}`);
    const namedToken = `[Image #${rawId}: ${name}]`;
    const plainToken = `[Image #${rawId}]`;
    let sourceToken = '';
    if (textValue.includes(namedToken)) sourceToken = namedToken;
    else if (textValue.includes(plainToken)) sourceToken = plainToken;
    if (sourceToken) textValue = withoutToken(textValue, sourceToken);
    restored.push({
      id: uniqueId(rawId),
      name,
      kind: 'image',
      mimeType: String(image.mediaType || 'image/png'),
      data: image.content,
      token: '',
      ...(typeof image.metadataText === 'string' && image.metadataText ? { metadataText: image.metadataText } : {}),
    });
  }
  for (const [key, raw] of Object.entries(asRecord(value.pastedTexts) || {})) {
    const text = asRecord(raw);
    if (!text || typeof text.text !== 'string') continue;
    const rawId = Number(text.id || key) || 0;
    const pastedMatch = textValue.match(new RegExp(`\\[Pasted text #${rawId}(?: \\+\\d+ lines)?\\]`));
    const fileMatch = textValue.match(new RegExp(`\\[File #${rawId}(?:: [^\\]\\r\\n]+)?\\]`));
    const source = text.source === 'file' || (!pastedMatch && Boolean(fileMatch)) ? 'file' : 'paste';
    const match = source === 'file' ? fileMatch : pastedMatch;
    if (!match) continue;
    const id = uniqueId(rawId);
    const token = id === rawId ? match[0] : match[0].replace(`#${rawId}`, `#${id}`);
    if (token !== match[0]) textValue = textValue.replace(match[0], token);
    restored.push({
      id,
      name: String(text.filename || (source === 'file' ? `File ${id}` : `Pasted text ${id}`)),
      kind: 'text',
      mimeType: String(text.mimeType || 'text/plain'),
      data: text.text,
      token,
      source,
    });
  }
  return { attachments: restored, text: textValue };
}

/** `@path` mentions for project-relative paths; drive letters and `..` are refused. */
export function projectMentionTokens(paths: string[]): string[] {
  return paths
    .map((path) => path.replace(/\\/g, '/').replace(/^\/+/, '').trim())
    .filter((path) => path && !path.split('/').includes('..') && !/^[a-z]:/i.test(path))
    .map((path) => `@${path}`);
}

/** Absolute paths as prompt tokens; paths with whitespace are quoted. */
export function absolutePathTokens(paths: string[]): string[] {
  return paths
    .map((path) => String(path || '').trim())
    .filter(Boolean)
    .map((path) => (/\s/.test(path) ? `"${path}"` : path));
}
