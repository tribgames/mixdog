// Fast-mode capacity policy for the Anthropic providers.
//
// `speed: 'fast'` rides a separate capacity pool. When that pool is exhausted
// the request comes back 429 (rate limit) or 529 (overloaded) — waiting out a
// long Retry-After on the fast pool wastes the turn AND thrashes the prompt
// cache, because the retry after the wait carries a different speed anyway.
// The reference client's rule: a SHORT server window is worth waiting for at
// fast speed (the cache prefix survives), anything longer drops to standard
// speed for a cooldown (reference thresholds: <20s keeps fast; otherwise\n// max(Retry-After ?? 30min, 10min)). An explicit "overage billing unavailable" header is
// terminal for the process — no cooldown can make paid overage appear.
//
// State is process-wide because the capacity pool is per-account, not per
// session: one session discovering the pool is empty must not leave sibling
// sessions hammering it.

import { headerValue } from './retry-classification.mjs';
import { retryAfterMsFromHeaders } from './anthropic-error-contract.mjs';

// Server-declared reason header for a fast-mode rejection caused by missing
// overage billing (matches the reference client's header name).
const OVERAGE_DISABLED_HEADER = 'anthropic-ratelimit-unified-overage-disabled-reason';
// Reasons that mean the wallet is empty / capped for now rather than that
// overage can never exist: the request drops to standard speed, but fast mode
// is not switched off (the reference client keeps its setting for these).
const TRANSIENT_OVERAGE_REASONS = new Set(['org_level_disabled_until', 'out_of_credits']);
// A 400 from an account/endpoint that cannot serve fast mode at all. The same
// request succeeds at standard speed, and no cooldown makes it succeed fast.
const NOT_ENABLED_PATTERN = /fast mode is not enabled/i;
const NOT_ENABLED_REASON = 'fast_mode_not_enabled';

// A Retry-After under this bound is short enough that waiting keeps fast mode
// (and its cache prefix) worthwhile.
const SHORT_RETRY_THRESHOLD_MS = 20_000;
// Cooldown floor: without it a 1s window would flip fast mode on and off every
// turn, which costs more in cache misses than the downgrade saves.
const MIN_COOLDOWN_MS = 600_000;
// Applied when the server gives no window at all.
const DEFAULT_COOLDOWN_MS = 1_800_000;

let _cooldownUntilMs = 0;
let _disabledReason = null;

/** True when a request may still ask for `speed: 'fast'`. */
export function fastModeAvailable(now = Date.now()) {
  return _disabledReason === null && now >= _cooldownUntilMs;
}

export function fastModeCooldownRemainingMs(now = Date.now()) {
  if (_disabledReason !== null) return Number.POSITIVE_INFINITY;
  return Math.max(0, _cooldownUntilMs - now);
}

export function fastModeDisabledReason() {
  return _disabledReason;
}

/**
 * Record a capacity failure observed on a fast-mode request.
 *
 * Returns the decision for the caller:
 *   'ignored'   — not a fast request or not a capacity status; nothing changed.
 *   'retry-fast'— short server window; keep fast mode and let the normal retry
 *                 path wait it out.
 *   'downgrade' — cooldown started; the next attempt must drop `speed`.
 *   'disabled'  — overage unavailable; fast mode is off for this process.
 */
export function noteFastModeCapacityError(err, { fast = false, now = Date.now() } = {}) {
  if (!fast) return 'ignored';
  const status = Number(err?.httpStatus || err?.status || err?.response?.status || 0);
  if (status === 400 && NOT_ENABLED_PATTERN.test(String(err?.message || ''))) {
    _disabledReason = NOT_ENABLED_REASON;
    return 'disabled';
  }
  if (status !== 429 && status !== 529) return 'ignored';

  const headers = err?.headers || err?.response?.headers || err?.data?.responseHeaders || null;
  const overageReason = headerValue(headers, OVERAGE_DISABLED_HEADER);
  // The header's presence (even empty) is the signal, as in the reference client.
  if (overageReason != null) {
    if (TRANSIENT_OVERAGE_REASONS.has(String(overageReason))) return 'downgrade';
    _disabledReason = String(overageReason) || 'overage_unavailable';
    return 'disabled';
  }

  const retryAfterMs = serverWindowMs(err);
  const hasWindow = retryAfterMs != null;
  if (hasWindow && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) return 'retry-fast';

  const cooldownMs = Math.max(hasWindow ? retryAfterMs : DEFAULT_COOLDOWN_MS, MIN_COOLDOWN_MS);
  _cooldownUntilMs = Math.max(_cooldownUntilMs, now + cooldownMs);
  return 'downgrade';
}

/** True when the decision means the caller must drop `speed` before replaying. */
export function fastModeDowngraded(decision) {
  return decision === 'downgrade' || decision === 'disabled';
}

// The server's Retry-After window: an explicit err.retryAfterMs, else the
// Retry-After headers. The unified-reset header is deliberately not a window
// here (the reference client reads Retry-After only). null when none.
function serverWindowMs(err) {
  const explicit = err?.retryAfterMs;
  if (explicit != null && explicit !== '' && Number.isFinite(Number(explicit)) && Number(explicit) >= 0) {
    return Number(explicit);
  }
  return retryAfterMsFromHeaders(err?.headers || err?.response?.headers || err?.data?.responseHeaders || null);
}

/** Manual re-enable (user action) and test seam. */
export function clearFastModeCooldown() {
  _cooldownUntilMs = 0;
  _disabledReason = null;
}

export const _FAST_MODE_POLICY = Object.freeze({
  OVERAGE_DISABLED_HEADER,
  SHORT_RETRY_THRESHOLD_MS,
  MIN_COOLDOWN_MS,
  DEFAULT_COOLDOWN_MS,
});
