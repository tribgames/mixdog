// Grok Build sampler recovery: strip inline images and retry.
// 413 / InvalidImage / "Could not process image" (400|500) / mid-stream
// generation faults with images still on the request.

import { createHash } from 'node:crypto';

export const IMAGE_STRIP_PLACEHOLDER = '[image removed — the server could not process it; its contents are unavailable. Ask the user to re-attach the image if it is still needed.]';

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
    const payload = part?.attachmentRef
        || part?.image_url?.url
        || part?.image_url
        || part?.url
        || part?.data
        || part?.source?.data
        || part?.inlineData?.data
        || part?.inline_data?.data
        || '';
    return createHash('sha256')
        .update(String(part?.type || 'image')).update('\0')
        .update(String(part?.mimeType || part?.mediaType || part?.source?.media_type || '')).update('\0')
        .update(String(payload))
        .digest('hex');
}

export function isImagePart(part) {
    return partLooksLikeImage(part);
}

export function promptHasInlineImages(messages) {
    for (const message of Array.isArray(messages) ? messages : []) {
        if (message?.role !== 'user' && message?.role !== 'tool') continue;
        const view = contentPartArray(message.content);
        if (view?.parts.some(partLooksLikeImage)) return true;
    }
    return false;
}

export function stripInlineImages(messages, { startIndex = 0 } = {}) {
    if (!Array.isArray(messages)) return { messages, stripped: 0, uniqueImages: 0 };
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
            changed = true;
            stripped += 1;
            identities.add(imageIdentity(part));
            return { type: 'text', text: IMAGE_STRIP_PLACEHOLDER };
        });
        return changed ? { ...message, content: view.rebuild(content) } : message;
    });
    return { messages: stripped ? next : messages, stripped, uniqueImages: identities.size };
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

export function confirmedImageRejection(err) {
    if (errorStatus(err) !== 400) return false;
    const code = errorCode(err);
    if (code === 'invalid_image' || code === 'invalid-image') return true;
    return /does not represent a valid image/i.test(errorMessage(err));
}

export function persistenceMessagesForConfirmedImageRejection(err, messages) {
    if (!confirmedImageRejection(err) || !Array.isArray(messages)) return null;
    const tail = stripInlineImagesFromLatestTurn(messages);
    return tail.stripped > 0 && tail.uniqueImages === 1 ? tail.messages : null;
}

function errorStatus(err) {
    return Number(err?.httpStatus || err?.status || err?.response?.status || 0) || 0;
}

function errorCode(err) {
    const detail = err?.providerError || err?.responseFailed?.response?.error || err?.responseFailed?.error || null;
    for (const field of [detail?.code, err?.providerErrorCode, err?.code]) {
        if (typeof field === 'string' && field.trim()) return field.trim().toLowerCase();
    }
    return '';
}

function errorMessage(err) {
    const detail = err?.providerError || err?.responseFailed?.response?.error || err?.responseFailed?.error || null;
    return String(detail?.message || err?.message || '');
}

/** Grok Build `is_image_processing_error` + 413. */
export function isImageProcessingError(err) {
    if (!err || typeof err !== 'object') return false;
    const status = errorStatus(err);
    if (status === 413) return true;
    const code = errorCode(err);
    if (code === 'invalid_image' || code === 'invalid-image') return true;
    if (status === 400 || status === 500) {
        const message = errorMessage(err);
        return message.includes('Could not process image')
            || /does not represent a valid image/i.test(message);
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
