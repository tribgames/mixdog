// Rebuilds the composer's restore payload (`pastedTexts`, `pastedImages`) from a
// stored, materialized user prompt. The model history holds the EXPANDED prompt:
// each `[Pasted text #n …]` / `[File #n …]` token became a `textKind` reference
// part, in token order, and each image an image reference part. The transcript
// row's own text still spells the tokens, so the n-th reference part belongs to
// the n-th token; the entries carry references only and are hydrated by the
// caller (`hydratePastedAttachments`) exactly as the abort/queue restores are.
import { isAttachmentReference } from './store.mjs';

const TEXT_TOKEN_RE = /\[(Pasted text|File) #(\d+)(?:: ([^\]\r\n]+))?[^\]\r\n]*\]/g;
const IMAGE_TOKEN_RE = /\[Image #(\d+)[^\]\r\n]*\]/g;

export function restorableAttachmentsFromPrompt(content, rowText) {
  const parts = Array.isArray(content) ? content : [];
  const text = String(rowText ?? '');
  const textRefs = parts.filter(
    (part) =>
      part?.type === 'text' && isAttachmentReference(part) && (part.textKind === 'paste' || part.textKind === 'file')
  );
  const imageRefs = parts.filter((part) => part?.type === 'image' && isAttachmentReference(part));

  // A `[File #n: name]` token is also spelled for binary files (PDF/Office),
  // which never became a text reference: a token takes the next text reference
  // only when it is the same kind (and, for files, the same name).
  const pastedTexts = {};
  let next = 0;
  for (const match of text.matchAll(TEXT_TOKEN_RE)) {
    const part = textRefs[next];
    if (!part) break;
    const isFile = match[1] === 'File';
    if (isFile ? part.textKind !== 'file' || match[3] !== part.filename : part.textKind !== 'paste') continue;
    next += 1;
    const id = Number(match[2]);
    if (!id || pastedTexts[id]) continue;
    pastedTexts[id] = {
      id,
      source: part.textKind === 'file' ? 'file' : 'paste',
      attachmentRef: part.attachmentRef,
      sizeBytes: part.sizeBytes,
      ...(part.filename ? { filename: part.filename } : {}),
      ...(part.mimeType ? { mimeType: part.mimeType } : {}),
    };
  }

  const imageIds = [...text.matchAll(IMAGE_TOKEN_RE)].map((match) => Number(match[1]));
  const usedIds = new Set([...Object.keys(pastedTexts).map(Number), ...imageIds]);
  let nextId = 1;
  const pastedImages = {};
  imageRefs.forEach((part, index) => {
    let id = Number(part.pasteId) || imageIds[index] || 0;
    if (!id || pastedImages[id]) {
      while (usedIds.has(nextId)) nextId += 1;
      id = nextId;
      usedIds.add(id);
    }
    pastedImages[id] = {
      id,
      type: 'image',
      mediaType: String(part.mimeType || part.mediaType || 'image/png'),
      attachmentRef: part.attachmentRef,
      sizeBytes: part.sizeBytes,
      ...(part.filename ? { filename: part.filename } : {}),
    };
  });

  return {
    pastedTexts: Object.keys(pastedTexts).length ? pastedTexts : null,
    pastedImages: Object.keys(pastedImages).length ? pastedImages : null,
  };
}
