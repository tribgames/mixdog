/**
 * src/tui/engine/session-stats.mjs - session-usage accumulator.
 *
 * Inlined (not imported from ui/statusline.mjs) so the engine has no static
 * dependency on the vendored statusline closure. Extracted from engine.mjs.
 */
export function createSessionStats() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    promptTokens: 0,
    latestInputTokens: 0,
    latestOutputTokens: 0,
    latestCachedTokens: 0,
    latestCacheWriteTokens: 0,
    latestPromptTokens: 0,
    currentContextTokens: 0,
    costUsd: 0,
    turns: 0,
  };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export function applyUsageDelta(stats, delta = {}) {
  if (!stats || !delta) return stats;
  const inputTokens = num(delta.deltaInput);
  const outputTokens = num(delta.deltaOutput);
  const cachedTokens = num(delta.deltaCachedRead);
  const cacheWriteTokens = num(delta.deltaCacheWrite);
  const promptTokens = num(delta.deltaPrompt);
  stats.inputTokens += inputTokens;
  stats.outputTokens += outputTokens;
  stats.cachedTokens += cachedTokens;
  stats.cacheWriteTokens += cacheWriteTokens;
  stats.promptTokens += promptTokens;
  stats.latestInputTokens = inputTokens;
  stats.latestOutputTokens = outputTokens;
  stats.latestCachedTokens = cachedTokens;
  stats.latestCacheWriteTokens = cacheWriteTokens;
  stats.latestPromptTokens = promptTokens;
  stats.costUsd += num(delta.costUsd);
  return stats;
}
