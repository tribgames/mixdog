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
//   500/502/503/504 — server errors (overload / bad gateway / timeout)
//   429 is handled separately by withRetry(): only the affected request waits
//   with jitter; provider/account admission concurrency remains fixed.
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
  // OpenAI OAuth/API sometimes surfaces generic backend failures only as
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
  { regex: /(?:rate[_ -]?limit|quota|too many requests|resource exhausted|insufficient_quota|quota_exceeded)/i, status: 429 },
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
    || code === 'EPROVIDERTIMEOUT' || code === 'EGEMINITIMEOUT' || code === 'ESTREAMSTALL'
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

export const MIDSTREAM_BACKOFF_MS = [250, 1000, 2000, 4000]

export function midstreamBackoffFor(retryNumber, schedule = MIDSTREAM_BACKOFF_MS) {
  const raw = schedule[Math.min(Math.max(retryNumber, 1), schedule.length) - 1]
  return jitterDelayMs(raw)
}

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

// ── Shared network-resilience interface ──────────────────────────────────────
// One home for the logic shared across providers: mid-stream classifier
// (WS + SSE), transport fallback predicate, stream-safety stamp latches,
// abort-aware sleep, handshake classifier, and the retry-budget table.
// Provider differences are passed as ARGUMENTS (policy objects), never
// branched on a hardcoded provider name.

// F) Retry-budget profiles as DATA. The numbers live ONLY here now.
//    ws.transientCloseRetries (4) — ws_1006 / ws_1011 connection-loss buckets.
//    ws.defaultRetries (2)        — every other WS mid-stream bucket.
//    sse.defaultRetries (3)       — anthropic single-shot SSE mid-stream budget.
export const MIDSTREAM_RETRY_POLICY = {
  ws: { transientCloseRetries: 4, defaultRetries: 2, backoff: [250, 1000, 2000, 4000] },
  sse: { defaultRetries: 3, backoff: [250, 1000, 2000, 4000] },
}

// WS buckets that earn the larger transient-close retry budget.
const WS_TRANSIENT_CLOSE_CLASSIFIERS = new Set(['ws_1006', 'ws_1011'])

function _midstreamLimitFor(classifier, policy) {
  if (policy.mode === 'ws') {
    return WS_TRANSIENT_CLOSE_CLASSIFIERS.has(classifier)
      ? policy.transientCloseRetries
      : policy.defaultRetries
  }
  return policy.defaultRetries
}

// WS gates each classifier against its own budget. SSE applies a single
// top-of-function budget gate and
// then returns raw classifier strings, so perClassifierGate:false returns the
// classifier unconditionally here.
function _allowMidstream(classifier, attemptIndex, policy) {
  if (policy.perClassifierGate === false) return classifier
  return attemptIndex < _midstreamLimitFor(classifier, policy) ? classifier : null
}

// A) Unified mid-stream classifier. Returns a classifier string or null.
//    `signals` is the provider's mid-stream state object (field names unchanged
//    from each provider's midState). `policy.mode` selects the WS or SSE path so
//    both providers reproduce their exact current branch order and gating.
export function classifyMidstreamError(err, signals, policy = {}) {
  if (!signals) return null
  const attemptIndex = signals.attemptIndex | 0
  if (policy.mode === 'sse') return _classifyMidstreamSse(err, signals, attemptIndex, policy)
  return _classifyMidstreamWs(err, signals, attemptIndex, policy)
}

// Verbatim relocation of openai-oauth-ws's _classifyMidstreamError. `signals`
// carries sawResponseCreated / sawCompleted / emittedText / emittedToolCall /
// wsCloseCode / firstByteTimeout / wsSendFailed /
// userAbort / watchdogAbort / responseFailedPayload exactly as before.
function _classifyMidstreamWs(err, state, attemptIndex, policy) {
  if (state.sawCompleted) return null
  // Once a tool call has been dispatched, no transport outcome is replay-safe.
  // This includes a nominal close-1000 before response.completed: the tool may
  // already be executing, so retry/fallback could duplicate its side effect.
  if (state.emittedToolCall) return null
  if (state.emittedText || err?.liveTextEmitted) return null
  if (state.firstByteTimeout || err?.firstByteTimeout) {
    return _allowMidstream('first_byte_timeout', attemptIndex, policy)
  }
  if (err?.wsSendFailed || state.wsSendFailed) {
    return _allowMidstream('ws_send_failed', attemptIndex, policy)
  }
  // Stall / local-close-4000 must be classified as RETRYABLE before the
  // pre-`response.created` deny gate below. A first-meaningful-frame timeout
  // fires with sawResponseCreated=false + close 4000 + StreamStalledError, so
  // without this the pre-created gate would return null (terminal) and the
  // stall would never route through the mid-stream retry / transport fallback.
  {
    const name = err?.name || ''
    const closeCode = Number(err?.wsCloseCode || state.wsCloseCode || 0)
    if (name === 'AgentStallAbortError' || state.watchdogAbort === 'AgentStallAbortError') {
      return _allowMidstream('agent_stall', attemptIndex, policy)
    }
    if (name === 'StreamStalledAbortError' || name === 'StreamStalledError'
      || err?.code === 'ESTREAMSTALL' || err?.streamStalled === true
      || state.watchdogAbort === 'StreamStalledAbortError') {
      // A stall AFTER a tool emit is unsafe to replay (double side-effect).
      if (err?.unsafeToRetry === true) return null
      return _allowMidstream('stream_stalled', attemptIndex, policy)
    }
    if (closeCode === 4000) return _allowMidstream('ws_4000', attemptIndex, policy)
  }
  if (!state.sawResponseCreated) {
    const closeCode = Number(err?.wsCloseCode || state.wsCloseCode || 0)
    // An abnormal close before response.created has not produced any response
    // bytes to the caller. It is therefore safe to reconnect and replay under
    // the normal ws_1006 bounded retry policy (text/tool emission was denied
    // above before reaching this gate).
    if (closeCode !== 1006 && closeCode !== 1011 && closeCode !== 1012) return null
  }
  if (state.userAbort) return null

  if (!err) return null
  const status = Number(err?.httpStatus || 0)
  if (status === 401 || status === 403 || status === 429) return null
  if (status >= 500 && status < 600) {
    return _allowMidstream(`http_${status}`, attemptIndex, policy)
  }

  const name = err?.name || ''
  if (name === 'AgentStallAbortError') return _allowMidstream('agent_stall', attemptIndex, policy)
  if (name === 'StreamStalledAbortError' || name === 'StreamStalledError' || err?.code === 'ESTREAMSTALL' || err?.streamStalled === true) {
    // A stall that fired AFTER a tool call was emitted is unsafe to replay
    // (double side-effect); surface it as terminal so the turn is not retried.
    if (err?.unsafeToRetry === true) return null
    return _allowMidstream('stream_stalled', attemptIndex, policy)
  }

  if (state.watchdogAbort === 'AgentStallAbortError') return _allowMidstream('agent_stall', attemptIndex, policy)
  if (state.watchdogAbort === 'StreamStalledAbortError') return _allowMidstream('stream_stalled', attemptIndex, policy)

  const closeCode = Number(err?.wsCloseCode || state.wsCloseCode || 0)
  if (closeCode === 1006) return _allowMidstream('ws_1006', attemptIndex, policy)
  if (closeCode === 1011) return _allowMidstream('ws_1011', attemptIndex, policy)
  if (closeCode === 1012) return _allowMidstream('ws_1012', attemptIndex, policy)
  if (closeCode >= 4000 && closeCode < 5000 && closeCode !== 4000) return null
  if (closeCode === 4000) return _allowMidstream('ws_4000', attemptIndex, policy)
  if (closeCode === 1000 && state.sawResponseCreated && !state.sawCompleted) return _allowMidstream('ws_1000', attemptIndex, policy)

  const failed = err?.responseFailed || state.responseFailedPayload
  if (failed) {
    try {
      const blob = JSON.stringify(failed).toLowerCase()
      if (blob.includes('stream_disconnected')) return _allowMidstream('response_failed_disconnected', attemptIndex, policy)
      if (blob.includes('network_error')) return _allowMidstream('response_failed_network', attemptIndex, policy)
      if (blob.includes('auth context expired')) return _allowMidstream('response_failed_auth_expired', attemptIndex, policy)
    } catch {}
  }

  return null
}

// Verbatim relocation of anthropic-oauth's _classifyMidstreamError. `signals`
// carries sawMessageStart / sawCompleted / emittedToolCall / userAbort /
// watchdogAbort exactly as before.
function _classifyMidstreamSse(err, state, attemptIndex, policy) {
  if (attemptIndex >= policy.defaultRetries) return null
  if (state.sawCompleted) return null
  if (!state.sawMessageStart) return null
  if (state.userAbort) return null
  if (state.emittedToolCall) return null

  if (!err) return null
  const status = Number(err?.httpStatus || 0)
  if (status === 401 || status === 403 || status === 429) return null

  const name = err?.name || ''
  if (name === 'AgentStallAbortError') return 'agent_stall'
  if (name === 'StreamStalledAbortError' || name === 'StreamStalledError' || err?.code === 'ESTREAMSTALL' || err?.streamStalled === true) {
    // A stall AFTER a tool emit is unsafe to replay (double side-effect) →
    // terminal (null), no mid-stream retry. Otherwise route to stream_stalled.
    if (err?.unsafeToRetry === true) return null
    return 'stream_stalled'
  }
  if (state.watchdogAbort === 'AgentStallAbortError') return 'agent_stall'
  if (state.watchdogAbort === 'StreamStalledAbortError') return 'stream_stalled'

  const code = err?.code || err?.cause?.code || ''
  if (code === 'ECONNRESET') return 'reset'
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA') return 'dns'

  const msg = String(err?.message || '').toLowerCase()
  if (msg.includes('stream timed out after') && msg.includes('of inactivity')) return 'sse_idle_timeout'
  if (msg.includes('body stream') && msg.includes('terminated')) return 'stream_terminated'
  if (msg.includes('fetch failed')) return 'fetch_failed'

  return null
}

// B) Unified transport (WS→HTTP) fallback predicate. Identical deny-order +
//    allow-list to the two former copies; `enabled` replaces the per-provider
//    env-flag check (caller computes the flag and passes it).
const TRANSPORT_FALLBACK_CLASSIFIERS = new Set([
  'timeout', 'reset', 'dns', 'refused', 'network', 'acquire_timeout', 'http_5xx',
  'first_byte_timeout',
  'ws_1006', 'ws_1011', 'ws_1012', 'ws_1000', 'ws_4000', 'agent_stall', 'stream_stalled',
  'response_failed_disconnected', 'response_failed_network', 'response_failed_auth_expired',
  'ws_send_failed',
])
const TRANSPORT_FALLBACK_ERRNO = new Set([
  'EWSACQUIRETIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'EAI_AGAIN',
  'ENOTFOUND', 'EAI_NODATA', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE',
])

export function shouldFallbackTransport(err, { signal, enabled = true } = {}) {
  if (!enabled) return false
  if (signal?.aborted) return false
  if (err?.liveTextEmitted === true) return false
  if (err?.emittedToolCall === true || err?.unsafeToRetry === true) return false
  const status = Number(err?.httpStatus || err?.status || 0)
  if (status === 401 || status === 403 || status === 404 || status === 429) return false
  if (status >= 500 && status < 600) return true
  const code = String(err?.code || '')
  if (TRANSPORT_FALLBACK_ERRNO.has(code)) return true
  const classifier = String(err?.retryClassifier || err?.midstreamClassifier || '')
  if (TRANSPORT_FALLBACK_CLASSIFIERS.has(classifier)) return true
  if (/^http_5\d\d$/.test(classifier)) return true
  if (err?.firstByteTimeout) return true
  const msg = String(err?.message || '')
  return /opening handshake has timed out|socket hang up|acquire timed out|no first server event|no meaningful output/i.test(msg)
}

// C) Stream-safety stamp latches. Mirrors openai-oauth-ws's _stampLiveText /
//    _stampTool: once text/tool has been marked, every subsequent throw path
//    re-applies the liveTextEmitted/emittedToolCall + unsafeToRetry markers so
//    no upstream gate can reissue the turn and concatenate attempts.
export function createStreamSafetyStamps() {
  let textLatched = false
  let toolLatched = false
  const stampText = (e) => {
    if (textLatched && e) { try { e.liveTextEmitted = true; e.unsafeToRetry = true } catch {} }
    return e
  }
  const stampTool = (e) => {
    if (toolLatched && e) { try { e.emittedToolCall = true; e.unsafeToRetry = true } catch {} }
    return e
  }
  return {
    markText() { textLatched = true },
    markTool() { toolLatched = true },
    stampText,
    stampTool,
    stampAll: (e) => stampTool(stampText(e)),
  }
}

const _defaultAbortSleep = (ms) => new Promise((r) => setTimeout(r, ms))

// D) Abort-aware sleep (single copy). Resolves after `ms`, or rejects with the
//    signal's reason (or `abortMessage`) the moment the signal aborts. `sleepFn`
//    is the injectable no-signal sleep (test seam); `abortMessage` preserves
//    each caller's prior fallback text when the abort reason is not an Error.
export async function sleepWithAbort(ms, signal, sleepFn = _defaultAbortSleep, abortMessage = 'sleep aborted') {
  if (!ms) return
  if (!signal) {
    await (sleepFn || _defaultAbortSleep)(ms)
    return
  }
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try { signal.removeEventListener('abort', onAbort) } catch {}
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      const reason = signal.reason
      reject(reason instanceof Error ? reason : new Error(abortMessage))
    }
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// E) Handshake classifier (moved here from openai-oauth-ws). Default-deny:
//    anything not recognized as transient returns null. 401/403/404/429 are
//    permanent. Returns 'timeout' | 'reset' | 'dns' | 'refused' | 'network' |
//    'acquire_timeout' | `http_5xx` | null.
export function classifyHandshakeError(err) {
  if (!err) return null
  const code = err.code || ''
  const msg = String(err.message || '')
  const status = Number(err.httpStatus || 0)

  if (status === 401 || status === 403 || status === 404 || status === 429) {
    return null
  }
  if (status >= 500 && status < 600) {
    return `http_${status}`
  }

  if (code === 'ECONNRESET') return 'reset'
  if (code === 'EAI_AGAIN' || code === 'ENOTFOUND' || code === 'EAI_NODATA') return 'dns'
  if (code === 'ECONNREFUSED') return 'refused'
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout'
  if (code === 'EWSACQUIRETIMEOUT') return 'acquire_timeout'
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'EPIPE') return 'network'

  if (/opening handshake has timed out/i.test(msg)) return 'timeout'
  if (/socket hang up/i.test(msg)) return 'reset'

  return null
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
      const status = Number(caught?.httpStatus || caught?.status || caught?.response?.status || 0)
      const kind = classifyError(caught)
      const outputWasExposed = caught?.liveTextEmitted === true
        || caught?.emittedText === true
        || caught?.emittedToolCall === true
        || caught?.toolCallEmitted === true
      if (outputWasExposed || caught?.unsafeToRetry === true) throw caught
      if (status === 429) {
        // Retry only this request. Admission concurrency is fixed and is never
        // reduced by rate limits. Respect Retry-After when present; otherwise
        // use the ordinary jittered backoff. Output/tool stamps above remain a
        // hard replay boundary.
        const ra = retryAfterMsFromError(caught)
        if (attempt === maxAttempts - 1) throw caught
        if (ra != null) {
          nextDelayMs = Math.max(0, Math.min(ra, maxRetryAfterMs))
          nextDelayReason = 'retry-after'
        }
        continue
      }
      if (kind !== 'transient') throw caught
      // Last attempt failed transiently — propagate to caller.
      if (attempt === maxAttempts - 1) throw caught
      const retryAfterMs = retryAfterMsFromError(caught)
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
