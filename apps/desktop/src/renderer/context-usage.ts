export interface ContextUsageInput {
  usedTokens?: unknown;
  autoCompactTokenLimit?: unknown;
  displayContextWindow?: unknown;
  contextWindow?: unknown;
}

export interface ContextDisplayUsageInput extends ContextUsageInput {
  sessionId?: unknown;
  stats?: unknown;
  fallbackUsedTokens?: unknown;
}

function nonNegativeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function resolveContextUsage(input: ContextUsageInput) {
  const used = nonNegativeNumber(input.usedTokens);
  const limit = nonNegativeNumber(
    input.autoCompactTokenLimit || input.displayContextWindow || input.contextWindow,
  );
  if (!used || !limit) return null;
  const rawPercent = Math.max(0, Math.min(100, (used / limit) * 100));
  const percent = rawPercent > 0 && rawPercent < 1
    ? Number(rawPercent.toFixed(1))
    : Math.floor(rawPercent);
  return { used, limit, percent };
}

export function resolveContextDisplayUsage(input: ContextDisplayUsageInput) {
  const limit = nonNegativeNumber(
    input.autoCompactTokenLimit || input.displayContextWindow || input.contextWindow,
  );
  const idle = { used: 0, limit, percent: 0, estimated: false };
  if (!String(input.sessionId || '').trim()) return idle;
  const stats = record(input.stats);
  const exact = nonNegativeNumber(stats.currentContextTokens);
  const estimated = nonNegativeNumber(stats.currentEstimatedContextTokens);
  const fallback = nonNegativeNumber(input.fallbackUsedTokens);
  const used = exact || estimated || fallback;
  const usage = resolveContextUsage({ ...input, usedTokens: used });
  if (!usage) return idle;
  return {
    ...usage,
    estimated: exact === 0 && used > 0,
  };
}
