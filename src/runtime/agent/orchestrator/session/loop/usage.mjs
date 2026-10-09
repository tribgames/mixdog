// Usage accumulation helpers.
// Normalize a provider usage payload into the canonical token/cost shape and
// fold successive deltas into a running total across loop iterations.
import { reasoningUsage, combineReasoningUsage } from '../../../../shared/llm/reasoning-usage.mjs';

// Provider-measured whole-context occupancy (Cursor checkpoint usedTokens).
// It is not billable prompt usage and carries no cache split, so it only
// feeds the context gauge when the provider reports no prompt count.
function measuredContextTokens(usage) {
  const value = Number(usage?.contextTokens);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

export function normalizeUsage(usage) {
  if (!usage) return null;
  const costUsd = Number(usage.costUsd);
  const contextTokens = measuredContextTokens(usage);
  return {
    inputTokens: usage.inputTokens || 0,
    outputTokens: usage.outputTokens || 0,
    ...reasoningUsage(usage),
    cachedTokens: usage.cachedTokens || 0,
    cacheWriteTokens: usage.cacheWriteTokens || 0,
    cacheWrite1hTokens: usage.cacheWrite1hTokens || 0,
    promptTokens: usage.promptTokens || 0,
    ...(Number.isFinite(costUsd) ? { costUsd } : {}),
    ...(contextTokens ? { contextTokens } : {}),
    raw: usage.raw,
  };
}

// Per-iteration usage delta published mid-turn (fix A) so watchdog /
// agent type=list sees live totals instead of only the terminal aggregate.
export function usageDeltaEvent({
  sessionId,
  iterationIndex,
  usageMetricsTurnId,
  usageMetricsEpoch,
  requestedModel,
  model,
  usage,
  sendTools,
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
    ...reasoningUsage(usage),
    deltaPrompt: usage.promptTokens || 0,
    // Cache delta carried alongside input/output so live metrics reflect
    // the same token classes the terminal aggregate adds; additive —
    // callers that ignore these fields keep working.
    deltaCachedRead: usage.cachedTokens || 0,
    deltaCacheWrite: usage.cacheWriteTokens || 0,
    contextInputTokens: usage.inputTokens ?? 0,
    contextOutputTokens: usage.outputTokens ?? 0,
    contextPromptTokens: usage.promptTokens ?? 0,
    contextCachedReadTokens: usage.cachedTokens ?? 0,
    contextCacheWriteTokens: usage.cacheWriteTokens ?? 0,
    contextMeasuredTokens: measuredContextTokens(usage),
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
    ...combineReasoningUsage(total, delta),
    cachedTokens: (total.cachedTokens || 0) + delta.cachedTokens,
    cacheWriteTokens: (total.cacheWriteTokens || 0) + delta.cacheWriteTokens,
    cacheWrite1hTokens: (total.cacheWrite1hTokens || 0) + delta.cacheWrite1hTokens,
    promptTokens: (total.promptTokens || 0) + delta.promptTokens,
  };
  if (delta.costUsd != null || total.costUsd != null) {
    next.costUsd = (total.costUsd || 0) + (delta.costUsd || 0);
  }
  // Occupancy is a latest reading, never a sum across iterations.
  const contextTokens = delta.contextTokens ?? total.contextTokens ?? null;
  if (contextTokens) next.contextTokens = contextTokens;
  return next;
}
