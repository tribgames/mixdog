// Grok Build sampler recovery: strip inline images and retry.
// 413 / InvalidImage / "Could not process image" (400|500) / mid-stream
// generation faults with images still on the request.

import { createHash } from 'node:crypto';
import { attachmentRefForBuffer } from '../../../attachments/store.mjs';
import { errorHttpStatus as errorStatus } from '../../../shared/err-text.mjs';

export const IMAGE_STRIP_PLACEHOLDER =
  '[image removed — the server could not process it; its contents are unavailable. Ask the user to re-attach the image if it is still needed.]';

const IMAGE_PART_TYPES = new Set(['image', 'image_url', 'input_image']);

function partLooksLikeImage(part) {
  if (!part || typeof part !== 'object') return false;
  if (IMAGE_PART_TYPES.has(String(part.type || ''))) return true;
  if (part.image_url || part.inlineData || part.inline_data || part.source?.type === 'base64') return true;
  return false;
}

function contentPartArray(content) {
  if (Array.isArray(content)) {
    return { parts: content, rebuild: (parts) => parts };
  }
  if (content && typeof content === 'object' && Array.isArray(content.content)) {
    return {
      parts: content.content,
      rebuild: (parts) => ({ ...content, content: parts }),
    };
  }
  return null;
}

function imageIdentity(part) {
  const payload =
    part?.attachmentRef ||
    part?.image_url?.url ||
    part?.image_url ||
    part?.url ||
    part?.data ||
    part?.source?.data ||
    part?.inlineData?.data ||
    part?.inline_data?.data ||
    '';
  return createHash('sha256')
    .update(String(part?.type || 'image'))
    .update('\0')
    .update(String(part?.mimeType || part?.mediaType || part?.source?.media_type || ''))
    .update('\0')
    .update(String(payload))
    .digest('hex');
}

export function promptHasInlineImages(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'user' && message?.role !== 'tool') continue;
    const view = contentPartArray(message.content);
    if (view?.parts.some(partLooksLikeImage)) return true;
  }
  return false;
}

// `ids` narrows the strip to images with those identities, so a strip decided
// on one transcript applies unchanged to whatever the transcript has become.
export function stripInlineImages(messages, { startIndex = 0, ids = null } = {}) {
  if (!Array.isArray(messages)) return { messages, stripped: 0, uniqueImages: 0, imageIds: [] };
  let stripped = 0;
  const identities = new Set();
  const next = messages.map((message, index) => {
    if (index < startIndex) return message;
    if (!message || (message.role !== 'user' && message.role !== 'tool')) return message;
    const view = contentPartArray(message.content);
    if (!view) return message;
    let changed = false;
    const content = view.parts.map((part) => {
      if (!partLooksLikeImage(part)) return part;
      const identity = imageIdentity(part);
      if (ids && !ids.has(identity)) return part;
      changed = true;
      stripped += 1;
      identities.add(identity);
      return { type: 'text', text: IMAGE_STRIP_PLACEHOLDER };
    });
    return changed ? { ...message, content: view.rebuild(content) } : message;
  });
  return { messages: stripped ? next : messages, stripped, uniqueImages: identities.size, imageIds: [...identities] };
}

export function stripInlineImagesFromLatestTurn(messages) {
  if (!Array.isArray(messages)) return { messages, stripped: 0, uniqueImages: 0 };
  let startIndex = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'assistant') continue;
    startIndex = index + 1;
    break;
  }
  return stripInlineImages(messages, { startIndex });
}

function partInlineData(part) {
  const data = part?.data ?? part?.source?.data ?? part?.inlineData?.data ?? part?.inline_data?.data;
  return typeof data === 'string' ? data : '';
}

// Strip exactly the image prepareAnthropicImages rejected (its base64 rides on
// the error as `failingImageData`). A match anywhere in history is stripped for
// this request; `inLatestTurn` says whether it is safe to heal out of history.
// Without a matching image nothing is stripped.
export function stripFailingImage(messages, err) {
  const none = { messages, stripped: 0, uniqueImages: 0, imageIds: [], inLatestTurn: false };
  const data = err?.failingImageData;
  if (!Array.isArray(messages) || typeof data !== 'string' || !data) return none;
  let latestStart = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'assistant') continue;
    latestStart = index + 1;
    break;
  }
  const ref = attachmentRefForBuffer(Buffer.from(data, 'base64'));
  const ids = new Set();
  let inLatestTurn = false;
  messages.forEach((message, index) => {
    if (!message || (message.role !== 'user' && message.role !== 'tool')) return;
    const view = contentPartArray(message.content);
    for (const part of view?.parts || []) {
      if (!partLooksLikeImage(part)) continue;
      // Stored history carries the store's content address (sha256 of the
      // decoded bytes) instead of the base64.
      if (partInlineData(part) !== data && part.attachmentRef !== ref) continue;
      ids.add(imageIdentity(part));
      if (index >= latestStart) inLatestTurn = true;
    }
  });
  if (!ids.size) return none;
  return { ...stripInlineImages(messages, { ids }), inLatestTurn };
}

export function confirmedImageRejection(err) {
  if (errorStatus(err) !== 400) return false;
  if (isInvalidImageCode(errorCode(err))) return true;
  return /does not represent a valid image/i.test(errorMessage(err));
}

// Only a confirmed rejection that one newly introduced image explains is
// healed out of history; any other strip stays request-local.
export function persistsConfirmedImageRejection(err, strip) {
  if (!confirmedImageRejection(err) || !(strip.stripped > 0)) return false;
  // A local preparation failure names its image: persist only when that image
  // is in the latest turn.
  if (isImagePreparationFailed(err)) return strip.inLatestTurn === true;
  return strip.uniqueImages === 1;
}

export const PREPARATION_FAILED_CODE = 'anthropic_image_preparation_failed';

/** True for prepareAnthropicImages' local "this image is invalid" rejection. */
export function isImagePreparationFailed(err) {
  return errorCode(err) === PREPARATION_FAILED_CODE;
}

function providerErrorDetail(err) {
  return err?.providerError || err?.responseFailed?.response?.error || err?.responseFailed?.error || null;
}

function errorCode(err) {
  const detail = providerErrorDetail(err);
  for (const field of [detail?.code, err?.providerErrorCode, err?.code]) {
    if (typeof field === 'string' && field.trim()) return field.trim().toLowerCase();
  }
  return '';
}

function errorMessage(err) {
  return String(providerErrorDetail(err)?.message || err?.message || '');
}

// ANTHROPIC_IMAGE_PREPARATION_FAILED is prepareAnthropicImages' local 400 for
// an image it cannot decode or fit: a confirmed image rejection, raised before
// any request is sent.
function isInvalidImageCode(code) {
  return code === 'invalid_image' || code === 'invalid-image' || code === PREPARATION_FAILED_CODE;
}

/** Grok Build `is_image_processing_error` + 413. */
export function isImageProcessingError(err) {
  if (!err || typeof err !== 'object') return false;
  const status = errorStatus(err);
  if (status === 413) return true;
  if (isInvalidImageCode(errorCode(err))) return true;
  if (status === 400 || status === 500) {
    const message = errorMessage(err);
    return message.includes('Could not process image') || /does not represent a valid image/i.test(message);
  }
  return false;
}

/** Grok Build `is_likely_body_rejected` — reset/pipe while uploading. */
export function isLikelyImageBodyRejected(err) {
  if (!err || typeof err !== 'object') return false;
  const code = String(err.code || err.cause?.code || '');
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
}

export function shouldStripImagesForRetry(err, { hasImages, alreadyStripped } = {}) {
  if (alreadyStripped || !hasImages) return false;
  if (isImageProcessingError(err)) return true;
  if (isLikelyImageBodyRejected(err)) return true;
  return false;
}
