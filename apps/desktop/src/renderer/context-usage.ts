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
  /** Exact routed window; when set it is the displayed window. */
  contextTokens?: unknown;
}

export function nonNegativeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

export function resolveContextDisplayUsage(input: ContextDisplayUsageInput) {
  const exactWindow = nonNegativeNumber(input.contextTokens);
  return measuredContextUsage({
    ...input,
    ...(exactWindow > 0 ? { displayContextWindow: exactWindow } : {}),
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
