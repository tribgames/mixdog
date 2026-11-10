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
 *   First byte: the gateway queues or thinks server-side and sends the
 *     response headers together with the first chunk, so the window is chosen
 *     per model class from the catalog `family`: Pro-class Gemini (Pro tiers,
 *     Argon) waits MIXDOG_ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS (300s, clamped to
 *     the provider ceiling PROVIDER_MAX_BEFORE_WARN_MS, 285s by default),
 *     Flash-class Gemini the shared Gemini window (60s); both apply to the
 *     headers and again to the first chunk. A header or first-chunk timeout is
 *     retried at most MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES times (1), each
 *     retry doubling the window up to that ceiling; connect, 5xx and drop
 *     failures keep the full ladder (MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS, 4
 *     attempts, at MIXDOG_ANTIGRAVITY_RETRY_BACKOFF_MS 1s / 2s / 4s). Models
 *     without a Gemini family (Claude, GPT-OSS, unlisted ids) keep the shared
 *     Gemini window on that ladder.
 *
 * Replay stays gated by the stream-outcome contract: an attempt that exposed
 * text or dispatched a tool is never re-issued.
 */
import { readStreamOutcome } from './lib/stream-outcome.mjs';
import { DETERMINISTIC_KINDS, providerErrorKind } from './provider-error-kind.mjs';
import { PROVIDER_MAX_BEFORE_WARN_MS, firstBytePolicyBudget, resolveTimeoutMs } from '../stall-policy.mjs';
import { GEMINI_FIRST_BYTE_TIMEOUT_MS } from './gemini-stream.mjs';
import { antigravityModelFamily } from './antigravity-oauth-catalog.mjs';

export const ANTIGRAVITY_CAPACITY_RETRIES = 3;
export const ANTIGRAVITY_CAPACITY_BASE_MS = 1000;
export const ANTIGRAVITY_CAPACITY_MAX_MS = 8000;
export const ANTIGRAVITY_CAPACITY_JITTER_RATIO = 0.1;
// Total time capacity retries may spend waiting on server-advised delays.
export const ANTIGRAVITY_CAPACITY_BUDGET_MS = 60_000;
export const ANTIGRAVITY_QUICK_RETRY_MS = 1000;
export const ANTIGRAVITY_QUICK_RETRY_MAX_ADVICE_MS = 60_000;

const DEFAULT_RETRY_BACKOFF_MS = Object.freeze([1000, 1000, 2000, 4000]);

function envInt(env, name, fallback, min, max) {
  const raw = env?.[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function envBackoffMs(env, name) {
  const raw = String(env?.[name] ?? '').trim();
  if (!raw) return DEFAULT_RETRY_BACKOFF_MS;
  const steps = raw.split(',').map((step) => Number(step.trim()));
  if (!steps.every((step) => Number.isInteger(step) && step >= 0)) return DEFAULT_RETRY_BACKOFF_MS;
  return Object.freeze(steps);
}

/**
 * The same-host ladder for everything that is not a 429, read from the
 * environment: attempts (1–6), the backoff list (index n is the wait before
 * attempt n) and how many first-byte timeouts a thinking model may retry.
 */
export function resolveAntigravityRetryConfig(env = process.env) {
  return {
    maxAttempts: envInt(env, 'MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS', ANTIGRAVITY_CAPACITY_RETRIES + 1, 1, 6),
    backoffMs: envBackoffMs(env, 'MIXDOG_ANTIGRAVITY_RETRY_BACKOFF_MS'),
    firstByteRetries: envInt(env, 'MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES', 1, 0, 5),
  };
}

const RETRY_CONFIG = resolveAntigravityRetryConfig();

// withRetry options for everything that is not a 429: transient transport and
// 5xx failures use the capacity schedule (the reference has no other same-host
// retry; the leading duplicate is the sleep-before-attempt index).
export const ANTIGRAVITY_RETRY = Object.freeze({
  maxAttempts: RETRY_CONFIG.maxAttempts,
  backoffMs: RETRY_CONFIG.backoffMs,
  retryJitterRatio: ANTIGRAVITY_CAPACITY_JITTER_RATIO,
  // 429s are handled by antigravity429WaitMs, not the generic loop.
  retry429: false,
});

export const ANTIGRAVITY_FIRST_BYTE_RETRIES = RETRY_CONFIG.firstByteRetries;

// Pro-class window: 300s requested, clamped to the provider ceiling.
export const ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS = resolveTimeoutMs('MIXDOG_ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS', 300_000, {
  minMs: 30_000,
  maxMs: PROVIDER_MAX_BEFORE_WARN_MS,
});

// First-attempt window per catalog family.
const FAMILY_FIRST_BYTE_MS = Object.freeze({
  'gemini-pro': ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS,
  'gemini-flash': GEMINI_FIRST_BYTE_TIMEOUT_MS,
});

// Models without a Gemini family: the shared Gemini window on the ordinary ladder.
export const ANTIGRAVITY_UNCLASSED_FIRST_BYTE = Object.freeze({
  timeoutMs: GEMINI_FIRST_BYTE_TIMEOUT_MS,
  maxMs: GEMINI_FIRST_BYTE_TIMEOUT_MS,
  retries: null,
});

/**
 * First-byte policy (see firstByteWindowMs) for one model, picker or wire id.
 * The class comes from the catalog record's `family`.
 */
export function antigravityFirstBytePolicy(model, models) {
  const timeoutMs = FAMILY_FIRST_BYTE_MS[antigravityModelFamily(model, models)];
  if (!timeoutMs) return ANTIGRAVITY_UNCLASSED_FIRST_BYTE;
  return {
    timeoutMs,
    maxMs: PROVIDER_MAX_BEFORE_WARN_MS,
    retries: Math.min(ANTIGRAVITY_FIRST_BYTE_RETRIES, ANTIGRAVITY_RETRY.maxAttempts - 1),
  };
}

/**
 * Longest a send may wait before its first output across the whole transport
 * ladder ({ transportMs, semanticMs }, see firstBytePolicyBudget): the agent
 * watchdog must not fire inside it. Drops and 5xx share the ladder with
 * first-byte timeouts, so the budget is every backoff step of the ladder plus
 * the windows of the first-byte timeouts the policy permits (all attempts for
 * a policy without its own retry cap).
 */
export function antigravityFirstResponseBudget(policy, backoffMs = ANTIGRAVITY_RETRY.backoffMs) {
  return firstBytePolicyBudget(policy, { attempts: ANTIGRAVITY_RETRY.maxAttempts, backoffMs });
}

/** Capacity wait for retry number `retryIndex` (0-based): 1s, 2s, 4s, 8s cap, ±10%. */
function antigravityCapacityDelayMs(retryIndex) {
  const base = Math.min(ANTIGRAVITY_CAPACITY_BASE_MS * 2 ** retryIndex, ANTIGRAVITY_CAPACITY_MAX_MS);
  return Math.round(
    base * (1 - ANTIGRAVITY_CAPACITY_JITTER_RATIO + Math.random() * 2 * ANTIGRAVITY_CAPACITY_JITTER_RATIO)
  );
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
  if (
    DETERMINISTIC_KINDS.has(kind) ||
    err.code === 'quota_exhausted' ||
    err.quotaScope === 'day' ||
    err.quotaScope === 'plan'
  ) {
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
