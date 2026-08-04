/**
 * openai-compat-trace.mjs — shared trace/token helpers for the OpenAI-compat
 * provider family.
 *
 * Extracted from openai-compat.mjs. Holds the two low-level helpers
 * (summarizeTraceMessages, extractCompatCachedTokens) consumed by both
 * openai-compat.mjs and openai-compat-xai.mjs cache-trace writers. Isolating
 * them here breaks the former import cycle between those two modules.
 */
import { traceHash, stableTraceStringify, traceTextShape } from './trace-utils.mjs';

export function summarizeTraceMessages(messages) {
    const summaries = (messages || []).map((m, index) => {
        const content = typeof m?.content === 'string'
            ? { type: 'text', ...traceTextShape(m.content) }
            : { type: m?.content == null ? 'null' : typeof m.content, hash: traceHash(stableTraceStringify(m?.content ?? null)) };
        const toolCalls = Array.isArray(m?.tool_calls)
            ? m.tool_calls.map(tc => ({
                name: tc?.function?.name || null,
                argsHash: traceHash(tc?.function?.arguments || ''),
            }))
            : [];
        return {
            index,
            role: m?.role || null,
            content,
            ...(typeof m?.reasoning_content === 'string'
                ? { reasoningContent: traceTextShape(m.reasoning_content) }
                : {}),
            toolCallCount: toolCalls.length,
            ...(toolCalls.length ? { toolCalls } : {}),
        };
    });
    if (summaries.length <= 12) return summaries;
    return [
        ...summaries.slice(0, 8),
        { omittedTurns: summaries.length - 12 },
        ...summaries.slice(-4),
    ];
}

export function extractCompatCachedTokens(usage) {
    const candidates = [
        usage?.prompt_tokens_details?.cached_tokens,
        usage?.input_tokens_details?.cached_tokens,
        usage?.prompt_cache_hit_tokens,
        usage?.cached_prompt_text_tokens,
    ];
    for (const v of candidates) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
    }
    for (const v of candidates) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return 0;
}
