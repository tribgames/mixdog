import {
  boundedCauseChain,
  providerErrorKind,
  typedCodeKind,
} from '../agent/orchestrator/providers/provider-error-kind.mjs';
import { readStreamOutcome } from '../agent/orchestrator/providers/lib/stream-outcome.mjs';
import { namesUnavailableModel } from './error-presentation.mjs';

// When a route's model fails, does the next model in its fallback chain get
// the request? Only for a refusal scoped to THIS provider, account or model —
// another provider may serve the identical request:
//   quota_exhausted / entitlement / billing — the plan or account is spent;
//   rate_limited / overloaded / service_tier_unavailable — this provider is
//     saturated once its own retries are spent;
//   auth / permission — the provider's own sign-in refresh already failed, or
//     the account, region or tier is refused;
//   transient — only when the server answered (a typed status or code): its
//     retry ladder is spent. A bare network failure would fail on every
//     provider, so it stays with the transport recovery;
//   invalid_request on 404/410, a typed model code, or provider wording with
//     the model as the refused subject (namesUnavailableModel) — the model is
//     unknown, retired or not offered to this account.
// A request that fails the same way on any model never hops: request too
// large, a refused tool schema or other invalid request, a policy refusal,
// a cancel, a stall and any untyped failure. A context overflow hops only to
// a model with a larger window (`contextGrows`); compaction runs first.
// Whatever the kind, nothing may have been produced: no visible or buffered
// output, no tool call started or dispatched.
const PROVIDER_SCOPED_KINDS = new Set([
  'quota_exhausted',
  'entitlement',
  'billing',
  'rate_limited',
  'overloaded',
  'service_tier_unavailable',
  'auth',
  'permission',
]);
const MODEL_UNAVAILABLE_CODES = new Set(['model_not_found', 'model_not_supported']);

/** 'hop', 'context' (a context overflow: hop only to a larger window) or 'stay'. */
// A recovery layer may wrap the provider failure (a context overflow it could
// not compact away): what the original request exposed lives on the cause.
// Every node of the chain counts, so a wrapper never launders exposure.
function chainOutcome(error) {
  return readStreamOutcome(...(error && typeof error === 'object' ? boundedCauseChain(error) : [error]));
}

export function routeFallbackVerdict(error, { signal, outcome = chainOutcome(error), committed = false } = {}) {
  if (signal?.aborted || committed || outcome.userAbort || outcome.stallObserved) return 'stay';
  if (!outcome.replaySafe || outcome.observedOutput || outcome.toolCallsStarted || outcome.pendingToolInput) {
    return 'stay';
  }
  const { kind, status, code } = providerErrorKind(error);
  if (PROVIDER_SCOPED_KINDS.has(kind)) return 'hop';
  if (kind === 'transient') return status >= 408 || typedCodeKind(error) === 'transient' ? 'hop' : 'stay';
  if (kind === 'invalid_request') {
    return status === 404 || status === 410 || MODEL_UNAVAILABLE_CODES.has(code) || namesUnavailableModel(error)
      ? 'hop'
      : 'stay';
  }
  return kind === 'context_overflow' ? 'context' : 'stay';
}

export function canFallbackRoute(error, { contextGrows = false, ...options } = {}) {
  const verdict = routeFallbackVerdict(error, options);
  return verdict === 'hop' || (verdict === 'context' && contextGrows === true);
}

const CAPACITY_KINDS = new Set(['rate_limited', 'quota_exhausted', 'overloaded', 'transient']);

/**
 * The narrower rule a stateless tool route (native web search) keeps: only a
 * capacity refusal the server stated (429 / 503, or an account-pool quota
 * refusal) moves to the next provider; a denied or failed credential
 * surfaces so the user fixes that route.
 */
// It also keeps its stricter stream guards: any started or terminal stream
// stays on its route, since a tool call cannot prove nothing was generated.
export function canFallbackCapacityRoute(error, { signal, outcome = readStreamOutcome(error) } = {}) {
  if (signal?.aborted || outcome.userAbort || outcome.stallObserved) return false;
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
  if (!CAPACITY_KINDS.has(kind)) return false;
  return status === 429 || status === 503 || (kind === 'quota_exhausted' && error?.quotaExhausted != null);
}
