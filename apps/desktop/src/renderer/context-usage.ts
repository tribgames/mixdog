// @ts-expect-error Shared presentation contract has no separate declaration file.
import { measuredContextUsage } from '../../../../src/ui/context-measurement.mjs';

interface ContextUsageInput {
  usedTokens?: unknown;
  autoCompactTokenLimit?: unknown;
  displayContextWindow?: unknown;
  contextWindow?: unknown;
  rawContextWindow?: unknown;
}

interface ContextDisplayUsageInput extends ContextUsageInput {
  sessionId?: unknown;
  stats?: unknown;
  fallbackUsedTokens?: unknown;
}

export function nonNegativeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

export function resolveContextDisplayUsage(input: ContextDisplayUsageInput) {
  return measuredContextUsage({
    ...input,
    stats: String(input.sessionId || '').trim() ? input.stats : {},
  }) as {
    used: number | null;
    limit: number;
    percent: number | null;
    known: boolean;
    source: 'last_api_request' | 'pending' | 'unavailable';
    updatedAt: number | null;
    estimated: false;
  };
}
