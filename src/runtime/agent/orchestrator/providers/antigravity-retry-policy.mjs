/**
 * antigravity-retry-policy.mjs — Antigravity retry constants and the verdict
 * for a 429:
 *
 *   capacity (429/503/529, MODEL_CAPACITY_EXHAUSTED, "server busy"): retried on
 *     the SAME account and host with 1s → 2s → 4s (8s cap) ±10% jitter, three
 *     retries, waiting at least the server's RetryInfo delay; advice that
 *     would push total waiting past 60s surfaces the error (with resetAt).
 *   Endpoint: the reference falls back to its next endpoint after a failure;
 *     generation here deliberately stays on the single daily host and never
 *     walks an endpoint list (a spent ladder surfaces to the account layer).
 *   RPM / unknown 429: ONE quick retry after 1s (or the server's advice, up to
 *     60s), then the failure surfaces so the account layer can lock and
 *     rotate; advice beyond 60s surfaces at once.
 *   QUOTA_EXHAUSTED (and any day/plan window): never retried here.
 *
 * Replay stays gated by the stream-outcome contract: an attempt that exposed
 * text or dispatched a tool is never re-issued.
 */
import { readStreamOutcome } from './lib/stream-outcome.mjs';
import { DETERMINISTIC_KINDS, providerErrorKind } from './provider-error-kind.mjs';

export const ANTIGRAVITY_CAPACITY_RETRIES = 3;
export const ANTIGRAVITY_CAPACITY_BASE_MS = 1000;
export const ANTIGRAVITY_CAPACITY_MAX_MS = 8000;
export const ANTIGRAVITY_CAPACITY_JITTER_RATIO = 0.1;
// Total time capacity retries may spend waiting on server-advised delays.
export const ANTIGRAVITY_CAPACITY_BUDGET_MS = 60_000;
export const ANTIGRAVITY_QUICK_RETRY_MS = 1000;
export const ANTIGRAVITY_QUICK_RETRY_MAX_ADVICE_MS = 60_000;

// withRetry options for everything that is not a 429: transient transport and
// 5xx failures use the capacity schedule (the reference has no other same-host
// retry; the leading duplicate is the sleep-before-attempt index).
export const ANTIGRAVITY_RETRY = Object.freeze({
  maxAttempts: ANTIGRAVITY_CAPACITY_RETRIES + 1,
  backoffMs: Object.freeze([1000, 1000, 2000, 4000]),
  retryJitterRatio: ANTIGRAVITY_CAPACITY_JITTER_RATIO,
  // 429s are handled by antigravity429WaitMs, not the generic loop.
  retry429: false,
});

/** Capacity wait for retry number `retryIndex` (0-based): 1s, 2s, 4s, 8s cap, ±10%. */
export function antigravityCapacityDelayMs(retryIndex) {
  const base = Math.min(ANTIGRAVITY_CAPACITY_BASE_MS * 2 ** retryIndex, ANTIGRAVITY_CAPACITY_MAX_MS);
  return Math.round(base * (1 - ANTIGRAVITY_CAPACITY_JITTER_RATIO + Math.random() * 2 * ANTIGRAVITY_CAPACITY_JITTER_RATIO));
}

export function isAntigravityCapacityError(err) {
  return err?.code === 'model_capacity_exhausted' || providerErrorKind(err).kind === 'overloaded';
}

/**
 * Wait before re-issuing a 429, or null when it must surface. `state` is the
 * send's `{ capacityRetries, quickRetried }` record.
 */
export function antigravity429WaitMs(err, state) {
  const status = Number(err?.status || err?.httpStatus || 0);
  const capacity = isAntigravityCapacityError(err);
  if (status !== 429 && !(capacity && (status === 503 || status === 529))) return null;
  if (readStreamOutcome(err).replaySafe !== true) return null;
  const { kind, retryAfterMs } = providerErrorKind(err);
  if (DETERMINISTIC_KINDS.has(kind) || err.code === 'quota_exhausted' || err.quotaScope === 'day' || err.quotaScope === 'plan') {
    return null;
  }
  // Capacity waits at least the advised RetryInfo delay (the local schedule
  // is the floor). Total advised waiting stays within the retry budget; an
  // advice that does not fit surfaces with its reset time rather than
  // retrying early.
  if (capacity) {
    if (state.capacityRetries >= ANTIGRAVITY_CAPACITY_RETRIES) return null;
    const spent = state.capacityWaitedMs ?? 0;
    if (retryAfterMs != null && spent + retryAfterMs > ANTIGRAVITY_CAPACITY_BUDGET_MS) {
      err.resetAt ??= Date.now() + retryAfterMs;
      return null;
    }
    const wait = Math.max(antigravityCapacityDelayMs(state.capacityRetries++), retryAfterMs ?? 0);
    state.capacityWaitedMs = spent + wait;
    return wait;
  }
  // An RPM hit gets one quick retry; advice up to a minute is honored in
  // full, a longer wait surfaces so the account pool can rotate.
  if (state.quickRetried || retryAfterMs > ANTIGRAVITY_QUICK_RETRY_MAX_ADVICE_MS) return null;
  state.quickRetried = true;
  return retryAfterMs ?? ANTIGRAVITY_QUICK_RETRY_MS;
}

// Account-pool roster cooldowns, read
// generically by the shared pool from the provider's `accountCooldownPolicy`
// when the server named no delay: a plain rate limit rotates the account for
// 30s; a spent quota escalates 60s → 5m → 30m → 2h per consecutive refusal of
// that account (a served answer resets it); anything else 60s; never under 2s.
// Capacity and server errors never block an account in the shared pool.
export const ANTIGRAVITY_ACCOUNT_COOLDOWN_POLICY = Object.freeze({
  floorMs: 2_000,
  rateLimitedMs: 30_000,
  quotaStepsMs: Object.freeze([60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]),
  unknownMs: 60_000,
  rotateOnRateLimit: true,
  // A roster that is only cooling down waits up to five minutes for its
  // earliest cooldown instead of failing the send.
  waitForCooldownMs: 300_000,
  // An account that needs verification cools for ten minutes while the
  // roster serves from the next account.
  blockedMs: 600_000,
});
