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

export function _combineUsageWithWarmup(actual, warmup, { separateMainContext = false } = {}) {
    if (!warmup) return actual;
    if (!actual) {
        // A warmup-only settle is billable, but has no corresponding main
        // request whose context footprint can be measured.
        const combined = {
            ...warmup,
            warmupInputTokens: _usageNum(warmup.inputTokens),
            warmupCachedTokens: _usageNum(warmup.cachedTokens),
            warmupOutputTokens: _usageNum(warmup.outputTokens),
            warmupPromptTokens: _usageNum(warmup.promptTokens),
            warmupCacheWriteTokens: _usageNum(warmup.cacheWriteTokens),
        };
        if (separateMainContext) combined.mainUsageAvailable = false;
        return combined;
    }
    const actualRaw = actual.raw || {};
    const warmupRaw = warmup.raw || {};
    const actualTicks = _usageNum(actualRaw.cost_in_usd_ticks);
    const warmupTicks = _usageNum(warmupRaw.cost_in_usd_ticks);
    const combined = {
        ...actual,
        inputTokens: _usageNum(actual.inputTokens) + _usageNum(warmup.inputTokens),
        outputTokens: _usageNum(actual.outputTokens) + _usageNum(warmup.outputTokens),
        cachedTokens: _usageNum(actual.cachedTokens) + _usageNum(warmup.cachedTokens),
        promptTokens: _usageNum(actual.promptTokens) + _usageNum(warmup.promptTokens),
        warmupInputTokens: _usageNum(warmup.inputTokens),
        warmupCachedTokens: _usageNum(warmup.cachedTokens),
        warmupOutputTokens: _usageNum(warmup.outputTokens),
        warmupPromptTokens: _usageNum(warmup.promptTokens),
        warmupCacheWriteTokens: _usageNum(warmup.cacheWriteTokens),
        raw: {
            ...actualRaw,
            warmup_usage: warmupRaw,
            ...(actualTicks || warmupTicks ? { cost_in_usd_ticks: actualTicks + warmupTicks } : {}),
        },
    };
    if (separateMainContext) {
        // OAuth startup prewarm is billable but is not part of the main
        // request's context footprint. Keep these fields opt-in so shared xAI
        // usage objects retain their prior shape and accounting behavior.
        combined.mainInputTokens = _usageNum(actual.inputTokens);
        combined.mainOutputTokens = _usageNum(actual.outputTokens);
        combined.mainCachedTokens = _usageNum(actual.cachedTokens);
        combined.mainPromptTokens = _usageNum(actual.promptTokens);
        combined.mainCacheWriteTokens = _usageNum(actual.cacheWriteTokens);
        combined.mainUsageAvailable = true;
    }
    return combined;
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
