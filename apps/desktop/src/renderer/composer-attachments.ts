// Composer attachment ingestion: the shared budget policy plus the file ->
// attachment conversion (engine-side image resize, PDF, inline text).
// Extracted from Composer.tsx, which keeps token insertion, draft edits and
// error surfacing.
import type { RecordValue } from "./desktop-types";
import { fileLooksLikeText } from "./file-content";
import { asRecord } from "./text-format";
import {
  MAX_COMPOSER_ATTACHMENTS,
  MAX_INLINE_FILE_BYTES,
  MAX_INLINE_IMAGE_BASE64_TOTAL,
  MAX_INLINE_TEXT_TOTAL,
  MAX_PDF_FILE_BYTES,
  type ComposerAttachment,
} from "./composer-support";
import { isRemoteBrowserRenderer } from "./remote-ui-projection";

const MAX_IMAGE_FILE_BYTES = 12_000_000;
const WEB_IMAGE_MAX_WIDTH = 2_000;
const WEB_IMAGE_MAX_HEIGHT = 2_000;
const WEB_IMAGE_TARGET_BYTES = 3_750_000;
// Above this, re-encoding a lossless PNG pays for itself several times over.
const WEB_IMAGE_PNG_REENCODE_BYTES = 300_000;
const SUPPORTED_IMAGE_TYPES = /^image\/(?:png|jpe?g|gif|webp)$/i;
const SUPPORTED_IMAGE_PATH = /\.(?:png|jpe?g|gif|webp)$/i;
const TEXT_LIKE_MIME = /^application\/(?:json|ld\+json|toml|x-toml|yaml|x-yaml|xml)$/;
const TEXT_LIKE_EXTENSION = /\.(?:md|mdx|txt|json|jsonl|ya?ml|toml|xml|csv|tsv|[cm]?[jt]sx?|py|rb|rs|go|java|kt|swift|cs|cpp|cc|c|h|hh|hpp|sh|zsh|ps1|bat|cmd|sql|css|scss|sass|html|htm|vue|svelte|log|env|ini|conf|cfg|gql|graphql)$/i;

export function isSupportedComposerImagePath(path: string): boolean {
  return SUPPORTED_IMAGE_PATH.test(String(path || "").trim());
}

/** Empty when the attachment fits the per-turn budget, else the user message. */
export function attachmentPolicyError(
  currentAttachments: ComposerAttachment[],
  attachment: ComposerAttachment,
): string {
  if (currentAttachments.length >= MAX_COMPOSER_ATTACHMENTS) {
    return `Attach up to ${MAX_COMPOSER_ATTACHMENTS} items at a time.`;
  }
  const textTotal = currentAttachments.reduce((sum, item) =>
    sum + (item.kind === 'text' ? item.data.length : 0), 0) +
    (attachment.kind === 'text' ? attachment.data.length : 0);
  if (textTotal > MAX_INLINE_TEXT_TOTAL) {
    return 'Inline text attachments are too large together. Keep the total under 850 KB.';
  }
  const imageTotal = currentAttachments.reduce((sum, item) =>
    sum + (item.kind === 'image' || item.kind === 'pdf' ? item.data.length : 0), 0) +
    (attachment.kind === 'image' || attachment.kind === 'pdf' ? attachment.data.length : 0);
  if (imageTotal > MAX_INLINE_IMAGE_BASE64_TOTAL) {
    return 'Attached images and PDFs are too large together. Remove one or use smaller files.';
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
  displayHeight: number,
): string {
  const resized = originalWidth !== displayWidth || originalHeight !== displayHeight;
  const parts = [`source: ${displayName}`, `${originalWidth}x${originalHeight}`];
  if (resized) {
    const scale = originalWidth / displayWidth;
    parts.push(`displayed at ${displayWidth}x${displayHeight}. Multiply coordinates by ${scale.toFixed(2)} to map to the original image.`);
  } else {
    parts.push(`displayed at ${displayWidth}x${displayHeight}`);
  }
  return `[Image: ${parts.join(', ')}]`;
}

function canvasBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('image encoding failed')),
      mimeType,
      quality,
    );
  });
}

async function browserResizedImage(file: File, displayName: string): Promise<{
  data: string;
  mimeType: string;
  metadataText: string;
}> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onerror = () => reject(new Error(`${displayName}: could not decode image.`));
      element.onload = () => resolve(element);
      element.src = objectUrl;
    });
    const originalWidth = image.naturalWidth;
    const originalHeight = image.naturalHeight;
    if (!originalWidth || !originalHeight) throw new Error(`${displayName}: image dimensions are invalid.`);
    const scale = Math.min(
      1,
      WEB_IMAGE_MAX_WIDTH / originalWidth,
      WEB_IMAGE_MAX_HEIGHT / originalHeight,
    );
    const displayWidth = Math.max(1, Math.floor(originalWidth * scale));
    const displayHeight = Math.max(1, Math.floor(originalHeight * scale));
    // A PNG is lossless, so a screenshot stays enormous next to the same
    // pixels in WebP even when it fits the generic budget. Re-encode it well
    // before that budget; GIFs are left alone because a canvas round trip
    // would drop every frame but the first.
    const oversizedLossless = /^image\/png$/i.test(file.type)
      && file.size > WEB_IMAGE_PNG_REENCODE_BYTES;
    const needsResize = scale < 1
      || file.size > WEB_IMAGE_TARGET_BYTES
      || oversizedLossless;
    let payload: Blob = file;
    if (needsResize) {
      const canvas = document.createElement('canvas');
      canvas.width = displayWidth;
      canvas.height = displayHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error(`${displayName}: image resize is unavailable.`);
      context.drawImage(image, 0, 0, displayWidth, displayHeight);
      // WebP first: it keeps alpha, which JPEG cannot, at a fraction of what
      // the same pixels cost as PNG — and a phone screenshot re-encoded as
      // PNG was the largest attachment a remote surface could send. A browser
      // without WebP encoding returns some other type, which this checks.
      payload = await canvasBlob(canvas, 'image/webp', 0.85);
      if (payload.type !== 'image/webp') {
        const fallbackType = /^image\/jpe?g$/i.test(file.type) ? 'image/jpeg' : 'image/png';
        payload = await canvasBlob(
          canvas,
          fallbackType,
          fallbackType === 'image/png' ? undefined : 0.85,
        );
      }
      if (payload.size > WEB_IMAGE_TARGET_BYTES && payload.type !== 'image/jpeg') {
        payload = await canvasBlob(canvas, 'image/jpeg', 0.82);
      }
    }
    return {
      data: await base64Payload(payload, `${displayName}: could not read image.`),
      mimeType: payload.type || file.type,
      metadataText: imageMetadataText(
        displayName,
        originalWidth,
        originalHeight,
        displayWidth,
        displayHeight,
      ),
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// TUI parity: route images through the engine's optional-sharp resize pipeline
// so desktop submits the same downscaled payload the terminal client would.
// Hosts without the capability (older engines, test stubs) keep the raw attach,
// while a REAL resize failure blocks the attach exactly like the TUI paste path.
async function resizedImage(file: File, data: string, mimeType: string, displayName: string): Promise<{
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

/** Convert one dropped/pasted file into an attachment, rejecting anything the
 *  engine cannot inline. Returns null when `cancelled` turns true mid-read —
 *  the caller must stop ingesting the remaining files then. */
export async function attachmentFromFile(file: File, options: {
  id: number;
  cancelled?: () => boolean;
}): Promise<ComposerAttachment | null> {
  const { id, cancelled = () => false } = options;
  const displayName = file.name || (file.type.startsWith('image/') ? 'Pasted image' : 'Pasted file');
  if (file.type.startsWith('image/')) {
    if (!SUPPORTED_IMAGE_TYPES.test(file.type) || file.size > MAX_IMAGE_FILE_BYTES) {
      throw new Error(`${displayName}: use PNG, JPEG, GIF, or WebP under 12 MB.`);
    }
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
  const mimeKind = (file.type || '').split(';', 1)[0].trim().toLowerCase();
  if (mimeKind === 'application/pdf' || /\.pdf$/i.test(displayName)) {
    if (file.size > MAX_PDF_FILE_BYTES) throw new Error(`${displayName}: PDFs must be under 20 MB.`);
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
  const textLike = mimeKind.startsWith('text/') || TEXT_LIKE_MIME.test(mimeKind) ||
    mimeKind.endsWith('+json') || mimeKind.endsWith('+xml') ||
    TEXT_LIKE_EXTENSION.test(displayName) || await fileLooksLikeText(file);
  if (!textLike || file.size > MAX_INLINE_FILE_BYTES) {
    throw new Error(`${displayName}: attach images, PDFs, or text files under 750 KB.`);
  }
  const text = await file.text();
  if (cancelled()) return null;
  if (text.length > MAX_INLINE_FILE_BYTES) {
    throw new Error(`${displayName}: inline text is too large after decoding.`);
  }
  return {
    id,
    name: displayName,
    kind: 'text',
    mimeType: file.type || 'text/plain',
    data: text,
    token: `[File #${id}: ${displayName}]`,
    source: 'file',
  };
}
