// Steering-message normalization/merge helpers extracted from loop.mjs.
// Merges queued steering entries into a single content payload + display text.

export function steeringContentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (part?.type === 'text') return part.text || '';
            if (part?.type === 'image') return '[Image]';
            return part?.text || '';
        }).filter(Boolean).join('\n');
    }
    return String(content ?? '');
}

function normalizeSteeringEntry(entry) {
    if (typeof entry === 'string') {
        const text = entry.trim();
        return text ? { content: text, text } : null;
    }
    if (!entry || typeof entry !== 'object') return null;
    const content = Object.prototype.hasOwnProperty.call(entry, 'content') ? entry.content : entry;
    const text = typeof entry.text === 'string' ? entry.text.trim() : steeringContentText(content).trim();
    if (Array.isArray(content)) return content.length > 0 ? { content, text } : null;
    if (typeof content === 'string') {
        const value = content.trim();
        return value ? { content: value, text: text || value } : null;
    }
    const fallback = steeringContentText(content).trim();
    return fallback ? { content: fallback, text: text || fallback } : null;
}

export function mergeSteeringEntries(entries) {
    const normalized = (Array.isArray(entries) ? entries : [])
        .map(normalizeSteeringEntry)
        .filter(Boolean);
    if (normalized.length === 0) return null;
    const displayText = normalized.map((entry) => entry.text || steeringContentText(entry.content))
        .filter((text) => String(text || '').trim())
        .join('\n');
    if (normalized.every((entry) => typeof entry.content === 'string')) {
        return {
            content: normalized.map((entry) => entry.content).filter(Boolean).join('\n'),
            text: displayText,
            count: normalized.length,
        };
    }
    const parts = [];
    for (const entry of normalized) {
        if (typeof entry.content === 'string') {
            if (entry.content.trim()) parts.push({ type: 'text', text: entry.content });
        } else if (Array.isArray(entry.content)) {
            parts.push(...entry.content);
        } else {
            const text = steeringContentText(entry.content);
            if (text.trim()) parts.push({ type: 'text', text });
        }
        parts.push({ type: 'text', text: '\n' });
    }
    while (parts.length && parts[parts.length - 1]?.type === 'text' && parts[parts.length - 1]?.text === '\n') parts.pop();
    return { content: parts, text: displayText || steeringContentText(parts), count: normalized.length };
}
