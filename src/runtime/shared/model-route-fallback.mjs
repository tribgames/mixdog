import { providerErrorKind } from '../agent/orchestrator/providers/provider-error-kind.mjs';
import { readStreamOutcome } from '../agent/orchestrator/providers/lib/stream-outcome.mjs';

const ELIGIBLE = new Set(['rate_limited', 'quota_exhausted', 'overloaded', 'transient']);

export function canFallbackRoute(error, { signal, outcome = readStreamOutcome(error), committed = false } = {}) {
  if (signal?.aborted || committed || outcome.userAbort || outcome.stallObserved) return false;
  if (
    !outcome.replaySafe ||
    outcome.observedOutput ||
    outcome.toolCallsStarted ||
    outcome.pendingToolInput ||
    outcome.continuation ||
    outcome.terminalObserved
  )
    return false;
  const { kind, status } = providerErrorKind(error);
  if (!ELIGIBLE.has(kind)) return false;
  // A rejected HTTP request or a provider account-pool refusal proves no
  // generation started. A transport disconnect alone does not.
  return status === 429 || status === 503 || (kind === 'quota_exhausted' && error?.quotaExhausted != null);
}
