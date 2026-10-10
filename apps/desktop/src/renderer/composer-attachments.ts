import type { RecordValue } from './desktop-types';
import { fileLooksLikeText } from './file-content';
import { asRecord } from './text-format';
import {
  MAX_COMPOSER_ATTACHMENTS,
  MAX_IMAGE_FILE_BYTES,
  MAX_INLINE_FILE_BASE64_TOTAL,
  MAX_INLINE_FILE_BYTES,
  MAX_INLINE_IMAGE_BASE64_TOTAL,
  MAX_INLINE_TEXT_TOTAL,
  MAX_OFFICE_FILE_BYTES,
  MAX_PDF_FILE_BYTES,
  type ComposerAttachment,
} from './composer-support';
import { t } from './i18n';
import { isRemoteBrowserRenderer } from './remote-ui-projection';
import { learnedRelayUplinkBinaryBytes } from './remote-shim-payload-limit';
import {
  LEGACY_OFFICE_REPLACEMENT,
  MAX_PROMPT_IMAGE_BASE64_LENGTH,
  OFFICE_MIME_BY_EXTENSION,
  canonicalPromptFileMimeType,
  PDF_MIME_TYPE,
  PROMPT_IMAGE_MIME_PATTERN,
} from '../shared/prompt-limits';

// Matches the runtime's vision ceiling: standard models downscale anything
// past 1568px on the longest edge, so attaching more pixels than that only
// inflates the upload and the context estimate.
const WEB_IMAGE_MAX_WIDTH = 1_568;
const WEB_IMAGE_MAX_HEIGHT = 1_568;
const WEB_IMAGE_TARGET_BYTES = 3_750_000;
// Above this, re-encoding a lossless PNG pays for itself several times over.
const WEB_IMAGE_PNG_REENCODE_BYTES = 300_000;
export const SUPPORTED_IMAGE_TYPES = PROMPT_IMAGE_MIME_PATTERN;
export const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const SUPPORTED_IMAGE_PATH = /\.(?:png|jpe?g|gif|webp)$/i;
const TEXT_LIKE_MIME = /^application\/(?:json|ld\+json|toml|x-toml|yaml|x-yaml|xml)$/;
const TEXT_LIKE_EXTENSION =
  /\.(?:md|mdx|txt|json|jsonl|ya?ml|toml|xml|csv|tsv|[cm]?[jt]sx?|py|rb|rs|go|java|kt|swift|cs|cpp|cc|c|h|hh|hpp|sh|zsh|ps1|bat|cmd|sql|css|scss|sass|html|htm|vue|svelte|log|env|ini|conf|cfg|gql|graphql)$/i;

export function isSupportedComposerImagePath(path: string): boolean {
  return SUPPORTED_IMAGE_PATH.test(String(path || '').trim());
}

export function fileExtension(name: string): string {
  const match = /\.([^./\\]+)$/.exec(String(name || '').trim());
  return match ? match[1].toLowerCase() : '';
}

/** OOXML MIME type for a .docx/.pptx/.xlsx/.xlsm name, else ''. */
export function officeMimeForName(name: string): string {
  return OFFICE_MIME_BY_EXTENSION[fileExtension(name)] || '';
}

/** The OOXML extension to save a legacy .doc/.xls/.ppt as, else ''. */
export function legacyOfficeReplacement(name: string): string {
  return LEGACY_OFFICE_REPLACEMENT[fileExtension(name)] || '';
}

/** True when the file starts with the `%PDF-` signature. */
export async function hasPdfHeader(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  return head.length === 5 && String.fromCharCode(...head) === '%PDF-';
}

/** Rejection that must not fall back to inserting the file's path. */
export class RejectedComposerFileError extends Error {}

// Prompt JSON, the encrypted envelope and the rest of the turn share the frame.
const REMOTE_FRAME_RESERVE_BYTES = 8 * 1024;

/** Largest raw attachment (bytes) one relay frame can carry as base64, or null
 *  when there is no learned ceiling to enforce. */
export function remoteAttachmentLimitBytes(binaryCeiling: number | null): number | null {
  if (binaryCeiling === null) return null;
  return Math.max(0, Math.floor(((binaryCeiling - REMOTE_FRAME_RESERVE_BYTES) * 3) / 4));
}

/** Empty when `rawBytes` fits the relay's learned uplink ceiling (or this is
 *  not a remote session), else the message shown at attach time. */
export function remoteAttachmentSizeError(
  name: string,
  rawBytes: number,
  binaryCeiling: number | null = isRemoteBrowserRenderer() ? learnedRelayUplinkBinaryBytes() : null
): string {
  const limit = remoteAttachmentLimitBytes(binaryCeiling);
  if (limit === null || rawBytes <= limit) return '';
  const mb = (value: number) => `${(value / (1024 * 1024)).toFixed(value >= 1024 * 1024 ? 1 : 2)} MB`;
  return `${name}: ${mb(rawBytes)} is over this remote connection's ${mb(limit)} limit per attachment.`;
}

/** Empty when the attachment fits the per-turn budget, else the user message. */
export function attachmentPolicyError(
  currentAttachments: ComposerAttachment[],
  attachment: ComposerAttachment
): string {
  const remoteError = remoteAttachmentSizeError(
    attachment.name,
    attachment.kind === 'text' ? attachment.data.length : Math.ceil((attachment.data.length * 3) / 4)
  );
  if (remoteError) return remoteError;
  if (currentAttachments.length >= MAX_COMPOSER_ATTACHMENTS) {
    return `Attach up to ${MAX_COMPOSER_ATTACHMENTS} items at a time.`;
  }
  const textTotal =
    currentAttachments.reduce((sum, item) => sum + (item.kind === 'text' ? item.data.length : 0), 0) +
    (attachment.kind === 'text' ? attachment.data.length : 0);
  if (textTotal > MAX_INLINE_TEXT_TOTAL) {
    return 'Inline text attachments are too large together. Keep the total under 850 KB.';
  }
  if (attachment.kind === 'image' && attachment.data.length > MAX_PROMPT_IMAGE_BASE64_LENGTH) {
    return `${attachment.name}: use PNG, JPEG, GIF, or WebP under 12 MB.`;
  }
  const imageTotal =
    currentAttachments.reduce((sum, item) => sum + (item.kind === 'image' ? item.data.length : 0), 0) +
    (attachment.kind === 'image' ? attachment.data.length : 0);
  if (imageTotal > MAX_INLINE_IMAGE_BASE64_TOTAL) {
    return 'Attached images are too large together. Remove one or use smaller files.';
  }
  const isFilePart = (item: ComposerAttachment) => item.kind === 'pdf' || item.kind === 'office';
  const fileTotal =
    currentAttachments.reduce((sum, item) => sum + (isFilePart(item) ? item.data.length : 0), 0) +
    (isFilePart(attachment) ? attachment.data.length : 0);
  if (fileTotal > MAX_INLINE_FILE_BASE64_TOTAL) {
    return t('Attached PDFs and Office files are too large together. Remove one or use smaller files.');
  }
  return '';
}

async function base64Payload(file: Blob, failure: string): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(failure));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

function imageMetadataText(
  displayName: string,
  originalWidth: number,
  originalHeight: number,
  displayWidth: number,
  displayHeight: number
): string {
  const resized = originalWidth !== displayWidth || originalHeight !== displayHeight;
  const parts = [`source: ${displayName}`, `${originalWidth}x${originalHeight}`];
  if (resized) {
    const scale = originalWidth / displayWidth;
    parts.push(
      `displayed at ${displayWidth}x${displayHeight}. Multiply coordinates by ${scale.toFixed(2)} to map to the original image.`
    );
  } else {
    parts.push(`displayed at ${displayWidth}x${displayHeight}`);
  }
  return `[Image: ${parts.join(', ')}]`;
}

function canvasBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('image encoding failed'))), mimeType, quality);
  });
}

function decodeImageElement(objectUrl: string, displayName: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onerror = () => reject(new Error(`${displayName}: could not decode image.`));
    element.onload = () => resolve(element);
    element.src = objectUrl;
  });
}

// WebP first: it keeps alpha, which JPEG cannot, at a fraction of what
// the same pixels cost as PNG — and a phone screenshot re-encoded as
// PNG was the largest attachment a remote surface could send. A browser
// without WebP encoding returns some other type, which this checks.
async function reencodedImage(
  image: HTMLImageElement,
  file: File,
  displayName: string,
  displayWidth: number,
  displayHeight: number
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = displayWidth;
  canvas.height = displayHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(`${displayName}: image resize is unavailable.`);
  context.drawImage(image, 0, 0, displayWidth, displayHeight);
  let payload = await canvasBlob(canvas, 'image/webp', 0.85);
  if (payload.type !== 'image/webp') {
    const fallbackType = /^image\/jpe?g$/i.test(file.type) ? 'image/jpeg' : 'image/png';
    payload = await canvasBlob(canvas, fallbackType, fallbackType === 'image/png' ? undefined : 0.85);
  }
  if (payload.size > WEB_IMAGE_TARGET_BYTES && payload.type !== 'image/jpeg') {
    payload = await canvasBlob(canvas, 'image/jpeg', 0.82);
  }
  return payload;
}

async function browserResizedImage(
  file: File,
  displayName: string
): Promise<{
  data: string;
  mimeType: string;
  metadataText: string;
}> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await decodeImageElement(objectUrl, displayName);
    const originalWidth = image.naturalWidth;
    const originalHeight = image.naturalHeight;
    if (!originalWidth || !originalHeight) throw new Error(`${displayName}: image dimensions are invalid.`);
    const scale = Math.min(1, WEB_IMAGE_MAX_WIDTH / originalWidth, WEB_IMAGE_MAX_HEIGHT / originalHeight);
    const displayWidth = Math.max(1, Math.floor(originalWidth * scale));
    const displayHeight = Math.max(1, Math.floor(originalHeight * scale));
    // A PNG is lossless, so a screenshot stays enormous next to the same
    // pixels in WebP even when it fits the generic budget. Re-encode it well
    // before that budget; GIFs are left alone because a canvas round trip
    // would drop every frame but the first.
    const oversizedLossless = /^image\/png$/i.test(file.type) && file.size > WEB_IMAGE_PNG_REENCODE_BYTES;
    const needsResize = scale < 1 || file.size > WEB_IMAGE_TARGET_BYTES || oversizedLossless;
    const payload: Blob = needsResize
      ? await reencodedImage(image, file, displayName, displayWidth, displayHeight)
      : file;
    return {
      data: await base64Payload(payload, `${displayName}: could not read image.`),
      mimeType: payload.type || file.type,
      metadataText: imageMetadataText(displayName, originalWidth, originalHeight, displayWidth, displayHeight),
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// TUI parity: route images through the engine's optional-sharp resize pipeline
// so desktop submits the same downscaled payload the terminal client would.
// Hosts without the capability (older engines, test stubs) keep the raw attach,
// while a REAL resize failure blocks the attach exactly like the TUI paste path.
async function resizedImage(
  file: File,
  data: string,
  mimeType: string,
  displayName: string
): Promise<{
  data: string;
  mimeType: string;
  metadataText: string;
}> {
  // Browser-selected files and keyboard/clipboard screenshots already live in
  // this process. Resize them here instead of sending the full original over
  // the relay and waiting for a second RPC before the attachment chip appears.
  if (isRemoteBrowserRenderer()) return browserResizedImage(file, displayName);
  const invokeResize = window.mixdogDesktop?.invokeCapability;
  if (typeof invokeResize !== 'function') return { data, mimeType, metadataText: '' };
  try {
    const result = await invokeResize<RecordValue>({
      capability: 'resizeImage',
      args: [{ data, mimeType, filename: displayName }],
    });
    const value = asRecord(result?.value);
    if (typeof value?.data === 'string' && value.data) {
      return {
        data: value.data,
        mimeType: String(value.mimeType || mimeType),
        metadataText: String(value.metadataText || ''),
      };
    }
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (!/does not support|capability is unavailable/i.test(message)) {
      throw new Error(`${displayName}: ${message}`);
    }
  }
  return { data, mimeType, metadataText: '' };
}

type AttachmentInput = { file: File; id: number; displayName: string; cancelled: () => boolean };

export class UnsupportedComposerFileError extends Error {}

async function imageAttachment({
  file,
  id,
  displayName,
  cancelled,
}: AttachmentInput): Promise<ComposerAttachment | null> {
  if (!SUPPORTED_IMAGE_TYPES.test(file.type)) {
    throw new UnsupportedComposerFileError(`${displayName}: use PNG, JPEG, GIF, or WebP under 12 MB.`);
  }
  if (file.size > MAX_IMAGE_FILE_BYTES) {
    throw new Error(`${displayName}: use PNG, JPEG, GIF, or WebP under 12 MB.`);
  }
  // A remote browser re-encodes below the ceiling, so only the final payload
  // is judged (attachmentPolicyError); a local raw attach is judged here.
  const raw = await base64Payload(file, `${displayName}: could not read image.`);
  if (cancelled()) return null;
  const image = await resizedImage(file, raw, file.type, displayName);
  if (cancelled()) return null;
  return {
    id,
    name: displayName,
    kind: 'image',
    mimeType: image.mimeType,
    data: image.data,
    ...(image.metadataText ? { metadataText: image.metadataText } : {}),
    // Chip-only: images carry no bracket token, the thumbnail chip is their
    // sole representation in the draft.
    token: '',
  };
}

async function pdfAttachment({
  file,
  id,
  displayName,
  cancelled,
}: AttachmentInput): Promise<ComposerAttachment | null> {
  if (file.size > MAX_PDF_FILE_BYTES) throw new Error(`${displayName}: PDFs must be under 20 MB.`);
  const remoteSize = remoteAttachmentSizeError(displayName, file.size);
  if (remoteSize) throw new RejectedComposerFileError(remoteSize);
  if (!(await hasPdfHeader(file))) {
    throw new Error(t('{{name}}: this file is not a valid PDF.', { name: displayName }));
  }
  if (cancelled()) return null;
  const data = await base64Payload(file, `${displayName}: could not read PDF.`);
  if (cancelled()) return null;
  return {
    id,
    name: displayName,
    kind: 'pdf',
    mimeType: 'application/pdf',
    data,
    token: `[PDF #${id}: ${displayName}]`,
  };
}

async function officeAttachment(
  { file, id, displayName, cancelled }: AttachmentInput,
  mimeType: string
): Promise<ComposerAttachment | null> {
  if (file.size > MAX_OFFICE_FILE_BYTES) {
    throw new Error(t('{{name}}: Office files must be under 20 MB.', { name: displayName }));
  }
  const remoteSize = remoteAttachmentSizeError(displayName, file.size);
  if (remoteSize) throw new RejectedComposerFileError(remoteSize);
  const data = await base64Payload(file, `${displayName}: could not read file.`);
  if (cancelled()) return null;
  return {
    id,
    name: displayName,
    kind: 'office',
    mimeType,
    data,
    token: `[File #${id}: ${displayName}]`,
  };
}

async function textAttachment(
  { file, id, displayName, cancelled }: AttachmentInput,
  mimeKind: string
): Promise<ComposerAttachment | null> {
  const textLike =
    mimeKind.startsWith('text/') ||
    TEXT_LIKE_MIME.test(mimeKind) ||
    mimeKind.endsWith('+json') ||
    mimeKind.endsWith('+xml') ||
    TEXT_LIKE_EXTENSION.test(displayName) ||
    (await fileLooksLikeText(file));
  if (!textLike) {
    throw new UnsupportedComposerFileError(`${displayName}: this file type can't be attached.`);
  }
  if (file.size > MAX_INLINE_FILE_BYTES) {
    throw new Error(`${displayName}: text files must be under 750 KB.`);
  }
  const remoteSize = remoteAttachmentSizeError(displayName, file.size);
  if (remoteSize) throw new RejectedComposerFileError(remoteSize);
  const text = await file.text();
  if (cancelled()) return null;
  if (text.length > MAX_INLINE_FILE_BYTES) {
    throw new Error(`${displayName}: inline text is too large after decoding.`);
  }
  return {
    id,
    name: displayName,
    kind: 'text',
    mimeType: !file.type || file.type === 'application/octet-stream' ? 'text/plain' : file.type,
    data: text,
    token: `[File #${id}: ${displayName}]`,
    source: 'file',
  };
}

/** Convert one dropped/pasted file into an attachment, rejecting anything the
 *  engine cannot inline. Returns null when `cancelled` turns true mid-read —
 *  the caller must stop ingesting the remaining files then. */
export async function attachmentFromFile(
  file: File,
  options: {
    id: number;
    cancelled?: () => boolean;
  }
): Promise<ComposerAttachment | null> {
  const { id, cancelled = () => false } = options;
  const displayName = file.name || (file.type.startsWith('image/') ? 'Pasted image' : 'Pasted file');
  const input: AttachmentInput = { file, id, displayName, cancelled };
  if (file.size === 0) {
    throw new RejectedComposerFileError(t('{{name}}: the file is empty.', { name: displayName }));
  }
  const legacyFormat = legacyOfficeReplacement(displayName);
  if (legacyFormat) {
    throw new RejectedComposerFileError(
      t("{{name}}: legacy Office files can't be attached. Save it as {{format}} and try again.", {
        name: displayName,
        format: legacyFormat,
      })
    );
  }
  // Windows often reports an empty or octet-stream type; the extension then
  // decides the image type (PDF and Office are already decided by name).
  const reportedType = (file.type || '').split(';', 1)[0].trim().toLowerCase();
  const imageType = IMAGE_MIME_BY_EXTENSION[fileExtension(displayName)];
  if (imageType && (!reportedType || reportedType === 'application/octet-stream')) {
    return imageAttachment({ ...input, file: new File([file], displayName, { type: imageType }) });
  }
  if (file.type.startsWith('image/')) return imageAttachment(input);
  const mimeKind = reportedType;
  if (mimeKind === PDF_MIME_TYPE || /\.pdf$/i.test(displayName)) return pdfAttachment(input);
  const officeMime = officeMimeForName(displayName) || canonicalPromptFileMimeType(mimeKind);
  if (officeMime) return officeAttachment(input, officeMime);
  return textAttachment(input, mimeKind);
}
