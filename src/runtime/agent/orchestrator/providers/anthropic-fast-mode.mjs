// Fast-mode capacity policy for the Anthropic providers.
//
// `speed: 'fast'` rides a separate capacity pool. When that pool is exhausted
// the request comes back 429 (rate limit) or 529 (overloaded) — waiting out a
// long Retry-After on the fast pool wastes the turn AND thrashes the prompt
// cache, because the retry after the wait carries a different speed anyway.
// The reference client's rule: a SHORT server window is worth waiting for at
// fast speed (the cache prefix survives), anything longer drops to standard
// speed for a cooldown. An explicit "overage billing unavailable" header is
// terminal for the process — no cooldown can make paid overage appear.
//
// State is process-wide because the capacity pool is per-account, not per
// session: one session discovering the pool is empty must not leave sibling
// sessions hammering it.

// Server-declared reason header for a fast-mode rejection caused by missing
// overage billing (matches the reference client's header name).
const OVERAGE_DISABLED_HEADER = 'anthropic-ratelimit-unified-overage-disabled-reason';

// A Retry-After under this bound is short enough that waiting keeps fast mode
// (and its cache prefix) worthwhile.
const SHORT_RETRY_THRESHOLD_MS = 10_000;
// Cooldown floor: without it a 1s window would flip fast mode on and off every
// turn, which costs more in cache misses than the downgrade saves.
const MIN_COOLDOWN_MS = 60_000;
// Applied when the server gives no window at all.
const DEFAULT_COOLDOWN_MS = 300_000;

let _cooldownUntilMs = 0;
let _disabledReason = null;

function _headerValue(headers, name) {
    if (!headers) return null;
    const lower = name.toLowerCase();
    if (typeof headers.get === 'function') return headers.get(name) ?? headers.get(lower);
    for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === lower) return Array.isArray(value) ? value[0] : value;
    }
    return null;
}

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
    if (status !== 429 && status !== 529) return 'ignored';

    const headers = err?.headers || err?.response?.headers || err?.data?.responseHeaders || null;
    const overageReason = _headerValue(headers, OVERAGE_DISABLED_HEADER);
    if (overageReason != null && String(overageReason) !== '') {
        _disabledReason = String(overageReason);
        return 'disabled';
    }

    const retryAfterMs = Number(err?.retryAfterMs);
    const hasWindow = Number.isFinite(retryAfterMs) && retryAfterMs >= 0;
    if (hasWindow && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) return 'retry-fast';

    const cooldownMs = Math.max(hasWindow ? retryAfterMs : DEFAULT_COOLDOWN_MS, MIN_COOLDOWN_MS);
    _cooldownUntilMs = Math.max(_cooldownUntilMs, now + cooldownMs);
    return 'downgrade';
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
