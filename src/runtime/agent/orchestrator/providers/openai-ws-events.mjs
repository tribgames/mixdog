/**
 * openai-ws-events.mjs — usage assembly + event/close parsing helpers for the
 * OpenAI OAuth WebSocket transport.
 *
 * Extracted from openai-ws-stream.mjs (no behavior change): the pure,
 * socket-free helpers used by the _streamResponse loop to combine warmup +
 * actual usage, parse server event frames, derive incomplete reasons, and map
 * WS close codes to HTTP status. openai-ws-stream.mjs re-exports these so
 * existing importers resolve unchanged.
 */

function _usageNum(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) ? n : 0;
}

export function _combineUsageWithWarmup(actual, warmup) {
    if (!warmup) return actual;
    if (!actual) return warmup;
    const actualRaw = actual.raw || {};
    const warmupRaw = warmup.raw || {};
    const actualTicks = _usageNum(actualRaw.cost_in_usd_ticks);
    const warmupTicks = _usageNum(warmupRaw.cost_in_usd_ticks);
    return {
        ...actual,
        inputTokens: _usageNum(actual.inputTokens) + _usageNum(warmup.inputTokens),
        outputTokens: _usageNum(actual.outputTokens) + _usageNum(warmup.outputTokens),
        cachedTokens: _usageNum(actual.cachedTokens) + _usageNum(warmup.cachedTokens),
        promptTokens: _usageNum(actual.promptTokens) + _usageNum(warmup.promptTokens),
        warmupInputTokens: _usageNum(warmup.inputTokens),
        warmupCachedTokens: _usageNum(warmup.cachedTokens),
        warmupOutputTokens: _usageNum(warmup.outputTokens),
        raw: {
            ...actualRaw,
            warmup_usage: warmupRaw,
            ...(actualTicks || warmupTicks ? { cost_in_usd_ticks: actualTicks + warmupTicks } : {}),
        },
    };
}

export function _parseEvent(raw) {
    try { return JSON.parse(raw); } catch { return null; }
}

export function _incompleteReasonFromEvent(event) {
    const reasonObj = event?.response?.incomplete_details
        || event?.incomplete_details
        || event?.response?.status_details
        || null;
    return String(reasonObj?.reason || event?.response?.status || 'incomplete');
}

export function _isMaxOutputIncompleteReason(reason) {
    return /^(?:max_output_tokens|max_tokens|length|output_token_limit)$/i.test(String(reason || '').trim());
}

export function _httpStatusFromWsClose(code, reason) {
    const n = Number(code || 0);
    const r = String(reason || '').toLowerCase();
    if (n === 4401
        || /\b(?:unauthorized|unauthorised|authentication|auth(?:enticated?)?|not authenticated|token expired|access token)\b/.test(r)) {
        return 401;
    }
    if (n === 4403 || /\b(?:forbidden|policy|permission denied)\b/.test(r)) return 403;
    if (n === 4429 || /\b(?:rate limit|quota)\b/.test(r)) return 429;
    return 0;
}
