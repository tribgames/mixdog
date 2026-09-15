// Usage accumulation helpers extracted from loop.mjs.
// Normalize a provider usage payload into the canonical token/cost shape and
// fold successive deltas into a running total across loop iterations.

export function normalizeUsage(usage) {
    if (!usage) return null;
    const costUsd = Number(usage.costUsd);
    return {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cachedTokens: usage.cachedTokens || 0,
        cacheWriteTokens: usage.cacheWriteTokens || 0,
        promptTokens: usage.promptTokens || 0,
        ...(Number.isFinite(costUsd) ? { costUsd } : {}),
        raw: usage.raw,
    };
}

// Per-iteration usage delta published mid-turn (fix A) so watchdog /
// agent type=list sees live totals instead of only the terminal aggregate.
// Billing deltas include OAuth WS warmup; the context* fields must describe
// only the main send, so they fall back to the billing value only when the
// provider reported no separate main-send usage.
export function usageDeltaEvent({
    sessionId, iterationIndex, usageMetricsTurnId, usageMetricsEpoch,
    requestedModel, model, usage, sendTools,
}) {
    return {
        sessionId,
        iterationIndex,
        usageMetricsTurnId,
        source: 'provider_send',
        requestedModel,
        model,
        usageMetricsEpoch,
        deltaInput: usage.inputTokens || 0,
        deltaOutput: usage.outputTokens || 0,
        deltaPrompt: usage.promptTokens || 0,
        // Cache delta carried alongside input/output so live metrics reflect
        // the same token classes the terminal aggregate adds; additive —
        // callers that ignore these fields keep working.
        deltaCachedRead: usage.cachedTokens || 0,
        deltaCacheWrite: usage.cacheWriteTokens || 0,
        contextInputTokens: usage.mainInputTokens ?? usage.inputTokens ?? 0,
        contextOutputTokens: usage.mainOutputTokens ?? usage.outputTokens ?? 0,
        contextPromptTokens: usage.mainPromptTokens ?? usage.promptTokens ?? 0,
        contextCachedReadTokens: usage.mainCachedTokens ?? usage.cachedTokens ?? 0,
        contextCacheWriteTokens: usage.mainCacheWriteTokens ?? usage.cacheWriteTokens ?? 0,
        contextUsageAvailable: usage.mainUsageAvailable !== false,
        sendTools,
        ts: Date.now(),
    };
}

export function addUsage(total, usage) {
    const delta = normalizeUsage(usage);
    if (!delta) return total;
    if (!total) return { ...delta };
    const next = {
        ...total,
        inputTokens: (total.inputTokens || 0) + delta.inputTokens,
        outputTokens: (total.outputTokens || 0) + delta.outputTokens,
        cachedTokens: (total.cachedTokens || 0) + delta.cachedTokens,
        cacheWriteTokens: (total.cacheWriteTokens || 0) + delta.cacheWriteTokens,
        promptTokens: (total.promptTokens || 0) + delta.promptTokens,
    };
    if (delta.costUsd != null || total.costUsd != null) {
        next.costUsd = (total.costUsd || 0) + (delta.costUsd || 0);
    }
    return next;
}
