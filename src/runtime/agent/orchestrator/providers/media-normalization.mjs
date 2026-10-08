import { createHash } from 'node:crypto';
import { inspectPdfBuffer } from '../../../attachments/pdf-extract.mjs';
import { resolvedPdfJs } from '../../../attachments/pdfjs-runtime.mjs';
import { MAX_PDF_PAGES } from '../../../attachments/limits.mjs';
import { tryExtractOoxmlTextFromBuffer } from '../../../attachments/office-extract.mjs';
import {
  attachmentTextForPart,
  isAttachmentReference,
  isPermanentAttachmentError,
  providerTakesNativePdf,
  readAttachmentBase64,
  storeInlineImagePart,
  storeInlineDocumentPart,
} from '../../../attachments/store.mjs';
import { base64ByteLength, inlineFileKind } from '../../../shared/inline-file-kind.mjs';
import { isEnvironmentError } from '../../../shared/environment-error.mjs';

const DEFAULT_IMAGE_MIME = 'image/png';

function cleanMimeType(value) {
  const mime = String(value || '')
    .trim()
    .toLowerCase();
  return mime.startsWith('image/') ? mime : DEFAULT_IMAGE_MIME;
}

function imageInfo(block) {
  if (!block || typeof block !== 'object' || block.type !== 'image') return null;
  if (isAttachmentReference(block)) {
    return { data: readAttachmentBase64(block), mimeType: cleanMimeType(block.mimeType || block.mediaType) };
  }
  if (typeof block.data === 'string' && block.data) {
    return { data: block.data, mimeType: cleanMimeType(block.mimeType || block.mediaType) };
  }
  const source = block.source;
  if (source?.type === 'base64' && typeof source.data === 'string' && source.data) {
    return { data: source.data, mimeType: cleanMimeType(source.media_type || source.mediaType) };
  }
  return null;
}

function geminiInlineInfo(block) {
  if (!block || typeof block !== 'object') return null;
  const inline = block.inlineData || block.inline_data;
  const data = inline?.data;
  if (typeof data !== 'string' || !data) return null;
  return {
    data,
    mimeType: cleanMimeType(inline.mimeType || inline.mime_type || inline.mediaType || inline.media_type),
  };
}

// Inline document/file parts arrive in two canonical runtime shapes:
// - desktop attachments: { type: 'file', data, mimeType, filename? }
// - read(PDF): { type: 'document', source: { type: 'base64', media_type, data } }
// Providers receive both as their native document shape; estimators and stored
// history must never serialize either base64 payload as text.
function fileInfo(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'document') {
    const source = block.source;
    if (source?.type !== 'base64' || typeof source.data !== 'string' || !source.data) return null;
    const mimeType =
      String(source.media_type || source.mediaType || block.mimeType || block.mediaType || 'application/pdf')
        .trim()
        .toLowerCase() || 'application/pdf';
    let filename = '';
    if (typeof block.title === 'string' && block.title) filename = block.title;
    else if (typeof block.filename === 'string' && block.filename) filename = block.filename;
    return { data: source.data, mimeType: bytesDecideMime(mimeType, source.data), filename, part: block };
  }
  if (block.type !== 'file') return null;
  let data = '';
  if (isAttachmentReference(block)) data = readAttachmentBase64(block);
  else if (typeof block.data === 'string') data = block.data;
  if (!data) return null;
  const mimeType =
    String(block.mimeType || block.mediaType || 'application/pdf')
      .trim()
      .toLowerCase() || 'application/pdf';
  const filename = typeof block.filename === 'string' && block.filename ? block.filename : '';
  const file = { data, mimeType: bytesDecideMime(mimeType, data), filename, part: block };
  // A reference is already the content hash: memo keys use it instead of
  // hashing the whole base64 payload again.
  if (isAttachmentReference(block)) file.ref = block.attachmentRef;
  return file;
}

// The PDF magic header outranks the transport label, so a mislabelled PDF
// carries the same type, label and price whether it is an inline part or the
// reference the store wrote for it (which records application/pdf).
function bytesDecideMime(mimeType, data) {
  return inlineFileKind(mimeType, data) === 'pdf' ? 'application/pdf' : mimeType;
}

function fileLabel(file) {
  return `${file.filename ? `${file.filename} ` : ''}(${file.mimeType}, ${base64ByteLength(file.data)} bytes)`;
}

function fileDecodedText(file) {
  return Buffer.from(file.data, 'base64').toString('utf8');
}

// Only a PDF has a native container everywhere. Text-ish bytes are readable as
// text on every provider, and a binary payload has no inline form at all — it
// is named so the model can open it from disk instead of receiving a block the
// API rejects.
function fileFallbackText(file, kind) {
  if (kind === 'text') return `--- ${fileLabel(file)} ---\n${fileDecodedText(file)}`;
  if (kind === 'office') {
    const extracted = officeTextForFile(file);
    if (extracted !== null) return `--- ${fileLabel(file)} ---\n${extracted}`;
  }
  return `[file not sent inline: ${fileLabel(file)} — this type has no inline form; open it from disk with read]`;
}

function fileKind(file) {
  return inlineFileKind(file.mimeType, file.data, file.filename);
}

// Extraction limits are fixed constants and the output depends only on the
// file's bytes and filename, so every turn, reload and restart lowers the same
// history to the same request. The memos below are speed caches keyed by
// content hash (or by the part itself): a cold memo recomputes the identical
// text, and nothing correctness-related depends on one.
//
// CACHE WARNING: this text is part of every already-sent turn's provider
// prefix. Changing the Office extractor (attachments/office-extract.mjs), the
// PDF extractor (pdf-extract.mjs / pdf.js), the limits below or the label
// format changes how OLD turns lower and invalidates the provider prompt cache
// for every session that holds such a file.
const OFFICE_TEXT_MAX_BYTES = 256 * 1024;
// Inflated size caps for lowering: a part or container beyond them has no text
// form (the fixed description is used), whatever its extractable content.
const OFFICE_PART_MAX_BYTES = 8 * 1024 * 1024;
const OFFICE_CONTAINER_MAX_BYTES = 32 * 1024 * 1024;
// The most text a PDF contributes; token estimates cap a text-lowered PDF here.
export const PDF_TEXT_MAX_BYTES = 256 * 1024;
const MEMO_MAX_ENTRIES = 64;
const officeTextMemo = new Map();
const pdfTextMemo = new Map();
// An inline part never changes, so its extraction is remembered by the part
// itself instead of re-hashing its whole base64 payload on every lowering.
let inlineOfficeText = new WeakMap();

function memoized(memo, key, compute) {
  if (memo.has(key)) {
    const hit = memo.get(key);
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  const value = compute();
  memo.set(key, value);
  if (memo.size > MEMO_MAX_ENTRIES) memo.delete(memo.keys().next().value);
  return value;
}

// Extracted text, or null when the container cannot be read (the caller then
// uses the plain description).
function officeTextForFile(file) {
  const compute = () =>
    tryExtractOoxmlTextFromBuffer(Buffer.from(file.data, 'base64'), file.filename, {
      maxOutputBytes: OFFICE_TEXT_MAX_BYTES,
      maxPartBytes: OFFICE_PART_MAX_BYTES,
      maxContainerBytes: OFFICE_CONTAINER_MAX_BYTES,
    });
  if (file.ref) return memoized(officeTextMemo, `ref:${file.ref}\0${file.filename || ''}`, compute);
  if (file.part && inlineOfficeText.has(file.part)) return inlineOfficeText.get(file.part);
  const key = createHash('sha256').update(file.filename || '').update('\0').update(file.data).digest('hex');
  const text = memoized(officeTextMemo, key, compute);
  if (file.part) inlineOfficeText.set(file.part, text);
  return text;
}

/** Empties the extraction speed caches (tests: cold-process equivalence). */
export function _clearLoweringMemos() {
  officeTextMemo.clear();
  pdfTextMemo.clear();
  inlineOfficeText = new WeakMap();
  inlinePdfKeys = new WeakMap();
}

// pdf.js is asynchronous while lowering is synchronous, so a provider that
// takes a PDF as text gets it from an awaited pre-send step
// (preparePdfTextForProvider) that returns a copy of the request's messages
// with every PDF part already replaced by its text part. Lowering therefore
// never reads an extraction cache: a PDF part that still reaches it for such a
// provider is a bug and throws. Extraction runs in-process (it awaits pdf.js, it
// does not block the event loop for the whole document), and a PDF that cannot be
// read — encrypted, damaged — yields the fixed text below, which is a property
// of the bytes.
const PDF_UNREADABLE_TEXT = '[PDF text unavailable: this PDF could not be read]';

// The content hash of the PDF's bytes — a reference already is one — so an
// inline part and the reference stored for it share one cache entry.
// An inline part never changes, so its hash is taken once per part.
let inlinePdfKeys = new WeakMap();
function pdfKey(file) {
  if (file.ref) return file.ref;
  const known = file.part ? inlinePdfKeys.get(file.part) : undefined;
  if (known) return known;
  const key = createHash('sha256').update(Buffer.from(file.data, 'base64')).digest('hex');
  if (file.part) inlinePdfKeys.set(file.part, key);
  return key;
}

let pdfExtractionCount = 0;

/** Number of PDF extractions actually run in this process (tests). */
export function _pdfExtractionCount() {
  return pdfExtractionCount;
}

// A PDF the parser rejects is a property of the bytes: fixed text. A system
// error or an allocation failure is not the bytes' fault and must never become
// text.
async function extractPdfText(data) {
  pdfExtractionCount += 1;
  // Loading pdf.js says nothing about the PDF: a failure here propagates (the
  // send fails and retries later with the real text) and nothing is cached.
  await resolvedPdfJs();
  await import('unpdf');
  try {
    // A PDF longer than MAX_PDF_PAGES is read for its first MAX_PDF_PAGES pages.
    const { text } = await inspectPdfBuffer(Buffer.from(data, 'base64'), {
      extractText: true,
      maxPages: Infinity,
      pageRange: { from: 1, to: MAX_PDF_PAGES },
      maxOutputBytes: PDF_TEXT_MAX_BYTES,
    });
    return text;
  } catch (error) {
    if (isEnvironmentError(error)) throw error;
    return PDF_UNREADABLE_TEXT;
  }
}

// The cache holds the extraction promise, so concurrent sends of one PDF share
// a single extraction; a rejection is dropped so the next send retries.
function pdfTextFor(file) {
  const key = pdfKey(file);
  const pending = memoized(pdfTextMemo, key, () => extractPdfText(file.data));
  pending.catch(() => {
    if (pdfTextMemo.get(key) === pending) pdfTextMemo.delete(key);
  });
  return pending;
}

function pdfNotPrepared() {
  return new Error(
    'internal error: a PDF part reached text lowering unprepared (await preparePdfTextForProvider before building the request)'
  );
}

function* walkContentParts(content) {
  if (Array.isArray(content)) {
    for (const part of content) yield* walkContentParts(part);
  } else if (content && typeof content === 'object') {
    if (Array.isArray(content.content)) yield* walkContentParts(content.content);
    else yield content;
  }
}

/**
 * The text a text-only provider receives for a file/document part: exactly the
 * string every other provider's lowering produces (text files decoded, Office
 * files extracted, anything else the shared "[file not sent inline: …]"
 * description, an unreadable reference its placeholder). A PDF is converted
 * beforehand by preparePdfTextForProvider, so one reaching here is a bug.
 * Null when the part is not a file at all.
 */
export function textFormOfFilePart(part) {
  if (part?.type !== 'file' && part?.type !== 'document') return null;
  try {
    const file = fileInfo(part);
    if (!file) return null;
    const kind = fileKind(file);
    if (kind === 'pdf') throw pdfNotPrepared();
    return fileFallbackText(file, kind);
  } catch (error) {
    const unavailable = unavailableAttachmentText(part, error);
    if (unavailable === null) throw error;
    return unavailable;
  }
}

// Fixed text per media part type: repeated turns must lower identically.
const MEDIA_LABEL = {
  image: 'image',
  image_url: 'image',
  input_image: 'image',
  audio: 'audio',
  input_audio: 'audio',
  video: 'video',
  file: 'file',
  document: 'document',
};

/** The fixed text that stands for a media part the model cannot take. */
export function omittedMediaText(partType) {
  return `[${MEDIA_LABEL[partType]} omitted: local model is text-only]`;
}

const OMITTED_MEDIA_TEXT_RE = /^\[\w+ omitted: local model is text-only\]$/;
const NOT_SENT_FILE_TEXT_RE = /^\[file not sent inline:/;

/**
 * Whether a lowered text only says that media was left out (omittedMediaText,
 * or a file's "not sent inline" description) rather than carrying content.
 */
export function isUnsentMediaText(text) {
  return OMITTED_MEDIA_TEXT_RE.test(text) || NOT_SENT_FILE_TEXT_RE.test(text);
}

/**
 * Replaces the media parts with fixed text, recursing into nested
 * content. A file or document with a text form becomes that text (the same
 * string every provider gets); everything else becomes omittedMediaText.
 * Returns the same array when nothing changed.
 */
export function degradeMediaParts(parts) {
  let changed = false;
  const next = parts.map((part) => {
    if (part && typeof part === 'object' && Object.hasOwn(MEDIA_LABEL, part.type)) {
      changed = true;
      return { type: 'text', text: textFormOfFilePart(part) ?? omittedMediaText(part.type) };
    }
    if (part && typeof part === 'object' && Array.isArray(part.content)) {
      const inner = degradeMediaParts(part.content);
      if (inner !== part.content) {
        changed = true;
        return { ...part, content: inner };
      }
    }
    return part;
  });
  return changed ? next : parts;
}

function replacePdfParts(content, texts) {
  if (Array.isArray(content)) {
    let changed = false;
    const next = content.map((part) => {
      const replaced = replacePdfParts(part, texts);
      if (replaced !== part) changed = true;
      return replaced;
    });
    return changed ? next : content;
  }
  if (content && typeof content === 'object') {
    if (texts.has(content)) return { type: 'text', text: texts.get(content) };
    if (Array.isArray(content.content)) {
      const inner = replacePdfParts(content.content, texts);
      return inner === content.content ? content : { ...content, content: inner };
    }
  }
  return content;
}

/**
 * Awaited pre-send step for a provider that takes a PDF as text (nativePdf ===
 * false): returns the messages with every PDF part — inline or stored — replaced
 * by its `--- label ---\n<text>` text part, so the synchronous lowering after it
 * sees no PDF. Returns the same array when there is nothing to convert. Call it
 * where a request is built (every attempt), never from estimation. A blob that
 * is permanently gone is left alone (it lowers to its placeholder); a transient
 * read error or a pdf.js environment failure propagates and nothing is cached.
 */
export async function preparePdfTextForProvider(messages, provider) {
  if (providerTakesNativePdf(provider) || !Array.isArray(messages)) return messages;
  const found = [];
  for (const message of messages) {
    for (const part of walkContentParts(message?.content)) {
      if (part.type !== 'file' && part.type !== 'document') continue;
      let file;
      try {
        file = fileInfo(part);
      } catch (error) {
        if (unavailableAttachmentText(part, error) === null) throw error;
        continue;
      }
      if (file && fileKind(file) === 'pdf') found.push({ part, file });
    }
  }
  if (!found.length) return messages;
  const extracted = await Promise.all(found.map(({ file }) => pdfTextFor(file)));
  const texts = new Map(found.map(({ part, file }, i) => [part, `--- ${fileLabel(file)} ---\n${extracted[i]}`]));
  return messages.map((message) => {
    // A message whose content is one bare part becomes a one-part array.
    if (texts.has(message?.content)) return { ...message, content: [{ type: 'text', text: texts.get(message.content) }] };
    const content = replacePdfParts(message?.content, texts);
    return content === message?.content ? message : { ...message, content };
  });
}

// A referenced blob that is gone or fails its content check lowers to this
// fixed placeholder (null: the error is something else and must propagate).
// Only permanent failures (gone, corrupt, impossible size) are rewritten: a
// transient EBUSY/EPERM/EACCES/EMFILE keeps throwing, so one flaky read never
// changes what an already-sent turn lowers to. The text names the stored
// filename (or type) only — no path, no error text.
function unavailableAttachmentText(part, error) {
  if (!isAttachmentReference(part) || !isPermanentAttachmentError(error)) return null;
  const name = String(part.filename || '')
    .split(/[\\/]/)
    .pop();
  return `[attachment unavailable: ${name || part.mimeType || part.mediaType || part.type}]`;
}

function imageUrlFromPart(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'image_url' || block.type === 'input_image') {
    const value = block.image_url;
    if (typeof value === 'string') return value;
    if (value && typeof value.url === 'string') return value.url;
  }
  if (block.type === 'image' && block.source?.type === 'url' && typeof block.source.url === 'string') {
    return block.source.url;
  }
  const info = imageInfo(block);
  return info ? `data:${info.mimeType};base64,${info.data}` : null;
}

function imageFileUriFromPart(block) {
  if (!block || typeof block !== 'object') return null;
  const fileData = block.fileData || block.file_data;
  const fileUri = fileData?.fileUri || fileData?.file_uri;
  if (typeof fileUri === 'string' && fileUri) {
    return {
      fileUri,
      mimeType: cleanMimeType(fileData.mimeType || fileData.mime_type || fileData.mediaType || fileData.media_type),
    };
  }
  if (block.type === 'image' && typeof block.uri === 'string' && block.uri) {
    return {
      fileUri: block.uri,
      mimeType: cleanMimeType(block.mime_type || block.mimeType || block.media_type || block.mediaType),
    };
  }
  return null;
}

function imageFileIdFromPart(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'input_image' && typeof block.file_id === 'string' && block.file_id) {
    return block.file_id;
  }
  if (
    block.type === 'image' &&
    block.source?.type === 'file' &&
    typeof block.source.file_id === 'string' &&
    block.source.file_id
  ) {
    return block.source.file_id;
  }
  return null;
}

function imageInfoFromDataUrl(url) {
  const m = String(url || '').match(/^data:(image\/[a-z0-9.+_-]+);base64,(.+)$/is);
  if (!m) return null;
  return { mimeType: cleanMimeType(m[1]), data: m[2] };
}

function imageMimeFromDataUrl(url) {
  const m = String(url || '').match(/^data:(image\/[a-z0-9.+_-]+);base64,/i);
  return m ? cleanMimeType(m[1]) : null;
}

function textFromPart(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text' && isAttachmentReference(block)) return attachmentTextForPart(block);
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  return '';
}

function stringifyFallback(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function contentParts(content) {
  if (Array.isArray(content)) return content;
  if (content && typeof content === 'object' && Array.isArray(content.content)) {
    return content.content;
  }
  // The reference test comes first: it needs no blob read, which the others
  // would do merely to classify a referenced part.
  if (
    content &&
    typeof content === 'object' &&
    (isAttachmentReference(content) ||
      imageUrlFromPart(content) ||
      imageFileIdFromPart(content) ||
      imageFileUriFromPart(content) ||
      geminiInlineInfo(content) ||
      fileInfo(content))
  )
    return [content];
  return null;
}

// Provider lowering text for a part. A referenced blob that is gone or fails
// its integrity check lowers to a fixed placeholder instead of failing the send.
function jsonFallbackFromPart(block, nativePdf = true) {
  try {
    return rawJsonFallbackFromPart(block, nativePdf);
  } catch (error) {
    const unavailable = unavailableAttachmentText(block, error);
    if (unavailable === null) throw error;
    return unavailable;
  }
}

function rawJsonFallbackFromPart(block, nativePdf = true) {
  const text = textFromPart(block);
  if (text) return text;
  if (!block || typeof block !== 'object') return block == null ? '' : String(block);
  // A referenced image has no text either way; do not read its blob to learn
  // that it is an image.
  if (block.type === 'image' && isAttachmentReference(block)) return '';
  if (imageUrlFromPart(block) || imageFileIdFromPart(block) || imageFileUriFromPart(block) || geminiInlineInfo(block))
    return '';
  const file = fileInfo(block);
  if (file) {
    // A PDF rides as native media, so its bytes stay out of the text. Anything
    // else has no media form here and contributes its text or its description.
    const kind = fileKind(file);
    if (kind === 'pdf') {
      if (!nativePdf) throw pdfNotPrepared();
      return '';
    }
    return fileFallbackText(file, kind);
  }
  return stringifyFallback(block);
}

export function contentHasImage(content) {
  return contentImageCount(content) > 0;
}

function contentImageCount(content) {
  return contentImageDescriptors(content).length;
}

function positiveDimension(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function imageIdentity(kind, value, mimeType = '') {
  return createHash('sha256')
    .update(`${kind}\0${mimeType}\0`)
    .update(String(value || ''))
    .digest('hex');
}

function imageDescriptor(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'image' && isAttachmentReference(part)) {
    return {
      identity: imageIdentity('attachment-ref', part.attachmentRef, part.mimeType || part.mediaType),
      width: positiveDimension(part.width, part.dimensions?.width),
      height: positiveDimension(part.height, part.dimensions?.height),
      detail: String(part.detail || 'auto').toLowerCase(),
    };
  }
  const info = imageInfo(part);
  const inline = geminiInlineInfo(part);
  const url = imageUrlFromPart(part);
  const fileId = imageFileIdFromPart(part);
  const fileUri = imageFileUriFromPart(part);
  if (!info && !inline && !url && !fileId && !fileUri) return null;
  const imageUrl = part.image_url && typeof part.image_url === 'object' ? part.image_url : null;
  const source = part.source && typeof part.source === 'object' ? part.source : null;
  const inlineData = part.inlineData || part.inline_data;
  const dimensions = part.dimensions && typeof part.dimensions === 'object' ? part.dimensions : null;
  const width = positiveDimension(part.width, dimensions?.width, imageUrl?.width, source?.width, inlineData?.width);
  const height = positiveDimension(
    part.height,
    dimensions?.height,
    imageUrl?.height,
    source?.height,
    inlineData?.height
  );
  const detail = String(
    part.detail ?? imageUrl?.detail ?? source?.detail ?? inlineData?.detail ?? 'auto'
  ).toLowerCase();
  if (info || inline) {
    const raw = info || inline;
    return {
      identity: imageIdentity('inline', raw.data, raw.mimeType),
      width,
      height,
      detail,
    };
  }
  if (fileId) return { identity: imageIdentity('file-id', fileId), width, height, detail };
  if (fileUri) return { identity: imageIdentity('file-uri', fileUri.fileUri, fileUri.mimeType), width, height, detail };
  return { identity: imageIdentity('url', url), width, height, detail };
}

export function contentImageDescriptors(content) {
  const parts = contentParts(content);
  if (!parts) return [];
  return parts.map(imageDescriptor).filter(Boolean);
}

// Byte-free descriptors for inline document parts (context estimation). Only
// documents that travel as native media are billed here; a text-ish file is
// already priced as the text it becomes, and a binary file only costs its
// one-line description.
// The page count (recorded by intake and by the read tool) rides on the part
// itself, so an inline part and its stored reference carry the same one.
function pdfDescriptor(sizeBytes, part) {
  const pageCount = Math.floor(Number(part?.pageCount));
  return { mimeType: 'application/pdf', sizeBytes, ...(pageCount > 0 ? { pageCount } : {}) };
}

export function contentFileDescriptors(content) {
  const parts = contentParts(content);
  if (!parts) return [];
  return parts.flatMap((part) => {
    if (part?.type === 'file' && isAttachmentReference(part)) {
      const mimeType = String(part.mimeType || part.mediaType || 'application/pdf');
      if (inlineFileKind(mimeType, '') !== 'pdf') return [];
      return [pdfDescriptor(Number(part.sizeBytes) || 0, part)];
    }
    const file = fileInfo(part);
    if (!file || fileKind(file) !== 'pdf') return [];
    // The bytes decide the kind (see inlineFileKind), so a mislabelled PDF is
    // priced under the type it is stored as.
    return [pdfDescriptor(base64ByteLength(file.data), part)];
  });
}

// Wire bytes of the media one content carries: the base64 payload of an inline
// image or document, or the base64 size a stored attachment expands to (from
// its recorded size, never by reading the blob).
export function contentMediaBytes(content, { nativePdf = true } = {}) {
  const parts = contentParts(content);
  if (!parts) return 0;
  let bytes = 0;
  // Text and Office files (and a PDF on a provider that takes it as text)
  // travel as text, so they are not media. Only a PDF counts, and the same way
  // for an inline part and its reference: by MIME type, never by reading a blob.
  const countsAsMedia = (mimeType, data) => nativePdf && inlineFileKind(mimeType, data) === 'pdf';
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (isAttachmentReference(part)) {
      if (part.type === 'image') bytes += Math.ceil((Number(part.sizeBytes) || 0) / 3) * 4;
      else if (part.type === 'file' && countsAsMedia(String(part.mimeType || part.mediaType || 'application/pdf'), '')) {
        bytes += Math.ceil((Number(part.sizeBytes) || 0) / 3) * 4;
      }
      continue;
    }
    const image = imageInfo(part) || geminiInlineInfo(part);
    if (image) {
      bytes += image.data.length;
      continue;
    }
    const file = fileInfo(part);
    if (file) {
      if (countsAsMedia(file.mimeType, '')) bytes += file.data.length;
      continue;
    }
    const url = imageUrlFromPart(part);
    if (url?.startsWith('data:')) bytes += url.length;
  }
  return bytes;
}

// Images plus the documents that travel as native document blocks.
export function contentMediaCount(content, { nativePdf = true } = {}) {
  return contentImageDescriptors(content).length + (nativePdf ? contentFileDescriptors(content).length : 0);
}

function projectContentText(content, fallback, projectPart) {
  if (typeof content === 'string') return content;
  const parts = contentParts(content);
  if (!parts) return content == null ? fallback : stringifyFallback(content);
  const text = parts.map(projectPart).filter(Boolean).join('\n');
  return text || fallback;
}

export function contentToText(content, fallback = '', { nativePdf = true } = {}) {
  return projectContentText(content, fallback, (part) => jsonFallbackFromPart(part, nativePdf));
}

// Context estimation's text projection. A referenced file or text whose blob
// is missing is priced as the part's own metadata, like any part with no
// readable payload; a referenced image already projects to '' and is priced
// by its descriptor. Provider sends keep contentToText and the normalizers
// below, which lower a missing blob to "[attachment unavailable: …]" text.
function estimatePartText(part) {
  try {
    return rawJsonFallbackFromPart(part);
  } catch (error) {
    if (!isAttachmentReference(part) || !isPermanentAttachmentError(error)) throw error;
    return stringifyFallback(part);
  }
}

export function contentToEstimateText(content, fallback = '') {
  return projectContentText(content, fallback, estimatePartText);
}

function storedHistoryImagePlaceholder(part) {
  const info = imageInfo(part) || geminiInlineInfo(part);
  // Inline base64 already gives us its MIME type. Do not call
  // imageUrlFromPart in that case: it would manufacture a second
  // `data:...;base64,<entire payload>` string merely to discard it.
  const url = info ? null : imageUrlFromPart(part);
  const fileUri = info ? null : imageFileUriFromPart(part);
  const mimeType =
    info?.mimeType ||
    imageMimeFromDataUrl(url) ||
    fileUri?.mimeType ||
    (part?.type === 'image' ? DEFAULT_IMAGE_MIME : '');
  return `[Image omitted from stored history${mimeType ? `: ${mimeType}` : ''}]`;
}

// Live parts keep their identity across saves, so each inline image is hashed
// and written once and every projection returns the same stored part.
const storedImageParts = new WeakMap();

// One part the store refuses (over the size cap, disk error) must never fail the
// whole session save: the on-disk copy carries its placeholder text instead.
// Only successes are memoized — a failure is retried on the next save (a
// transient disk error must not pin the placeholder) and the live part is never
// touched, so provider lowering keeps sending the real bytes.
const loggedStoreFailures = new Set();

function storeOrNull(store, part) {
  try {
    return store(part);
  } catch (error) {
    const key = `${part?.type}:${error?.message || error}`;
    if (!loggedStoreFailures.has(key)) {
      loggedStoreFailures.add(key);
      console.error(`[attachments] inline ${part?.type} part saved as a placeholder: ${error?.message || error}`);
    }
    return null;
  }
}

function memoizedStore(memo, store, part) {
  if (memo.has(part)) return memo.get(part);
  const stored = storeOrNull(store, part);
  if (stored) memo.set(part, stored);
  return stored;
}

function storedImagePart(part) {
  return memoizedStore(storedImageParts, storeInlineImagePart, part);
}

const storedDocumentParts = new WeakMap();

function storedDocumentPart(part) {
  return memoizedStore(storedDocumentParts, storeInlineDocumentPart, part);
}

/**
 * Whether stored-history projection would rewrite this content (it still holds
 * inline media or URL/file-id images). Shape test only: nothing is written and
 * nothing throws.
 */
export function contentCarriesLiveMedia(content) {
  if (typeof content === 'string') return false;
  const parts = contentParts(content);
  return Boolean(parts?.some(partCarriesLiveMedia));
}

function partCarriesLiveMedia(part) {
  if (!part || typeof part !== 'object' || isAttachmentReference(part)) return false;
  if (
    part.type === 'image' ||
    part.type === 'image_url' ||
    part.type === 'input_image' ||
    imageUrlFromPart(part) ||
    imageFileIdFromPart(part) ||
    imageFileUriFromPart(part) ||
    geminiInlineInfo(part) ||
    fileInfo(part)
  ) {
    return true;
  }
  return Array.isArray(part.content) && contentCarriesLiveMedia(part.content);
}

function sanitizePartForStoredHistory(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return part;
  if (isAttachmentReference(part)) return part;
  // An inline base64 image persists as a content-addressed reference: the
  // reloaded transcript lowers to the same provider bytes, so evicting or
  // reloading the session keeps the provider prompt cache intact.
  const storedImage = part.type === 'image' ? storedImagePart(part) : null;
  if (storedImage) return storedImage;
  if (
    part.type === 'image' ||
    part.type === 'image_url' ||
    part.type === 'input_image' ||
    imageUrlFromPart(part) ||
    imageFileIdFromPart(part) ||
    imageFileUriFromPart(part) ||
    geminiInlineInfo(part)
  ) {
    return { type: 'text', text: storedHistoryImagePlaceholder(part) };
  }
  const file = fileInfo(part);
  if (file) {
    const storedDocument = storedDocumentPart(part);
    if (storedDocument) return storedDocument;
    return { type: 'text', text: `[File omitted from stored history: ${file.filename || file.mimeType}]` };
  }
  if (Array.isArray(part.content)) {
    const nextContent = sanitizeContentForStoredHistory(part.content);
    if (nextContent !== part.content) return { ...part, content: nextContent };
  }
  return part;
}

export function sanitizeContentForStoredHistory(content) {
  if (typeof content === 'string') return content;
  const parts = contentParts(content);
  if (!parts) return content;
  let changed = false;
  const out = parts.map((part) => {
    const next = sanitizePartForStoredHistory(part);
    if (next !== part) changed = true;
    return next;
  });
  if (!changed) return content;
  return Array.isArray(content) ? out : { ...content, content: out };
}

export function normalizeContentForAnthropic(content) {
  const parts = contentParts(content);
  if (!parts) return content;
  return parts.map((part) => {
    try {
      return normalizeAnthropicPart(part);
    } catch (error) {
      const unavailable = unavailableAttachmentText(part, error);
      if (unavailable === null) throw error;
      return { type: 'text', text: unavailable };
    }
  });
}

function normalizeAnthropicPart(part) {
  const file = fileInfo(part);
  if (file) {
    // A base64 document block is a PDF contract; a text document carries its
    // decoded text, and anything else is described rather than sent.
    const kind = fileKind(file);
    const title = file.filename ? { title: file.filename } : {};
    let out;
    if (kind === 'pdf') {
      out = {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: file.data },
        ...title,
      };
    } else if (kind === 'text') {
      out = {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: fileDecodedText(file) },
        ...title,
      };
    } else {
      out = { type: 'text', text: fileFallbackText(file, kind) };
    }
    if (part.cache_control) out.cache_control = part.cache_control;
    return out;
  }
  const info = imageInfo(part);
  if (info) {
    const out = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: info.mimeType,
        data: info.data,
      },
    };
    if (part.cache_control) out.cache_control = part.cache_control;
    return out;
  }
  const fileId = imageFileIdFromPart(part);
  if (fileId) {
    return { type: 'image', source: { type: 'file', file_id: fileId } };
  }
  const url = imageUrlFromPart(part);
  const dataUrlInfo = imageInfoFromDataUrl(url);
  if (dataUrlInfo) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: dataUrlInfo.mimeType,
        data: dataUrlInfo.data,
      },
    };
  }
  if (url) {
    return { type: 'image', source: { type: 'url', url } };
  }
  if (part?.type === 'image') {
    if (part.source?.type === 'url' && typeof part.source.url === 'string') return part;
    if (part.source?.type === 'file' && typeof part.source.file_id === 'string') return part;
    return { type: 'text', text: `[unsupported image content: ${stringifyFallback(part)}]` };
  }
  if (part?.type === 'tool_result') {
    let nested;
    if (Array.isArray(part.content)) nested = normalizeContentForAnthropic(part.content);
    else if (typeof part.content === 'string') nested = part.content;
    else nested = part.content == null ? '' : stringifyFallback(part.content);
    return { ...part, content: nested };
  }
  if (part?.type === 'input_text' || part?.type === 'output_text') {
    return { type: 'text', text: part.text || '' };
  }
  if (part?.type === 'text' && isAttachmentReference(part)) {
    return { type: 'text', text: attachmentTextForPart(part) };
  }
  return part;
}

// `nativePdf: false` marks a provider that takes a PDF as text: its PDFs were
// converted by preparePdfTextForProvider, so a PDF part reaching these
// normalizers is an error rather than a file block the provider cannot read.
export function normalizeContentForOpenAIChat(content, { role = 'user', nativePdf = true } = {}) {
  const parts = contentParts(content);
  if (!parts) return content;
  const out = [];
  for (const part of parts) {
    try {
      const file = fileInfo(part);
      if (file) {
        const kind = fileKind(file);
        if (kind === 'pdf') {
          if (!nativePdf) throw pdfNotPrepared();
          out.push({
            type: 'file',
            file: { filename: file.filename || 'document.pdf', file_data: `data:application/pdf;base64,${file.data}` },
          });
        } else {
          out.push({ type: 'text', text: fileFallbackText(file, kind) });
        }
        continue;
      }
      const fileId = imageFileIdFromPart(part);
      if (fileId) {
        out.push({ type: 'text', text: `[unsupported image file_id for OpenAI Chat-compatible request: ${fileId}]` });
        continue;
      }
      const fileUri = imageFileUriFromPart(part);
      if (fileUri) {
        out.push({ type: 'image_url', image_url: { url: fileUri.fileUri } });
        continue;
      }
      const url = imageUrlFromPart(part);
      if (url) {
        out.push({ type: 'image_url', image_url: { url } });
        continue;
      }
      const text = jsonFallbackFromPart(part, nativePdf);
      if (text) out.push({ type: 'text', text });
    } catch (error) {
      const unavailable = unavailableAttachmentText(part, error);
      if (unavailable === null) throw error;
      out.push({ type: 'text', text: unavailable });
    }
  }
  if (role !== 'user')
    return out
      .map((part) => part.text || '')
      .filter(Boolean)
      .join('\n');
  return out.length ? out : contentToText(content, '');
}

export function normalizeContentForOpenAIResponses(content, { role = 'user', nativePdf = true } = {}) {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  if (typeof content === 'string') return content ? [{ type: textType, text: content }] : [];
  const parts = contentParts(content);
  if (!parts) {
    const text = content == null ? '' : stringifyFallback(content);
    return text ? [{ type: textType, text }] : [];
  }
  const out = [];
  for (const part of parts) {
    try {
      const file = fileInfo(part);
      if (file) {
        const kind = fileKind(file);
        if (kind === 'pdf') {
          if (!nativePdf) throw pdfNotPrepared();
          out.push({
            type: 'input_file',
            filename: file.filename || 'document.pdf',
            file_data: `data:application/pdf;base64,${file.data}`,
          });
        } else {
          out.push({ type: textType, text: fileFallbackText(file, kind) });
        }
        continue;
      }
      const fileId = imageFileIdFromPart(part);
      if (fileId) {
        out.push({ type: 'input_image', file_id: fileId });
        continue;
      }
      const fileUri = imageFileUriFromPart(part);
      if (fileUri) {
        out.push({ type: 'input_image', image_url: fileUri.fileUri });
        continue;
      }
      const url = imageUrlFromPart(part);
      if (url) {
        out.push({ type: 'input_image', image_url: url });
        continue;
      }
      const text = jsonFallbackFromPart(part, nativePdf);
      if (text) out.push({ type: textType, text });
    } catch (error) {
      const unavailable = unavailableAttachmentText(part, error);
      if (unavailable === null) throw error;
      out.push({ type: textType, text: unavailable });
    }
  }
  return out;
}

export function normalizeContentForGeminiParts(content) {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  const parts = contentParts(content);
  if (!parts) {
    const text = content == null ? '' : stringifyFallback(content);
    return text ? [{ text }] : [];
  }
  const out = [];
  for (const part of parts) {
    try {
      const file = fileInfo(part);
      if (file) {
        const kind = fileKind(file);
        if (kind === 'pdf') out.push({ inlineData: { mimeType: 'application/pdf', data: file.data } });
        else out.push({ text: fileFallbackText(file, kind) });
        continue;
      }
      const inlineInfo = geminiInlineInfo(part);
      if (inlineInfo) {
        out.push({ inlineData: { mimeType: inlineInfo.mimeType, data: inlineInfo.data } });
        continue;
      }
      const fileUri = imageFileUriFromPart(part);
      if (fileUri) {
        out.push({ fileData: { mimeType: fileUri.mimeType, fileUri: fileUri.fileUri } });
        continue;
      }
      const fileId = imageFileIdFromPart(part);
      if (fileId) {
        out.push({ text: `[unsupported image file_id for Gemini request: ${fileId}]` });
        continue;
      }
      const info = imageInfo(part);
      if (info) {
        out.push({ inlineData: { mimeType: info.mimeType, data: info.data } });
        continue;
      }
      const url = imageUrlFromPart(part);
      const dataUrlInfo = imageInfoFromDataUrl(url);
      if (dataUrlInfo) {
        out.push({ inlineData: { mimeType: dataUrlInfo.mimeType, data: dataUrlInfo.data } });
        continue;
      }
      if (url && !url.startsWith('data:')) {
        out.push({ fileData: { mimeType: DEFAULT_IMAGE_MIME, fileUri: url } });
        continue;
      }
      const text = jsonFallbackFromPart(part);
      if (text) out.push({ text });
    } catch (error) {
      const unavailable = unavailableAttachmentText(part, error);
      if (unavailable === null) throw error;
      out.push({ text: unavailable });
    }
  }
  return out;
}

const OPENAI_CHAT_MEDIA_TYPES = new Set(['image_url', 'file']);
const OPENAI_RESPONSES_MEDIA_TYPES = new Set(['input_image', 'input_file']);

function mediaPartsOnly(parts, allowedTypes) {
  if (!Array.isArray(parts)) return [];
  return parts.filter((part) => allowedTypes.has(part?.type));
}

export function splitToolContentForOpenAIChat(content, { nativePdf = true } = {}) {
  const mediaContent = mediaPartsOnly(
    normalizeContentForOpenAIChat(content, { role: 'user', nativePdf }),
    OPENAI_CHAT_MEDIA_TYPES
  );
  if (!mediaContent.length) return { output: contentToText(content, '', { nativePdf }), mediaContent: null };
  return {
    output: contentToText(content, '[tool result included media content in the following user message]', { nativePdf }),
    mediaContent,
  };
}

export function splitToolContentForOpenAIResponses(content) {
  const output = normalizeContentForOpenAIResponses(content, { role: 'user' });
  const hasMedia = mediaPartsOnly(output, OPENAI_RESPONSES_MEDIA_TYPES).length > 0;
  if (!hasMedia) return { output: contentToText(content, ''), mediaContent: null };
  return {
    // Responses natively accepts ordered input_text/input_image/input_file
    // items inside function_call_output.output.
    output,
    mediaContent: null,
  };
}

export function splitToolContentForXaiResponses(content, { nativePdf = true } = {}) {
  const normalized = normalizeContentForOpenAIResponses(content, { role: 'user', nativePdf });
  const mediaContent = mediaPartsOnly(normalized, new Set(['input_image']));
  if (!mediaContent.length) {
    const hasDocument = normalized.some((part) => part?.type === 'input_file');
    return {
      output: contentToText(
        content,
        hasDocument ? '[tool result included document content unavailable to xAI Responses]' : '',
        { nativePdf }
      ),
      mediaContent: null,
    };
  }
  return {
    // xAI documents function_call_output as text/JSON; media remains a
    // following user input, without replaying the tool-result text there.
    output: contentToText(content, '[tool result included image content in the following user message]', { nativePdf }),
    mediaContent,
  };
}

export function splitToolContentForGemini(content) {
  if (!contentHasImage(content)) {
    // Raw passthrough is for text and plain objects only: a file part would
    // serialize its base64 payload straight into the function response.
    // Decided by part shape: classifying a stored file must not read its blob.
    const hasFile = contentParts(content)?.some(
      (part) => part?.type === 'file' || (part?.type === 'document' && part.source?.type === 'base64')
    );
    return { response: { result: hasFile ? contentToText(content, '') : content }, mediaParts: [] };
  }
  return {
    response: { result: contentToText(content, '[tool result included image content]') },
    mediaParts: normalizeContentForGeminiParts(content),
  };
}
