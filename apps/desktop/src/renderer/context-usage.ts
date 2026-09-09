// @ts-expect-error Shared presentation contract has no separate declaration file.
import { measuredContextUsage, contextPercent } from '../../../../src/ui/context-measurement.mjs';

export interface ContextUsageInput {
  usedTokens?: unknown;
  autoCompactTokenLimit?: unknown;
  displayContextWindow?: unknown;
  contextWindow?: unknown;
  rawContextWindow?: unknown;
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
    input.contextWindow || input.displayContextWindow || input.rawContextWindow,
  );
  if (!used || !limit) return null;
  const percent = contextPercent(used, limit);
  return { used, limit, percent };
}

export function resolveContextDisplayUsage(input: ContextDisplayUsageInput) {
  return measuredContextUsage({
    ...input,
    stats: String(input.sessionId || '').trim() ? input.stats : {},
  }) as {
    used: number | null; limit: number; percent: number | null; known: boolean;
    source: 'last_api_request' | 'pending' | 'unavailable'; updatedAt: number | null; estimated: false;
  };
}
