// Shared trace fingerprinting utilities for provider trace logging.
// These functions produce deterministic, compact representations of
// LLM call artifacts (tool schemas, messages, function arguments)
// for cache-key computation and trace hash comparison.
// Used by gemini.mjs and openai-compat.mjs.

import { createHash } from 'crypto';

export function traceHash(value) {
    return createHash('sha256')
        .update(String(value ?? ''))
        .digest('hex')
        .slice(0, 16);
}

export function stableTraceStringify(value, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'bigint') return JSON.stringify(String(value));
        if (typeof value === 'undefined' || typeof value === 'function') return 'null';
        return JSON.stringify(value);
    }
    if (seen.has(value)) return JSON.stringify('[Circular]');
    seen.add(value);
    if (Array.isArray(value)) {
        const serialized = '[' + value.map(v => stableTraceStringify(v, seen)).join(',') + ']';
        seen.delete(value);
        return serialized;
    }
    const parts = [];
    for (const key of Object.keys(value).sort()) {
        const v = value[key];
        if (typeof v === 'undefined' || typeof v === 'function') continue;
        parts.push(JSON.stringify(key) + ':' + stableTraceStringify(v, seen));
    }
    seen.delete(value);
    return '{' + parts.join(',') + '}';
}

export function summarizeTraceTools(tools) {
    return (tools || []).map(t => ({
        name: t?.name || null,
        description: t?.description || '',
        inputSchema: t?.inputSchema || null,
    }));
}

export function traceTextShape(text) {
    const value = String(text ?? '');
    return { chars: value.length, hash: traceHash(value) };
}
