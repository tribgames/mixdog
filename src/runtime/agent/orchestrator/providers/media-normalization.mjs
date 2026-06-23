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
    const info = imageInfo(block);
    return info ? `data:${info.mimeType};base64,${info.data}` : null;
}

function textFromPart(block) {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return '';
    if (typeof block.text === 'string') return block.text;
    if (typeof block.content === 'string') return block.content;
    return '';
}

export function contentHasImage(content) {
    if (!Array.isArray(content)) return false;
    return content.some((part) => !!imageUrlFromPart(part));
}

export function contentToText(content, fallback = '') {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? fallback : JSON.stringify(content);
    const text = content.map(textFromPart).filter(Boolean).join('\n');
    return text || fallback;
}

export function normalizeContentForAnthropic(content) {
    if (!Array.isArray(content)) return content;
    return content.map((part) => {
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
        if (part?.type === 'tool_result' && Array.isArray(part.content)) {
            return { ...part, content: normalizeContentForAnthropic(part.content) };
        }
        if (part?.type === 'input_text' || part?.type === 'output_text') {
            return { type: 'text', text: part.text || '' };
        }
        return part;
    });
}

export function normalizeContentForOpenAIChat(content, { role = 'user' } = {}) {
    if (!Array.isArray(content)) return content;
    const out = [];
    for (const part of content) {
        const url = imageUrlFromPart(part);
        if (url) {
            out.push({ type: 'image_url', image_url: { url } });
            continue;
        }
        const text = textFromPart(part);
        if (text) out.push({ type: 'text', text });
    }
    if (role !== 'user') return out.map((part) => part.text || '').filter(Boolean).join('\n');
    return out.length ? out : contentToText(content, '');
}

export function normalizeContentForOpenAIResponses(content, { role = 'user' } = {}) {
    const textType = role === 'assistant' ? 'output_text' : 'input_text';
    if (typeof content === 'string') return content ? [{ type: textType, text: content }] : [];
    if (!Array.isArray(content)) {
        const text = content == null ? '' : JSON.stringify(content);
        return text ? [{ type: textType, text }] : [];
    }
    const out = [];
    for (const part of content) {
        const url = imageUrlFromPart(part);
        if (url) {
            out.push({ type: 'input_image', image_url: url });
            continue;
        }
        const text = textFromPart(part);
        if (text) out.push({ type: textType, text });
    }
    return out;
}

export function normalizeContentForGeminiParts(content) {
    if (typeof content === 'string') return content ? [{ text: content }] : [];
    if (!Array.isArray(content)) {
        const text = content == null ? '' : JSON.stringify(content);
        return text ? [{ text }] : [];
    }
    const out = [];
    for (const part of content) {
        const info = imageInfo(part);
        if (info) {
            out.push({ inlineData: { mimeType: info.mimeType, data: info.data } });
            continue;
        }
        const url = imageUrlFromPart(part);
        if (url && !url.startsWith('data:')) {
            out.push({ fileData: { mimeType: DEFAULT_IMAGE_MIME, fileUri: url } });
            continue;
        }
        const text = textFromPart(part);
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
