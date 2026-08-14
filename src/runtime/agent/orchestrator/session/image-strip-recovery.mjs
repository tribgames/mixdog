// Grok Build sampler recovery: strip inline images and retry.
// 413 / InvalidImage / "Could not process image" (400|500) / mid-stream
// generation faults with images still on the request.

export const IMAGE_STRIP_PLACEHOLDER = '[image removed — the server could not process it; its contents are unavailable. Ask the user to re-attach the image if it is still needed.]';

const IMAGE_PART_TYPES = new Set(['image', 'image_url', 'input_image']);

function partLooksLikeImage(part) {
    if (!part || typeof part !== 'object') return false;
    if (IMAGE_PART_TYPES.has(String(part.type || ''))) return true;
    if (part.image_url || part.inlineData || part.inline_data || part.source?.type === 'base64') return true;
    return false;
}

export function isImagePart(part) {
    return partLooksLikeImage(part);
}

export function promptHasInlineImages(messages) {
    for (const message of Array.isArray(messages) ? messages : []) {
        if (message?.role !== 'user' && message?.role !== 'tool') continue;
        const content = message.content;
        if (!Array.isArray(content)) continue;
        if (content.some(partLooksLikeImage)) return true;
    }
    return false;
}

export function stripInlineImages(messages) {
    if (!Array.isArray(messages)) return { messages, stripped: 0 };
    let stripped = 0;
    const next = messages.map((message) => {
        if (!message || (message.role !== 'user' && message.role !== 'tool')) return message;
        if (!Array.isArray(message.content)) return message;
        let changed = false;
        const content = message.content.map((part) => {
            if (!partLooksLikeImage(part)) return part;
            changed = true;
            stripped += 1;
            return { type: 'text', text: IMAGE_STRIP_PLACEHOLDER };
        });
        return changed ? { ...message, content } : message;
    });
    return { messages: stripped ? next : messages, stripped };
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
        return errorMessage(err).includes('Could not process image');
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
