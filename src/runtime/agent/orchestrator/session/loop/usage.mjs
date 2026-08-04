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
