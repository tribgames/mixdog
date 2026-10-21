/**
 * Attachments sent by reference instead of inline.
 *
 * A PDF or image the user attached already lives in the content-addressed
 * store on this machine. When inlining it would crowd the context window, the
 * message carries a short text part instead: the file's name, size, page count
 * and text-layer status, and the path the model reads it from — so the model
 * pulls in only the pages the request needs (read with `pages`). The part keeps
 * the attachment's `attachmentRef` (nested, so it is not itself a stored-text
 * reference) and the store's census keeps the bytes as long as the message
 * names them.
 */
import { inlineFileKind } from '../shared/inline-file-kind.mjs';
import { attachmentFilePath, isAttachmentReference, storeInlineDocumentPart, storeInlineImagePart } from './store.mjs';

/** Up to this many pages per read call; the read tool enforces the same cap. */
export const READ_PDF_MAX_PAGES_PER_CALL = 20;

function sizeLabel(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${value} bytes`;
}

function quotedName(name, fallback) {
  const base = String(name || '')
    .split(/[\\/]/)
    .pop()
    .replace(/["\r\n]/g, '')
    .trim();
  return `"${base || fallback}"`;
}

/** How much of a PDF reads as text, in words the model can act on. */
export function textLayerLabel(pageCount, textPages) {
  const pages = Number(pageCount);
  const withText = Number(textPages);
  if (!(pages > 0) || !Number.isFinite(withText) || withText < 0) return 'text layer not checked';
  if (withText === 0) return 'no text layer (scanned pages)';
  if (withText >= pages) return 'text layer on every page';
  return `text layer on ${withText} of ${pages} pages; the rest are scanned`;
}

function pdfReferenceText(info, path) {
  const plural = info.pageCount === 1 ? '' : 's';
  const pages = info.pageCount > 0 ? `${info.pageCount} page${plural}, ` : '';
  return [
    `[Attachment kept on disk, not inlined: ${quotedName(info.filename, 'document.pdf')} ` +
      `(PDF, ${pages}${textLayerLabel(info.pageCount, info.textPages)}, ${sizeLabel(info.sizeBytes)})`,
    `Path: ${path}`,
    `Read only what the request needs: read this path with pages, e.g. pages="1-5" (up to ` +
      `${READ_PDF_MAX_PAGES_PER_CALL} pages per call). Pages with a text layer come back as text; ` +
      'scanned pages come back as page images, or as OCR text when the model is text-only.]',
  ].join('\n');
}

function imageReferenceText(info, path) {
  return [
    `[Image kept on disk, not inlined: ${quotedName(info.filename, 'image')} ` +
      `(${info.mimeType || 'image'}, ${sizeLabel(info.sizeBytes)})`,
    `Path: ${path}`,
    'View it with read on this path when the request needs it.]',
  ].join('\n');
}

// The stored form of a media part that can travel by reference, or null. An
// inline payload is written to the store first so it gets a path too.
function storedMediaPart(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'image') {
    if (isAttachmentReference(part)) return part;
    return storeInlineImagePart(part);
  }
  if (part.type === 'file' || part.type === 'document') {
    const stored = isAttachmentReference(part) ? part : storeInlineDocumentPart(part);
    if (!stored) return null;
    const mimeType = String(stored.mimeType || stored.mediaType || '');
    return inlineFileKind(mimeType, '') === 'pdf' ? stored : null;
  }
  return null;
}

/** Whether `part` is a media part this module can turn into a reference. */
export function isReferencableMediaPart(part) {
  if (!part || typeof part !== 'object') return false;
  if (part.type === 'image') {
    return isAttachmentReference(part) || typeof part.data === 'string' || part.source?.type === 'base64';
  }
  if (part.type === 'document') return part.source?.type === 'base64';
  if (part.type !== 'file') return false;
  const mimeType = String(part.mimeType || part.mediaType || 'application/pdf');
  return inlineFileKind(mimeType, isAttachmentReference(part) ? '' : part.data || '', part.filename) === 'pdf';
}

/** Whether `part` is a reference this module produced. */
export function isMediaReferencePart(part) {
  return Boolean(part && part.type === 'text' && part.attachmentReference && typeof part.text === 'string');
}

/**
 * The reference text part standing for one media part, or null when the part
 * cannot travel by reference (a URL image, a non-PDF file, a store failure).
 */
export function mediaPartToReference(part) {
  let stored;
  try {
    stored = storedMediaPart(part);
  } catch {
    return null;
  }
  if (!stored) return null;
  const kind = stored.type === 'image' ? 'image' : 'pdf';
  const pageCount = Math.floor(Number(part.pageCount ?? stored.pageCount)) || 0;
  const textPagesRaw = part.textPages ?? stored.textPages;
  const info = {
    attachmentRef: stored.attachmentRef,
    kind,
    filename: String(part.filename || part.title || part.name || stored.filename || ''),
    mimeType: String(stored.mimeType || stored.mediaType || (kind === 'pdf' ? 'application/pdf' : 'image/png')),
    sizeBytes: Number(stored.sizeBytes) || 0,
    ...(pageCount > 0 ? { pageCount } : {}),
    ...(Number.isFinite(Number(textPagesRaw)) && textPagesRaw !== null ? { textPages: Number(textPagesRaw) } : {}),
  };
  const path = attachmentFilePath(info.attachmentRef);
  return {
    type: 'text',
    text: kind === 'pdf' ? pdfReferenceText(info, path) : imageReferenceText(info, path),
    attachmentReference: info,
  };
}

/**
 * A user `message` with every referencable media part of its own content
 * replaced by its reference text (other roles, tool results and nested content
 * stay as they are).
 * Returns the same message when nothing changed.
 */
export function referenceMessageMedia(message) {
  if (message?.role !== 'user' || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.map((part) => {
    if (!isReferencableMediaPart(part)) return part;
    const reference = mediaPartToReference(part);
    if (!reference) return part;
    changed = true;
    return reference;
  });
  return changed ? { ...message, content } : message;
}

/** Whether the message's own content still carries referencable media. */
export function messageHasReferencableMedia(message) {
  return Array.isArray(message?.content) && message.content.some(isReferencableMediaPart);
}
