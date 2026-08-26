import { record } from './record-utils';

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

export function nonNegativeNumber(value: unknown): number {
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
  // The runtime publishes ONE gauge number — provider-billed baseline plus
  // calibrated growth — in currentEstimatedContextTokens, while
  // currentContextTokens carries only a pure provider-reported total. Read the
  // estimate first so this gauge and the TUI status line resolve the same field
  // in the same order and can never disagree for one session.
  const used = estimated || exact || fallback;
  const usage = resolveContextUsage({ ...input, usedTokens: used });
  if (!usage) return idle;
  return {
    ...usage,
    estimated: used !== exact,
  };
}
