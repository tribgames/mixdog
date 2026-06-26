/**
 * retry-classifier.mjs — shared transient/permanent error classifier
 *
 * Single source of truth across every provider (openai-oauth-ws, openai-oauth,
 * anthropic-oauth, anthropic, gemini, openai-ws, openai-compat).
 *
 * Goal: when a provider returns a transient server-side condition we should
 * retry; when it returns a deterministic refusal (auth, permission, quota)
 * we should fail fast. Mid-stream WS events (server-supplied error / response
 * .failed messages) historically lost their HTTP status because the message
 * was wrapped without classification — that left "Our servers are currently
 * overloaded" indistinguishable from a permanent failure to the retry layer.
 *
 * Usage:
 *   import { classifyError, populateHttpStatusFromMessage } from './retry-classifier.mjs'
 *   const kind = classifyError(err)               // 'auth' | 'permanent' | 'transient' | 'unknown'
 *   populateHttpStatusFromMessage(err)            // mutates err.httpStatus if message hints at one
 */

import {
  PROVIDER_MAX_BEFORE_WARN_MS,
  PROVIDER_RETRY_BACKOFF_MS,
  PROVIDER_RETRY_JITTER_RATIO,
  PROVIDER_RETRY_MAX_ATTEMPTS,
  createTimeoutSignal,
} from '../stall-policy.mjs'

// HTTP statuses considered transient — safe to retry with backoff.
//   408 — request timeout
//   429 — rate limit (caller may still respect Retry-After, but the kind
//         classification here only signals "retryable"; sub-error in the
//         provider can still treat 429 as permanent for quota-exhausted)
//   500/502/503/504 — server errors (overload / bad gateway / timeout)
const TRANSIENT_STATUSES = new Set([408, 500, 502, 503, 504])

// HTTP statuses that mean "permanent: stop retrying, surface to caller".
//   401/403 — auth issue
//   404 — not found
//   400/422 — bad request (deterministic)
const AUTH_STATUSES = new Set([401, 403])
const PERMANENT_STATUSES = new Set([400, 404, 405, 410, 415, 422])

// Server-message text patterns. Used when a WS / SSE event carries an error
// payload but no explicit status code — we sniff the text and assign the most
// likely HTTP equivalent so the retry layer can use the same rules.
const MESSAGE_PATTERNS = [
  // OpenAI/Codex sometimes surfaces generic backend failures only as
  // message text plus a request ID, with no HTTP status on the WS event.
  { regex: /(?:an error occurred while processing your request|please include the request id)/i, status: 503 },
  // Overload / transient 5xx — server is asking us to back off. The `\b`
  // anchor is intentionally OMITTED on the trailing side of `overload` so
  // "overloaded" / "overloading" both match (inflected forms are common in
  // server error text).
  { regex: /(?:overload(?:ed|ing)?|temporarily unavailable|try again later|service unavailable|bad gateway|gateway timeout)/i, status: 503 },
  // Explicit 5xx mention.
  { regex: /\b(?:5\d\d|http 5\d\d)\b/i, status: 503 },
  // Rate limit / quota — same retry posture as 429 but treat as permanent
  // by classifyError because per-call retry won't change the answer (the
  // window must elapse). Providers that want time-bounded retry should
  // honor Retry-After on the original response, not loop here.
  { regex: /(?:rate ?limit|quota)/i, status: 429 },
  // Auth — never retryable from our side.
  { regex: /\b(?:unauthorized|unauthorised|authentication|not authenticated|token expired|access token|invalid api key)\b/i, status: 401 },
  { regex: /\b(?:forbidden|permission denied|policy violation)\b/i, status: 403 },
]

/**
 * Inspect `err.message` (or the explicit `msg` argument) and, if the text
 * matches one of the known transient/permanent patterns, set `err.httpStatus`
 * to the corresponding code. No-op when httpStatus is already set.
 *
 * Returns the resolved httpStatus (existing or newly assigned), or 0 when
 * nothing matched.
 */
export function populateHttpStatusFromMessage(err, msg = null) {
  if (!err || typeof err !== 'object') return 0
  if (Number(err.httpStatus) > 0) return Number(err.httpStatus)
  const text = String(msg ?? err.message ?? '')
  if (!text) return 0
  for (const { regex, status } of MESSAGE_PATTERNS) {
    if (regex.test(text)) {
      err.httpStatus = status
      return status
    }
  }
  return 0
}

/**
 * Classify an error for retry policy. Combines HTTP status (when set) and
 * message-text fallback so message-only errors (mid-stream WS error events)
 * route through the same logic as fetch responses.
 *
 *   'auth'      — 401/403 — invalid credentials / forbidden, fail fast.
 *   'permanent' — 4xx (non-auth) or quota — caller decision is final.
 *   'transient' — 5xx/408 or socket-level transient codes — retry with backoff.
 *   'unknown'   — neither; default to permanent in safety-critical paths,
 *                 or retry once in best-effort paths.
 */
export function classifyError(err) {
  if (!err) return 'unknown'
  // Once a streamed tool call has been surfaced to the loop, retrying the same
  // provider turn can double-execute that tool. Providers mark these stream
  // failures as unsafe so the shared retry wrapper fails fast.
  if (err.emittedToolCall === true || err.toolCallEmitted === true || err.unsafeToRetry === true) return 'permanent'
  // Truncated SSE stream (message_start without message_stop). These are
  // idempotent to retry: the partial result is discarded, and a pendingToolUse
  // means the tool_use input JSON never completed, so re-requesting is safe.
  // Checked BEFORE HTTP-status classification so a truncation error that also
  // carries a 4xx/429 status still classifies transient per the contract.
  // Treating this as transient is what lets every withRetry / mid-stream-loop
  // consumer recover a cut-off stream uniformly.
  if (err.truncatedStream === true || err.code === 'TRUNCATED_STREAM') return 'transient'

  // Honor explicit httpStatus first, then sniff message text.
  const status = Number(err.httpStatus || err.status || err.response?.status || 0) || populateHttpStatusFromMessage(err)
  if (AUTH_STATUSES.has(status)) return 'auth'
  if (status === 429) return 'permanent'
  if (TRANSIENT_STATUSES.has(status)) return 'transient'
  if (PERMANENT_STATUSES.has(status)) return 'permanent'

  // Socket-level codes (Node errno) — DNS / reset / refused / timeout are all
  // transient: we can retry the same request and may succeed.
  const code = String(err.code || '')
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT'
    || code === 'EAI_AGAIN' || code === 'ENOTFOUND' || code === 'EAI_NODATA'
    || code === 'ECONNREFUSED' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH'
    || code === 'EPIPE'
    || code === 'EPROVIDERTIMEOUT' || code === 'EGEMINITIMEOUT'
    || code === 'EWSACQUIRETIMEOUT') {
    return 'transient'
  }

  return 'unknown'
}

// Provider error-text signatures for a context-window / input-too-large
// rejection. These are DETERMINISTIC refusals (the request is simply too big)
// — not transient faults — so they must never be routed through the
// network/stall retry path. The fix is to shrink the payload (trim harder)
// and re-send, which the agent loop's send path does once before surfacing.
// Patterns cover OpenAI ("maximum context length", "reduce the length"),
// Anthropic ("prompt is too long"), and generic "input exceeds the context
// window" phrasing. Match is case-insensitive over err.message.
const CONTEXT_OVERFLOW_PATTERNS = [
  /input (?:length|tokens?) exceeds? the context window/i,
  /exceeds? the (?:maximum )?context (?:window|length)/i,
  /maximum context length/i,
  /context[_ ]length[_ ]exceeded/i,
  /prompt is too long/i,
  /reduce the length of (?:the )?(?:messages|input|prompt)/i,
]

/**
 * True when `err` is a context-window-exceeded provider rejection. Walks
 * err.cause / err.response.data up to depth 2 so SDK-wrapped errors are
 * detected. Deterministic: the same request will always be rejected, so
 * callers must shrink the payload (trim harder) before re-sending rather
 * than blindly retrying against the same input.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isContextOverflowError(err, _depth = 0) {
  if (!err || _depth > 2) return false
  const msg = (err instanceof Error ? err.message : (typeof err === 'string' ? err : err?.message)) || ''
  if (msg && CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(msg))) return true
  if (err.cause != null && err.cause !== err) return isContextOverflowError(err.cause, _depth + 1)
  if (err.response?.data != null) return isContextOverflowError(err.response.data, _depth + 1)
  return false
}

function _headerValue(headers, name) {
  if (!headers) return null
  const lower = name.toLowerCase()
  if (typeof headers.get === 'function') return headers.get(name) || headers.get(lower)
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return Array.isArray(v) ? v[0] : v
  }
  return null
}

export function retryAfterMsFromError(err) {
  const headers = err?.headers || err?.response?.headers || err?.data?.responseHeaders || null
  const retryAfterMs = _headerValue(headers, 'retry-after-ms')
  if (retryAfterMs != null && retryAfterMs !== '') {
    const n = Number(retryAfterMs)
    if (Number.isFinite(n) && n >= 0) return n
  }
  const retryAfter = _headerValue(headers, 'retry-after')
  if (retryAfter == null || retryAfter === '') return null
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const dateMs = Date.parse(String(retryAfter))
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now())
  return null
}

/**
 * Convenience predicate: should this error be retried at the request level?
 * Wraps classifyError() with the standard "transient = retry, otherwise no"
 * policy. Callers that have provider-specific retry budgets (e.g. anthropic-
 * oauth's MAX_ATTEMPTS, openai-oauth-ws's mid-stream classifier) still gate
 * on attempt count separately; this helper only answers the kind question.
 */
export function isRetryable(err) {
  return classifyError(err) === 'transient'
}

// Default backoff schedule used by withRetry when caller does not override.
// Mirrors anthropic-oauth's 5-attempt curve (immediate + 1s/2s/4s/8s) so the
// total cap stays under 15s. Total upper bound = sum = 15s.
const DEFAULT_BACKOFF_MS = PROVIDER_RETRY_BACKOFF_MS
const DEFAULT_MAX_ATTEMPTS = PROVIDER_RETRY_MAX_ATTEMPTS

export function jitterDelayMs(ms, ratio = PROVIDER_RETRY_JITTER_RATIO, mode = 'symmetric') {
  const base = Number(ms) || 0
  if (base <= 0) return 0
  const r = Math.min(Math.max(Number(ratio) || 0, 0), 1)
  if (!r) return Math.round(base)
  const spread = base * r
  const offset = mode === 'positive'
    ? Math.random() * spread
    : (Math.random() * 2 - 1) * spread
  return Math.max(0, Math.round(base + offset))
}

/**
 * Run an async function with exponential-backoff retry on transient errors.
 *
 * Behavior:
 *   - Calls `fn()` up to `maxAttempts` times.
 *   - Between attempts, sleeps `backoffMs[attemptIndex]`.
 *   - Honors `signal` (AbortSignal): aborts current attempt's wait and re-
 *     throws caller's reason. Does NOT abort an in-flight call — that's
 *     the provider's own responsibility via its native abort plumbing.
 *   - Uses classifyError() to decide retry. 'transient' → retry,
 *     'auth' / 'permanent' / 'unknown' → throw immediately.
 *   - populateHttpStatusFromMessage(err) is called on every caught error so
 *     server-text errors (e.g. "Our servers are currently overloaded")
 *     resolve to httpStatus before classification.
 *
 * Returns whatever `fn()` resolves to. Throws the last error if every retry
 * is exhausted, or the first error if it's classified non-transient.
 */
export async function withRetry(fn, opts = {}) {
  const maxAttempts = Number(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const backoffMs = Array.isArray(opts.backoffMs) ? opts.backoffMs : DEFAULT_BACKOFF_MS
  const signal = opts.signal || null
  const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null
  const perAttemptTimeoutMs = Number(opts.perAttemptTimeoutMs || 0)
  const perAttemptLabel = opts.perAttemptLabel || 'provider request'
  const maxRetryAfterMs = Number(opts.maxRetryAfterMs ?? PROVIDER_MAX_BEFORE_WARN_MS)
  const retryJitterRatio = Number(opts.retryJitterRatio ?? PROVIDER_RETRY_JITTER_RATIO)

  let lastErr = null
  let nextDelayMs = null
  let nextDelayReason = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      const reason = signal.reason
      throw reason instanceof Error ? reason : new Error('withRetry: aborted')
    }
    if (attempt > 0) {
      const rawWait = nextDelayMs ?? backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 0
      const wait = jitterDelayMs(
        rawWait,
        retryJitterRatio,
        nextDelayReason === 'retry-after' ? 'positive' : 'symmetric',
      )
      const boundedWait = nextDelayReason === 'retry-after' && Number.isFinite(maxRetryAfterMs)
        ? Math.min(wait, maxRetryAfterMs)
        : wait
      onRetry?.({ attempt, lastErr, delayMs: boundedWait, delayReason: nextDelayReason })
      if (boundedWait > 0) await _sleepWithAbort(boundedWait, signal)
      if (signal?.aborted) {
        const reason = signal.reason
        throw reason instanceof Error ? reason : new Error('withRetry: aborted')
      }
      nextDelayMs = null
      nextDelayReason = null
    }
    const attemptTimeout = perAttemptTimeoutMs > 0
      ? createTimeoutSignal(signal, perAttemptTimeoutMs, `${perAttemptLabel} attempt ${attempt + 1}`)
      : null
    const attemptSignal = attemptTimeout?.signal || signal
    try {
      return await fn({ attempt, signal: attemptSignal })
    } catch (err) {
      let caught = err
      if (!signal?.aborted && attemptSignal?.aborted && attemptSignal.reason instanceof Error) {
        caught = attemptSignal.reason
      }
      if (signal?.aborted) {
        const reason = signal.reason
        throw reason instanceof Error ? reason : new Error('withRetry: aborted')
      }
      lastErr = caught
      populateHttpStatusFromMessage(caught)
      const retryAfterMs = retryAfterMsFromError(caught)
      const status = Number(caught?.httpStatus || caught?.status || caught?.response?.status || 0)
      const kind = classifyError(caught)
      const unsafeToRetry = caught?.unsafeToRetry === true
        || caught?.providerQuota === true
        || caught?.quotaExceeded === true
      if (unsafeToRetry) throw caught
      const retryableRateLimit = status === 429 && retryAfterMs != null
      if (kind !== 'transient' && !retryableRateLimit) throw caught
      // Last attempt failed transiently — propagate to caller.
      if (attempt === maxAttempts - 1) throw caught
      if (retryAfterMs != null) {
        nextDelayMs = Math.max(0, Math.min(retryAfterMs, maxRetryAfterMs))
        nextDelayReason = 'retry-after'
      }
    } finally {
      attemptTimeout?.cleanup()
    }
  }
  // Defensive — loop above always returns or throws.
  throw lastErr || new Error('withRetry: exhausted with no error captured')
}

function _sleepWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    let onAbort = null
    const t = setTimeout(() => {
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort) } catch {}
      }
      resolve()
    }, ms)
    if (!signal) return
    if (signal.aborted) {
      clearTimeout(t)
      const reason = signal.reason
      reject(reason instanceof Error ? reason : new Error('sleep aborted'))
      return
    }
    onAbort = () => {
      clearTimeout(t)
      const reason = signal.reason
      reject(reason instanceof Error ? reason : new Error('sleep aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
