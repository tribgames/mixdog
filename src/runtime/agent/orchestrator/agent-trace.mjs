import { createHash } from 'crypto';
import { isInclusiveProvider } from '../../shared/llm/cost.mjs';
import {
    appendAgentTrace,
    drainAgentTrace,
    normalizeSessionId,
    warnAgentOnce,
} from './agent-trace-io.mjs';
import {
    traceAgentLoop,
    traceAgentCompact,
    traceAgentTool,
    traceAgentToolFailure,
    traceAgentCompress,
    traceAgentBatch,
} from './agent-trace-format.mjs';

function estimateProviderPayloadBytes(messages, model, tools) {
    try {
        return Buffer.byteLength(JSON.stringify({ model, messages, tools: tools || [] }), 'utf8');
    }
    catch {
        return null;
    }
}

function extractCachedTokens(usage) {
    const candidates = [
        usage?.input_tokens_details?.cached_tokens,
        usage?.prompt_tokens_details?.cached_tokens,
        usage?.inputTokensDetails?.cachedTokens,
        usage?.promptTokensDetails?.cachedTokens,
    ];
    for (const value of candidates) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return 0;
}

// Lightweight fingerprint of the conversation prefix. Hashes the first 4096
// characters of JSON.stringify(messages) — enough to detect prefix mutation
// across iterations (which invalidates the provider prompt cache) without
// hashing megabytes per turn. Truncated SHA1 keeps the trace row compact.
function messagePrefixHash(messages) {
    try {
        const json = JSON.stringify(messages || []);
        const slice = json.length > 4096 ? json.slice(0, 4096) : json;
        return createHash('sha1').update(slice).digest('hex').slice(0, 12);
    } catch {
        return null;
    }
}
function traceStreamStalled({ sessionId, info }) {
    appendAgentTrace({
        sessionId,
        kind: 'stream_stalled',
        stale_seconds: info.staleSeconds,
        last_tool_call: info.lastToolCall,
        stage: info.stage,
    });
}

function traceStreamAborted({ sessionId, info }) {
    appendAgentTrace({
        sessionId,
        kind: 'stream_aborted',
        stale_seconds: info.staleSeconds,
        last_tool_call: info.lastToolCall,
        stage: info.stage,
    });
}

function traceAgentPreset({ sessionId, agent, presetName, model, provider, parentSessionId }) {
    // Fires once per dispatch right after the preset has been resolved and
    // its runtime spec (provider/model) assembled. Useful for after-the-fact
    // routing analysis: "which agent landed on which preset / provider / model
    // on this request?"
    appendAgentTrace({
        sessionId,
        kind: 'preset_assign',
        agent: agent || null,
        preset_name: presetName || null,
        model: model || null,
        provider: provider || null,
        parent_session_id: parentSessionId || null,
        parentSessionId: parentSessionId || null,
    });
}

function traceAgentFetch({ sessionId, headersMs, httpStatus, handshakeRetries, handshakeRetryClassifiers, provider, model, transport }) {
    const payload = {
        headers_ms: headersMs,
        phase: 'http_response_headers',
        http_status: httpStatus,
        provider: provider || null,
        model: model || null,
        transport: transport || null,
    };
    if (Number.isFinite(Number(handshakeRetries))) {
        payload.handshake_retries = Number(handshakeRetries);
    }
    if (Array.isArray(handshakeRetryClassifiers) && handshakeRetryClassifiers.length > 0) {
        payload.handshake_retry_classifiers = handshakeRetryClassifiers;
    }
    appendAgentTrace({
        sessionId,
        kind: 'fetch',
        headers_ms: headersMs,
        http_status: httpStatus,
        provider: provider || null,
        model: model || null,
        transport: transport || null,
        handshake_retries: payload.handshake_retries,
        handshake_retry_classifiers: payload.handshake_retry_classifiers,
        payload,
    });
}

function traceAgentSse({ sessionId, sseParseMs, ttftMs, provider, model, transport }) {
    const streamTotalMs = sseParseMs;
    const firstTokenMs = ttftMs;
    appendAgentTrace({
        sessionId,
        kind: 'sse',
        sse_parse_ms: sseParseMs,
        stream_total_ms: streamTotalMs,
        ttft_ms: ttftMs,
        first_token_ms: firstTokenMs,
        provider: provider || null,
        model: model || null,
        transport: transport || null,
        payload: {
            sse_parse_ms: sseParseMs,
            stream_total_ms: streamTotalMs,
            ttft_ms: ttftMs,
            first_token_ms: firstTokenMs,
            provider: provider || null,
            model: model || null,
            transport: transport || null,
        },
    });
}

function extractThinkingTokens(rawUsage) {
    if (!rawUsage || typeof rawUsage !== 'object') return null;
    const direct = Number(rawUsage.thinking_tokens ?? rawUsage.thinkingTokens);
    if (Number.isFinite(direct) && direct >= 0) return direct;
    const details = rawUsage.output_tokens_details
        || rawUsage.completion_tokens_details;
    if (details && typeof details === 'object') {
        const nested = Number(details.reasoning_tokens ?? details.thinking_tokens);
        if (Number.isFinite(nested) && nested >= 0) return nested;
    }
    return null;
}

function resolveTraceUsageInput({
    provider,
    inputTokens,
    cachedTokens,
    cacheWriteTokens,
    inputTokensInclusive,
}) {
    const inclusive = typeof inputTokensInclusive === 'boolean'
        ? inputTokensInclusive
        : isInclusiveProvider(provider);
    const input = inputTokens || 0;
    const cacheRead = cachedTokens || 0;
    const cacheWrite = cacheWriteTokens || 0;
    return {
        uncachedInputTokens: inclusive ? Math.max(input - cacheRead - cacheWrite, 0) : input,
        promptTokens: inclusive
            ? Math.max(input, cacheRead + cacheWrite)
            : input + cacheRead + cacheWrite,
    };
}

/** xAI Responses cache-chain diagnosis for usage_raw rows (measurement only). */
function grokCacheChainTraceFields(providerState, requestPrevResponseId, continuationResetReason = null) {
    const lastReceived = typeof providerState?.xaiResponses?.previousResponseId === 'string'
        && providerState.xaiResponses.previousResponseId.length > 0
        ? providerState.xaiResponses.previousResponseId
        : null;
    const sent = typeof requestPrevResponseId === 'string' && requestPrevResponseId.length > 0
        ? requestPrevResponseId
        : null;
    const chainContinuous = sent !== null && sent === lastReceived;
    return {
        requestPrevResponseId: sent,
        chainContinuous,
        continuationResetReason: continuationResetReason || null,
    };
}

function traceAgentUsage({
    sessionId,
    iteration,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheWriteTokens,
    promptTokens,
    model,
    modelDisplay,
    responseId,
    rawUsage,
    provider,
    serviceTier,
    requestKind,
    requestPrevResponseId,
    chainContinuous,
    continuationResetReason,
    inputTokensInclusive,
}) {
    const accounting = resolveTraceUsageInput({
        provider,
        inputTokens,
        cachedTokens,
        cacheWriteTokens,
        inputTokensInclusive,
    });
    const cacheWrite = cacheWriteTokens || 0;
    const promptTotal = typeof promptTokens === 'number'
        ? promptTokens
        : accounting.promptTokens;
    const resolvedServiceTier = serviceTier || rawUsage?.service_tier || rawUsage?.serviceTier || null;
    const thinkingTokens = extractThinkingTokens(rawUsage);
    appendAgentTrace({
        sessionId,
        iteration,
        kind: 'usage_raw',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        thinking_tokens: thinkingTokens,
        cached_tokens: cachedTokens,
        cache_write_tokens: cacheWrite,
        uncached_input_tokens: accounting.uncachedInputTokens,
        // Unified total-prompt field. Anthropic = input+cache_read+cache_write,
        // OpenAI/Gemini = input_tokens (cached is already a subset).
        prompt_tokens: promptTotal,
        model: model || null,
        model_display: modelDisplay || null,
        response_id: responseId || null,
        request_kind: typeof requestKind === 'string' && requestKind ? requestKind : null,
        service_tier: resolvedServiceTier,
        ...(requestPrevResponseId !== undefined ? { request_prev_response_id: requestPrevResponseId } : {}),
        ...(chainContinuous !== undefined ? { chain_continuous: chainContinuous } : {}),
        ...(continuationResetReason !== undefined ? { continuation_reset_reason: continuationResetReason } : {}),
        payload: {
            provider: provider || null,
            prompt_tokens: promptTotal,
            uncached_input_tokens: accounting.uncachedInputTokens,
            thinking_tokens: thinkingTokens,
            model_display: modelDisplay || null,
            response_id: responseId || null,
            service_tier: resolvedServiceTier,
            raw_usage: rawUsage || null,
            ...(requestPrevResponseId !== undefined ? { request_prev_response_id: requestPrevResponseId } : {}),
            ...(chainContinuous !== undefined ? { chain_continuous: chainContinuous } : {}),
            ...(continuationResetReason !== undefined ? { continuation_reset_reason: continuationResetReason } : {}),
        },
    });
}

export {
    appendAgentTrace,
    drainAgentTrace,
    estimateProviderPayloadBytes,
    extractCachedTokens,
    messagePrefixHash,
    traceAgentFetch,
    traceAgentLoop,
    traceAgentPreset,
    traceAgentSse,
    traceAgentTool,
    traceAgentToolFailure,
    traceAgentCompact,
    traceAgentUsage,
    resolveTraceUsageInput,
    grokCacheChainTraceFields,
    traceAgentCompress,
    traceAgentBatch,
    traceStreamAborted,
    traceStreamStalled,
    warnAgentOnce,
};
