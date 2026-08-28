import { appendAgentTrace } from './agent-trace.mjs';

const HASH_CHARS = 16;

function cleanText(value, max = 120) {
    if (value == null || value === '') return null;
    return String(value).replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function cleanHash(value) {
    const text = cleanText(value, 128);
    return text ? text.slice(0, HASH_CHARS) : null;
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export function buildCacheBreakPayload(record = {}) {
    const payload = {
        classification: cleanText(record.classification) || 'unknown',
        reason: cleanText(record.reason) || 'unknown',
        source: cleanText(record.source),
        provider: cleanText(record.provider),
        model: cleanText(record.model),
        transport: cleanText(record.transport),
        intentional_transition: cleanText(record.intentionalTransition),
        index: finiteNumber(record.index),
        previous_count: finiteNumber(record.previousCount),
        next_count: finiteNumber(record.nextCount),
        previous_hash: cleanHash(record.previousHash),
        next_hash: cleanHash(record.nextHash),
        previous_request_prefix_hash: cleanHash(record.previousRequestPrefixHash),
        next_request_prefix_hash: cleanHash(record.nextRequestPrefixHash),
        request_prefix_changed: record.requestPrefixChanged === true,
        cached_tokens: finiteNumber(record.cachedTokens),
        prompt_tokens: finiteNumber(record.promptTokens),
        uncached_tokens: finiteNumber(record.uncachedTokens),
        cache_ratio: finiteNumber(record.cacheRatio),
        actual_cache_miss: record.actualCacheMiss === true,
        input_prefix_mismatch_index: finiteNumber(record.inputPrefixMismatchIndex),
        input_prefix_mismatch_previous_count: finiteNumber(record.inputPrefixMismatchPreviousCount),
        input_prefix_mismatch_current_count: finiteNumber(record.inputPrefixMismatchCurrentCount),
        input_prefix_mismatch_expected_type: cleanText(record.inputPrefixMismatchExpectedType),
        input_prefix_mismatch_expected_hash: cleanHash(record.inputPrefixMismatchExpectedHash),
        input_prefix_mismatch_actual_type: cleanText(record.inputPrefixMismatchActualType),
        input_prefix_mismatch_actual_hash: cleanHash(record.inputPrefixMismatchActualHash),
    };
    return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== null));
}

export function formatCacheBreakLine(record = {}) {
    const payload = buildCacheBreakPayload(record);
    const fields = [
        ['classification', payload.classification],
        ['reason', payload.reason],
        ['source', payload.source],
        ['session', cleanText(record.sessionId, 160)],
        ['provider', payload.provider],
        ['model', payload.model],
        ['iteration', finiteNumber(record.iteration)],
        ['index', payload.index],
        ['previousCount', payload.previous_count],
        ['nextCount', payload.next_count],
        ['previousHash', payload.previous_hash],
        ['nextHash', payload.next_hash],
        ['inputMismatchIndex', payload.input_prefix_mismatch_index],
        ['intent', payload.intentional_transition],
        ['cachedTokens', payload.cached_tokens],
        ['promptTokens', payload.prompt_tokens],
    ].filter(([, value]) => value !== null && value !== undefined);
    return `[cache-break] ${fields.map(([key, value]) => (
        typeof value === 'string' ? `${key}=${JSON.stringify(value)}` : `${key}=${value}`
    )).join(' ')}`;
}

export function traceCacheBreak(record = {}, options = {}) {
    const payload = buildCacheBreakPayload(record);
    const traceFn = options.traceFn === null
        ? null
        : (typeof options.traceFn === 'function' ? options.traceFn : appendAgentTrace);
    if (traceFn) {
        try {
            traceFn({
                sessionId: record.sessionId || null,
                iteration: finiteNumber(record.iteration),
                kind: 'cache_break',
                classification: payload.classification,
                reason: payload.reason,
                source: payload.source || null,
                provider: payload.provider || null,
                model: payload.model || null,
                transport: payload.transport || null,
                payload,
            });
        } catch { /* cache diagnostics never affect provider execution */ }
    }
    const explicitStderr = typeof options.stderrFn === 'function';
    if (options.stderr !== false && (explicitStderr || !process.env.NODE_TEST_CONTEXT)) {
        try {
            const write = explicitStderr
                ? options.stderrFn
                : (line) => process.stderr.write(line);
            write(`${formatCacheBreakLine(record)}\n`);
        } catch { /* cache diagnostics never affect provider execution */ }
    }
    return payload;
}
