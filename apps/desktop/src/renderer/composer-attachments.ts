// Composer attachment ingestion: the shared budget policy plus the file ->
// attachment conversion (engine-side image resize, PDF, inline text).
// Extracted from Composer.tsx, which keeps token insertion, draft edits and
// error surfacing.
import type { RecordValue } from "./desktop-types";
import { asRecord } from "./text-format";
import {
  MAX_COMPOSER_ATTACHMENTS,
  MAX_INLINE_FILE_BYTES,
  MAX_INLINE_IMAGE_BASE64_TOTAL,
  MAX_INLINE_TEXT_TOTAL,
  MAX_PDF_FILE_BYTES,
  fileLooksLikeText,
  type ComposerAttachment,
} from "./composer-support";

const MAX_IMAGE_FILE_BYTES = 12_000_000;
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

async function base64Payload(file: File, failure: string): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(failure));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

// TUI parity: route images through the engine's optional-sharp resize pipeline
// so desktop submits the same downscaled payload the terminal client would.
// Hosts without the capability (older engines, test stubs) keep the raw attach,
// while a REAL resize failure blocks the attach exactly like the TUI paste path.
async function resizedImage(data: string, mimeType: string, displayName: string): Promise<{
  data: string;
  mimeType: string;
  metadataText: string;
}> {
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
    const image = await resizedImage(raw, file.type, displayName);
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
