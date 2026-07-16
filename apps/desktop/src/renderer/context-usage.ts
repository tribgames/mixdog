export interface ContextUsageInput {
  usedTokens?: unknown;
  autoCompactTokenLimit?: unknown;
  displayContextWindow?: unknown;
  contextWindow?: unknown;
}

function nonNegativeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
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
