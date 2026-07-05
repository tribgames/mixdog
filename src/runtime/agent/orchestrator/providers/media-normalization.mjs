const DEFAULT_IMAGE_MIME = 'image/png';

function cleanMimeType(value) {
    const mime = String(value || '').trim().toLowerCase();
    return mime.startsWith('image/') ? mime : DEFAULT_IMAGE_MIME;
}

function imageInfo(block) {
    if (!block || typeof block !== 'object' || block.type !== 'image') return null;
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
    return { data, mimeType: cleanMimeType(inline.mimeType || inline.mime_type || inline.mediaType || inline.media_type) };
}

function imageUrlFromPart(block) {
    if (!block || typeof block !== 'object') return null;
    if (block.type === 'image_url') {
        const value = block.image_url;
        if (typeof value === 'string') return value;
        if (value && typeof value.url === 'string') return value.url;
    }
    if (block.type === 'input_image') {
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
        return { fileUri, mimeType: cleanMimeType(fileData.mimeType || fileData.mime_type || fileData.mediaType || fileData.media_type) };
    }
    if (block.type === 'image' && typeof block.uri === 'string' && block.uri) {
        return { fileUri: block.uri, mimeType: cleanMimeType(block.mime_type || block.mimeType || block.media_type || block.mediaType) };
    }
    return null;
}

function imageFileIdFromPart(block) {
    if (!block || typeof block !== 'object') return null;
    if (block.type === 'input_image' && typeof block.file_id === 'string' && block.file_id) {
        return block.file_id;
    }
    if (block.type === 'image' && block.source?.type === 'file' && typeof block.source.file_id === 'string' && block.source.file_id) {
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
    if (typeof block.text === 'string') return block.text;
    if (typeof block.content === 'string') return block.content;
    return '';
}

function stringifyFallback(value) {
    try { return JSON.stringify(value); } catch { return String(value); }
}

function contentParts(content) {
    if (Array.isArray(content)) return content;
    if (content && typeof content === 'object' && Array.isArray(content.content)) {
        return content.content;
    }
    return null;
}

function jsonFallbackFromPart(block) {
    const text = textFromPart(block);
    if (text) return text;
    if (!block || typeof block !== 'object') return block == null ? '' : String(block);
    if (imageUrlFromPart(block) || imageFileIdFromPart(block) || imageFileUriFromPart(block) || geminiInlineInfo(block)) return '';
    return stringifyFallback(block);
}

export function contentHasImage(content) {
    const parts = contentParts(content);
    if (!parts) return false;
    return parts.some((part) => !!imageUrlFromPart(part) || !!imageFileIdFromPart(part) || !!imageFileUriFromPart(part) || !!geminiInlineInfo(part));
}

export function contentToText(content, fallback = '') {
    if (typeof content === 'string') return content;
    const parts = contentParts(content);
    if (!parts) return content == null ? fallback : stringifyFallback(content);
    const text = parts.map(jsonFallbackFromPart).filter(Boolean).join('\n');
    return text || fallback;
}

function storedHistoryImagePlaceholder(part) {
    const info = imageInfo(part) || geminiInlineInfo(part);
    const url = imageUrlFromPart(part);
    const fileUri = imageFileUriFromPart(part);
    const mimeType = info?.mimeType || imageMimeFromDataUrl(url) || fileUri?.mimeType || (part?.type === 'image' ? DEFAULT_IMAGE_MIME : '');
    return `[Image omitted from stored history${mimeType ? `: ${mimeType}` : ''}]`;
}

function sanitizePartForStoredHistory(part) {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return part;
    if (part.type === 'image' || part.type === 'image_url' || part.type === 'input_image' || imageUrlFromPart(part) || imageFileIdFromPart(part) || imageFileUriFromPart(part) || geminiInlineInfo(part)) {
        return { type: 'text', text: storedHistoryImagePlaceholder(part) };
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
            const nested = Array.isArray(part.content)
                ? normalizeContentForAnthropic(part.content)
                : typeof part.content === 'string'
                    ? part.content
                    : part.content == null
                        ? ''
                        : stringifyFallback(part.content);
            return { ...part, content: nested };
        }
        if (part?.type === 'input_text' || part?.type === 'output_text') {
            return { type: 'text', text: part.text || '' };
        }
        return part;
    });
}

export function normalizeContentForOpenAIChat(content, { role = 'user' } = {}) {
    const parts = contentParts(content);
    if (!parts) return content;
    const out = [];
    for (const part of parts) {
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
        const text = jsonFallbackFromPart(part);
        if (text) out.push({ type: 'text', text });
    }
    if (role !== 'user') return out.map((part) => part.text || '').filter(Boolean).join('\n');
    return out.length ? out : contentToText(content, '');
}

export function normalizeContentForOpenAIResponses(content, { role = 'user' } = {}) {
    const textType = role === 'assistant' ? 'output_text' : 'input_text';
    if (typeof content === 'string') return content ? [{ type: textType, text: content }] : [];
    const parts = contentParts(content);
    if (!parts) {
        const text = content == null ? '' : stringifyFallback(content);
        return text ? [{ type: textType, text }] : [];
    }
    const out = [];
    for (const part of parts) {
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
        const text = jsonFallbackFromPart(part);
        if (text) out.push({ type: textType, text });
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
    }
    return out;
}

export function splitToolContentForOpenAIChat(content) {
    if (!contentHasImage(content)) return { output: contentToText(content, ''), mediaContent: null };
    const mediaContent = normalizeContentForOpenAIChat(content, { role: 'user' });
    return {
        output: contentToText(content, '[tool result included image content in the following user message]'),
        mediaContent: Array.isArray(mediaContent) ? mediaContent : null,
    };
}

export function splitToolContentForOpenAIResponses(content) {
    if (!contentHasImage(content)) return { output: contentToText(content, ''), mediaContent: null };
    return {
        output: contentToText(content, '[tool result included image content in the following user message]'),
        mediaContent: normalizeContentForOpenAIResponses(content, { role: 'user' }),
    };
}

export function splitToolContentForGemini(content) {
    if (!contentHasImage(content)) return { response: { result: content }, mediaParts: [] };
    return {
        response: { result: contentToText(content, '[tool result included image content]') },
        mediaParts: normalizeContentForGeminiParts(content),
    };
}
