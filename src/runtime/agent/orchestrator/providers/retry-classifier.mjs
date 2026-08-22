/**
 * retry-classifier.mjs — shared transient/permanent error classifier
 *
 * Single source of truth across every provider (openai-oauth-ws, openai-oauth,
 * anthropic-oauth, anthropic, gemini, openai-ws, openai-compat).
 *
 * Goal: when a provider returns a TYPED transient server-side condition we
 * should retry; when it returns a deterministic refusal (auth, permission,
 * quota) we should fail fast. Evidence is structural only — HTTP status,
 * Node errno, SDK error type, WS close code, or a typed field on a wire event.
 * Error MESSAGE TEXT is never parsed into a status/transience/auth verdict:
 * an untyped failure stays 'unknown' and is surfaced, not retried.
 *
 * Usage:
 *   import { classifyError, typedStatusFrom } from './retry-classifier.mjs'
 *   const kind = classifyError(err)               // 'auth' | 'permanent' | 'transient' | 'unknown'
 *   typedStatusFrom(event.response?.error, event) // structured status, or 0
 */

import {
  PROVIDER_MAX_BEFORE_WARN_MS,
  PROVIDER_RETRY_BACKOFF_MS,
  PROVIDER_RETRY_JITTER_RATIO,
  PROVIDER_RETRY_MAX_ATTEMPTS,
  createTimeoutSignal,
} from '../stall-policy.mjs'
import { readStreamOutcome } from './lib/stream-outcome.mjs'
import { recycleLlmDispatcher } from '../../../shared/llm/http-agent.mjs'

export { readStreamOutcome, stampStreamOutcome, isReplaySafe, isReplayUnsafe, canPromoteToSuccess, hasObservedOutput, hasDispatchedToolCalls, STREAM_TRANSPORTS } from './lib/stream-outcome.mjs'

// HTTP statuses considered transient — safe to retry with backoff.
//   408 — request timeout
//   500/502/503/504 — server errors (overload / bad gateway / timeout)
//   429 is handled separately by withRetry(): only the affected request waits
//   with jitter; provider/account admission concurrency remains fixed.
const TRANSIENT_STATUSES = new Set([408, 409, 425])

// HTTP statuses that mean "permanent: stop retrying, surface to caller".
//   401/403 — auth issue
//   404 — not found
//   400/422 — bad request (deterministic)
const AUTH_STATUSES = new Set([401, 403])
const PERMANENT_STATUSES = new Set([400, 404, 405, 410, 415, 422])
// Cloudflare origin-TLS pages never clear on retry (grok-build edge_client).
const TERMINAL_EDGE_STATUSES = new Set([525, 526])
const GEMINI_TRANSIENT_RPC_CODES = new Set([
  'UNAVAILABLE', 'DEADLINE_EXCEEDED', 'ABORTED', 'INTERNAL',
])
const PREVIOUS_RESPONSE_NOT_FOUND = 'previous_response_not_found'
const WEBSOCKET_CONNECTION_LIMIT = 'websocket_connection_limit_reached'
const RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded'
const CONTEXT_OVERFLOW_CODES = new Set([
  'context_length_exceeded', 'context_window_exceeded', 'request_too_large',
])
const TRANSIENT_SDK_NAMES = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
])
const ANTHROPIC_RESET_HEADER = 'anthropic-ratelimit-unified-reset'
const ANTHROPIC_RESET_CAP_MS = 300_000

// Structured status fields a provider error / wire event may carry. A value is
// accepted only when it is a real numeric HTTP status; string codes
// ('server_error', 'forbidden', ...) and free text are ignored, so nothing is
// ever synthesized from a message.
const TYPED_STATUS_KEYS = ['httpStatus', 'http_status', 'status', 'statusCode', 'status_code', 'code']

/**
 * Read the first TYPED HTTP status carried by any of `sources` (error object,
 * wire event, event.response.error payload, ...). Returns 0 when none of them
 * declares one. Never inspects message text.
 */
export function typedStatusFrom(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue
    for (const key of TYPED_STATUS_KEYS) {
      const n = Number(source[key])
      if (Number.isFinite(n) && n >= 100 && n <= 599) return Math.floor(n)
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
  // Canonical stream-outcome contract owns replay safety: exposed
  // text/reasoning or a dispatched/ambiguous complete tool call makes
  // re-issuing the same turn unsafe (double side effect / output
  // concatenation) → 'permanent'. Everything else stays classifiable by the
  // typed rules below; an unknown/untyped failure ends as 'unknown', never a
  // blanket retry.
  if (readStreamOutcome(err).replayUnsafe === true) return 'permanent'
  // Cancellation is a caller decision, never a transport symptom. Anthropic's
  // APIUserAbortError inherits Error without overriding `name`, so recognize
  // only exact SDK constructor/type markers (plus standard AbortError markers)
  // across the bounded chain before considering stale connection causes.
  const chain = boundedCauseChain(err)
  if (chain.some(isExplicitUserAbortError)) return 'permanent'

  // Current typed HTTP status outranks stale stream/connection annotations.
  const status = Number(err.httpStatus || err.status || err.response?.status || 0) || 0
  if (AUTH_STATUSES.has(status)) return 'auth'
  // Stale previous_response_id is recoverable by dropping the chain and
  // re-issuing a full frame, which is the retryable path. A typed
  // 400 here is not a deterministic payload refusal.
  if (shouldDropPreviousResponseId(err)) return 'transient'
  if (typedErrorCode(err) === WEBSOCKET_CONNECTION_LIMIT) return 'transient'
  if (status === 429) return 'permanent'
  if (PERMANENT_STATUSES.has(status)
    || (status >= 400 && status < 500 && !TRANSIENT_STATUSES.has(status))) return 'permanent'
  // Truncated SSE stream (message_start without message_stop). These are
  // idempotent to retry: the partial result is discarded, and a pendingToolUse
  // means the tool_use input JSON never completed, so re-requesting is safe.
  // A current permanent/auth status and cancellation were checked above.
  if (err.truncatedStream === true || err.code === 'TRUNCATED_STREAM') return 'transient'

  if (TERMINAL_EDGE_STATUSES.has(status)) return 'permanent'
  if (TRANSIENT_STATUSES.has(status) || (status >= 500 && status < 600)) return 'transient'
  // A stream that closed WITHOUT its terminal frame is a transport symptom,
  // not a model verdict: the socket carries no HTTP status and no Node errno,
  // so without this it classified as 'unknown' and no loop-level replay was
  // ever attempted (observed live: pooled WS retired by the server between
  // turns → close 1000 before response.created → the whole turn failed).
  // Reference behavior retries the same disconnect (codex `CodexErr::Stream`
  // is_retryable, and a stream fallback/retry applies); the exposure deny above
  // still fails closed for anything already relayed or dispatched.
  if (isNonTerminalStreamClose(err)) return 'transient'

  // Socket-level codes (Node errno) — DNS / reset / refused / timeout are all
  // transient: we can retry the same request and may succeed.
  if (chain.some((item) => TRANSIENT_ERROR_CODES.has(String(item?.code || '')))) return 'transient'
  // Anthropic/OpenAI SDK connection + timeout classes, plus undici timeout
  // names, may not carry a Node errno. Native fetch wraps errno in cause.code,
  // which the bounded chain check above already covers.
  if (chain.some((item) => TRANSIENT_SDK_NAMES.has(String(item?.name || '')))) return 'transient'
  if (isGeminiTransientRpc(err)) return 'transient'

  // Bare fetch transport failures carry NO status and NO errno; their only
  // signal is the runtime's message ('fetch failed' Node, 'Failed to fetch'
  // Chromium, "Couldn't fetch" / 'Load failed' WebKit-family gateways —
  // observed live: one such blip failed a turn whose retry succeeded 27s
  // later). Replay PERMISSION is still owned by the exposure contract; this
  // only lets the retry ladder treat the symptom as transport instead of
  // failing the turn outright.
  if (!status && chain.some((item) => BARE_FETCH_TRANSPORT_MESSAGE_RE.test(
    String(item?.message || '').trim(),
  ))) return 'transient'

  // Provider wire error event (`response.failed` / terminal `error` frame):
  // default-retry. Every response.failed whose typed code is not a
  // deterministic refusal is retryable (fatal codes are an explicit
  // allow-list), and server_error / server_is_overloaded count as retryable
  // too. Evidence stays
  // structural — the event's own typed code/type field — message text is
  // never parsed. Exposure precedence is preserved: the replayUnsafe gate at
  // the top of this function already returned 'permanent' for any stream
  // that relayed output or dispatched a tool call.
  {
    const wireKind = classifyWireErrorEvent(err)
    if (wireKind) return wireKind
  }

  return 'unknown'
}

const MAX_CAUSE_CHAIN_DEPTH = 8
const BARE_FETCH_TRANSPORT_MESSAGE_RE = /^(?:fetch failed|failed to fetch|couldn'?t fetch\.?|load failed|network error)$/i
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'EAI_NODATA', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE',
  'EPROVIDERTIMEOUT', 'EGEMINITIMEOUT', 'ESTREAMSTALL', 'EWSACQUIRETIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT', 'EPROTO',
  'UND_ERR_DESTROYED', 'UND_ERR_CLOSED',
  'ECONNABORTED', 'ENETRESET', 'ERR_STREAM_DESTROYED',
  'ERR_HTTP2_STREAM_ERROR', 'ERR_HTTP2_SESSION_ERROR', 'ERR_HTTP2_INVALID_SESSION',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
])

// WebSocket close codes that can end a Responses stream BEFORE its terminal
// frame. 1000/1001/1005 are "nominal" closes the server sends when it retires
// a pooled socket; 1006/1011/1012 are abnormal/overload closes. None of them
// is a completed turn, and all are safe to re-issue when nothing was exposed.
// 4000 is our own local stall close and keeps the stall classification path.
const NON_TERMINAL_STREAM_CLOSE_CODES = new Set([1000, 1001, 1005, 1006, 1011, 1012])

/**
 * True when the error describes a stream socket that closed without the
 * provider's terminal frame (response.completed / message_stop). Replay
 * PERMISSION is still owned by the stream-outcome contract; this predicate
 * only answers "was this a transport-level disconnect".
 */
export function isNonTerminalStreamClose(err) {
  if (!err || typeof err !== 'object') return false
  const code = Number(err.wsCloseCode ?? err.streamCloseCode ?? 0) || 0
  if (!NON_TERMINAL_STREAM_CLOSE_CODES.has(code)) return false
  return readStreamOutcome(err).terminalObserved !== true
}

/**
 * Should this failed stream be re-issued as a NON-STREAMING request?
 *
 * A last safety net: when a stream dies, repeat the same request with
 * `stream:false` instead of failing the turn (gated off only when
 * streaming tool execution could double-run a tool). MixDog dispatches tools
 * eagerly, so this stays deliberately narrow: only a stream that
 * exposed NOTHING qualifies. An exposed stream is already covered by the
 * loop-level retraction replay (send-with-recovery), which asks the owner to
 * withdraw the rendered characters first.
 */
export function canFallbackNonStreaming(err, { signal } = {}) {
  if (!err || signal?.aborted) return false
  const outcome = readStreamOutcome(err)
  // A completed turn needs no fallback; a user cancel must never be re-issued.
  if (outcome.terminalObserved || outcome.userAbort) return false
  // Exposure/dispatch fails closed — re-running would duplicate output or a
  // side effect.
  if (outcome.replaySafe !== true) return false
  return classifyError(err) === 'transient'
    || outcome.stallObserved === true
    || outcome.truncatedStream === true
}

function boundedCauseChain(err) {
  const chain = []
  const seen = new Set()
  let cursor = err
  while (cursor && chain.length < MAX_CAUSE_CHAIN_DEPTH && !seen.has(cursor)) {
    chain.push(cursor)
    seen.add(cursor)
    cursor = cursor?.cause
  }
  return chain
}

function isExplicitUserAbortError(err) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return false
  if (err.name === 'AbortError' || err.name === 'APIUserAbortError' || err.code === 'ABORT_ERR') return true
  if (err.type === 'APIUserAbortError' || err.type === 'api_user_abort_error') return true
  try {
    return err.constructor?.name === 'APIUserAbortError'
  } catch {
    return false
  }
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
  const status = Number(err?.httpStatus || err?.status || err?.response?.status || 0) || 0
  if (status === 413) return true
  const code = typedErrorCode(err)
  if (code && CONTEXT_OVERFLOW_CODES.has(code)) return true
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
  if (retryAfter != null && retryAfter !== '') {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
    const dateMs = Date.parse(String(retryAfter))
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now())
  }
  // Google RPC RetryInfo encodes retryDelay as a protobuf Duration. Preserve
  // the same precedence as Retry-After: a server-provided retry window means
  // RESOURCE_EXHAUSTED is request-local, not a permanent quota refusal.
  const detailLists = [
    err?.details,
    err?.error?.details,
    err?.data?.error?.details,
  ]
  for (const details of detailLists) {
    if (!Array.isArray(details)) continue
    for (const detail of details) {
      const delay = detail?.retryDelay
      if (typeof delay === 'string') {
        const match = delay.trim().match(/^(\d+(?:\.\d+)?)s$/)
        if (match) return Math.ceil(Number(match[1]) * 1000)
      } else if (delay && typeof delay === 'object') {
        const seconds = Number(delay.seconds || 0)
        const nanos = Number(delay.nanos || 0)
        const ms = seconds * 1000 + nanos / 1_000_000
        if (Number.isFinite(ms) && ms >= 0) return Math.ceil(ms)
      }
    }
  }
  const resetHeader = _headerValue(headers, ANTHROPIC_RESET_HEADER)
  if (resetHeader != null && resetHeader !== '') {
    const resetUnixSec = Number(resetHeader)
    if (Number.isFinite(resetUnixSec) && resetUnixSec > 0) {
      const delayMs = Math.ceil(resetUnixSec * 1000 - Date.now())
      if (delayMs > 0) return Math.min(delayMs, ANTHROPIC_RESET_CAP_MS)
    }
  }
  // Codex parses the server-supplied window from a TYPED rate_limit_exceeded
  // payload. Message text never decides whether to retry — only how long to
  // wait after the typed code is already in hand. Headers / RetryInfo win.
  if (typedErrorCode(err) === RATE_LIMIT_EXCEEDED) {
    const delay = rateLimitRetryAfterMsFromMessage(err)
    if (delay != null) return delay
  }
  return null
}

function isPermanentQuotaError(err) {
  const status = Number(err?.httpStatus || err?.status || err?.response?.status || 0) || 0
  // Gemini uses RESOURCE_EXHAUSTED for both daily quota and per-minute
  // rate limits. A 429 is request-local (Google/LiteLLM retry); without a
  // 429 the same code stays a deterministic quota refusal.
  const permanentCodes = new Set(['insufficient_quota', 'quota_exceeded'])
  if (status !== 429) permanentCodes.add('resource_exhausted')
  for (const item of boundedCauseChain(err)) {
    const codes = [item?.code, item?.error?.code]
    if (codes.some((code) => permanentCodes.has(String(code || '').toLowerCase()))) return true
  }
  return false
}

// ── Wire error events: default-retry with a fatal-code deny-list ────────────
// Deterministic refusal codes a `response.failed` / `error` wire event may
// carry: retrying the identical request can never succeed. The fatal set is
// context/quota/policy plus the auth/billing refusals the
// Responses and Anthropic wire formats use. Everything OUTSIDE this set —
// server_error, server_is_overloaded, slow_down, or an event with no code at
// all — is a server-side fault and is retried under the bounded budgets
// (observed live 2026-08-11: two turns failed on typed `server_error`
// response.failed events that every reference implementation retries).
const WIRE_ERROR_FATAL_CODES = new Set([
  'context_length_exceeded', 'context_window_exceeded',
  'insufficient_quota', 'quota_exceeded', 'resource_exhausted',
  'usage_not_included', 'usage_limit_reached',
  'invalid_prompt', 'bio_policy', 'cyber_policy',
  'invalid_request', 'invalid_request_error',
  'invalid_api_key', 'authentication_error', 'permission_error',
  'permission_denied', 'billing_not_active',
])

function wireErrorCode(err) {
  const failed = err?.responseFailed
  const detail = failed?.response?.error || failed?.error || err?.providerError || failed || null
  for (const field of [detail?.code, detail?.type, err?.providerErrorCode, err?.code, err?.error?.code]) {
    if (typeof field === 'string' && field.trim()) return field.trim().toLowerCase()
  }
  return ''
}

function typedErrorCode(err) {
  return wireErrorCode(err)
}

/**
 * True when the typed wire/SDK code is previous_response_not_found.
 * Callers drop lastResponseId / previous_response_id and re-issue a full frame.
 */
export function shouldDropPreviousResponseId(err) {
  return typedErrorCode(err) === PREVIOUS_RESPONSE_NOT_FOUND
}

function isGeminiTransientRpc(err) {
  for (const item of boundedCauseChain(err)) {
    for (const field of [item?.geminiStatus, item?.error?.status]) {
      if (typeof field !== 'string') continue
      const key = field.toUpperCase()
      if (GEMINI_TRANSIENT_RPC_CODES.has(key) || key === 'RESOURCE_EXHAUSTED') return true
    }
    if (typeof item?.status === 'string') {
      const key = item.status.toUpperCase()
      if (GEMINI_TRANSIENT_RPC_CODES.has(key)) return true
    }
    const code = item?.code
    if (typeof code === 'string' && GEMINI_TRANSIENT_RPC_CODES.has(code.toUpperCase())) return true
  }
  return false
}

function isStaleKeepAliveError(err) {
  return boundedCauseChain(err).some((item) => {
    const code = String(item?.code || '')
    return code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET'
  })
}

const RATE_LIMIT_RETRY_AFTER_RE = /try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)\b/i

function rateLimitRetryAfterMsFromMessage(err) {
  const failed = err?.responseFailed
  const detail = failed?.response?.error || failed?.error || err?.providerError || err?.error || null
  const messages = [detail?.message, err?.message]
  for (const message of messages) {
    if (typeof message !== 'string' || !message) continue
    const match = message.match(RATE_LIMIT_RETRY_AFTER_RE)
    if (!match) continue
    const value = Number(match[1])
    if (!Number.isFinite(value) || value < 0) continue
    const unit = String(match[2] || '').toLowerCase()
    return unit === 'ms' ? Math.ceil(value) : Math.ceil(value * 1000)
  }
  return null
}

// 'transient' | 'permanent' for errors born from a provider wire error event;
// null for everything else (no blanket retry for untyped local failures).
function classifyWireErrorEvent(err) {
  if (!err || (err.responseFailed == null && err.providerWireError !== true)) return null
  const code = wireErrorCode(err)
  if (code && WIRE_ERROR_FATAL_CODES.has(code)) return 'permanent'
  return 'transient'
}

/**
 * True when `err` came from a provider wire error event whose typed code is
 * not a deterministic refusal — i.e. the send-with-recovery loop may replay
 * it (after text retraction when something was exposed). classifyError()
 * reports 'permanent' the moment output was exposed, so the loop names this
 * symptom directly, exactly like stall/truncated/non-terminal-close.
 */
 export function isRetryableWireErrorEvent(err) {
  return classifyWireErrorEvent(err) === 'transient'
 }

 /**
 * Grok Build StreamError: a mid-stream wire fault is retryable even when the
 * envelope type is invalid_request_error, unless a typed 4xx status or a
 * deterministic refusal code (quota/context/auth) is present.
 */
 export function isRetryableStreamErrorEvent(err) {
  if (classifyWireErrorEvent(err) === 'transient') return true
  if (!err || err.providerWireError !== true) return false
  const status = Number(err.httpStatus || err.status || err.response?.status || 0) || 0
  if (status && status >= 400 && status < 500 && !TRANSIENT_STATUSES.has(status)) return false
  const code = wireErrorCode(err)
  if (code && WIRE_ERROR_FATAL_CODES.has(code)
    && code !== 'invalid_request' && code !== 'invalid_request_error') {
    return false
  }
  return true
 }

 /**
 * Convenience predicate: should this error be retried at the request level?
 * Wraps classifyError() with the standard "transient = retry, otherwise no"
 * policy. Callers that have provider-specific retry budgets (e.g. anthropic-
 * oauth's MAX_ATTEMPTS, openai-oauth-ws's mid-stream classifier) still gate
 * on attempt count separately; this helper only answers the kind question.
 */
 function isRetryable(err) {
  return classifyError(err) === 'transient'
}

/** Anthropic request budget: 10 retries (11 attempts).
 * CLAUDE_CODE_MAX_RETRIES is intentionally read per request for reload/tests.
 * The upper bound prevents an accidental unbounded retry loop. */
export function anthropicMaxAttempts() {
  const raw = process.env.CLAUDE_CODE_MAX_RETRIES
  const parsed = raw == null || raw === '' ? 10 : Number.parseInt(raw, 10)
  const retries = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 100) : 10
  return retries + 1
}

// Anthropic retry defaults: 500ms exponential backoff,
// capped at 32s, with positive-only jitter up to 25% of the base delay.
// The leading duplicate accounts for the sleep-before-attempt index:
// retry attempt 2 reads index 1.
export const ANTHROPIC_RETRY_BACKOFF_MS = Object.freeze([
  500, 500, 1000, 2000, 4000, 8000, 16000, 32000, 32000, 32000, 32000,
])
export const ANTHROPIC_RETRY_JITTER_RATIO = 0.25

// The Anthropic SDK client defaults API_TIMEOUT_MS to ten minutes.
// Read per request, like CLAUDE_CODE_MAX_RETRIES, so env reload/tests work.
export function anthropicRequestTimeoutMs() {
  const parsed = Number.parseInt(process.env.API_TIMEOUT_MS || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000
}

const ANTHROPIC_MAX_CONSECUTIVE_529 = 3

export class AnthropicFallbackTriggeredError extends Error {
  constructor(originalModel, fallbackModel, cause) {
    super(`Anthropic model fallback triggered: ${originalModel} -> ${fallbackModel}`, { cause })
    this.name = 'AnthropicFallbackTriggeredError'
    this.originalModel = originalModel
    this.fallbackModel = fallbackModel
  }
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

// ── Stall-retry wall-clock budget (send-scoped) ──────────────────────────────
// Mid-stream 'stream_stalled' recoveries retry in place, which is right for a
// one-off blip but lets a chronically dying stream burn a whole task budget
// slowly (observed live: one send stretched 149s→298s→556s across stall
// retries before the agent deadline killed the task). A stalling stream is
// bounded instead of retried forever: a request is capped at ~300s wall
// clock (API_TIMEOUT_MS) and a stream dies after one 300s silent gap
// (stream idle timeout). This guard is the equivalent for our in-place
// recovery: the clock starts at the FIRST stall of a send, and stall-classified
// retries are allowed only inside that window; past it the stall error
// surfaces so loop-level transport retry issues a FRESH request. Healthy
// streams never consult the clock (no stall → no budget reads), so long
// thinking/output can never trip it.
export const STREAM_STALL_RETRY_BUDGET_MS = (() => {
  const v = Number(process.env.MIXDOG_STREAM_STALL_BUDGET_MS)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 300_000
})()

// One instance per provider send() call (NOT per attempt — the whole point is
// bounding the cross-attempt stall window). `now` is injectable for tests.
export function createStallRetryBudget(budgetMs = STREAM_STALL_RETRY_BUDGET_MS, now = Date.now) {
  let firstStallAt = 0
  return {
    // Record a stall-classified retry candidate. Returns true while the
    // send's stall window still has budget; false once exhausted (the caller
    // surfaces the error instead of retrying in place).
    allowStallRetry() {
      const t = now()
      if (!firstStallAt) firstStallAt = t
      return (t - firstStallAt) <= budgetMs
    },
    get firstStallAt() { return firstStallAt },
  }
}

// One recovery window must span every layer of the same logical send:
// provider-local stream recovery, streaming→non-streaming fallback, and the
// loop-level fresh-request replay. Callers pass the same opts object through
// those layers; keep the budget there instead of silently resetting it.
export function resolveStallRetryBudget(opts) {
  const existing = opts?._stallRetryBudget
  if (existing && typeof existing.allowStallRetry === 'function') return existing
  const budget = createStallRetryBudget()
  if (opts && typeof opts === 'object') {
    try { opts._stallRetryBudget = budget } catch {}
  }
  return budget
}

// A loop-level replay issues a BRAND NEW request, so it opens a new stall
// window instead of inheriting the spent one. Sharing it made the two 300s
// numbers cancel out: one full-length stall consumes the whole budget, and the
// replacement request is then aborted while its response is already arriving
// (observed live: regex-chess died on a healthy HTTP 200 replay with two hours
// of task budget left). Total exposure stays bounded by TRANSPORT_RETRY_MAX.
export function resetStallRetryBudget(opts) {
  const budget = createStallRetryBudget()
  if (opts && typeof opts === 'object') {
    try { opts._stallRetryBudget = budget } catch {}
  }
  return budget
}

// ── Shared network-resilience interface ──────────────────────────────────────
// One home for the logic shared across providers: mid-stream classifier
// (WS + SSE), transport fallback predicate, stream-safety stamp latches,
// abort-aware sleep, handshake classifier, and the retry-budget table.
// Provider differences are passed as ARGUMENTS (policy objects), never
// branched on a hardcoded provider name.

// F) Retry-budget profiles as DATA. The numbers live ONLY here now.
//    ws.*Retries (5)              — one Responses stream retry budget.
//    sse.defaultRetries (3)       — anthropic single-shot SSE mid-stream budget.
export const MIDSTREAM_RETRY_POLICY = {
  ws: { transientCloseRetries: 5, defaultRetries: 5, backoff: [250, 1000, 2000, 4000, 5000] },
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

// WebSocket classification consumes the provider's stream-state signals.
function _classifyMidstreamWs(err, state, attemptIndex, policy) {
  // Terminal + replay gate. A mid-stream retry re-issues the turn, so it is
  // denied once visible output was relayed or a tool call was dispatched
  // (including a nominal close-1000 before response.completed: the tool may be
  // executing). Everything below is the typed transient classification.
  const outcome = readStreamOutcome(err, state)
  if (outcome.terminalObserved) return null
  if (outcome.replaySafe !== true) return null
  if (err?.wsFrameTooLarge || state.wsFrameTooLarge) {
    return _allowMidstream('ws_frame_too_large', attemptIndex, policy)
  }
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
      // A stall after any exposure was already denied by the outcome gate.
      return _allowMidstream('stream_stalled', attemptIndex, policy)
    }
    if (closeCode === 4000) return _allowMidstream('ws_4000', attemptIndex, policy)
  }
  if (!state.sawResponseCreated) {
    const closeCode = Number(err?.wsCloseCode || state.wsCloseCode || 0)
    // A close before response.created has not produced any response bytes to
    // the caller, so it is safe to reconnect and replay under the bounded
    // retry policy (text/tool emission was denied above before this gate).
    // NOMINAL closes count too: a pooled socket the server retires between
    // turns closes with 1000/1001/1005 and must reconnect fresh — treating
    // that as terminal killed the turn instead of reissuing it.
    if (!NON_TERMINAL_STREAM_CLOSE_CODES.has(closeCode)) return null
  }
  if (state.userAbort) return null

  if (!err) return null
  const status = Number(err?.httpStatus || 0)
  if (status === 401 || status === 403 || status === 429) return null
  if (status >= 500 && status < 600) {
    if (TERMINAL_EDGE_STATUSES.has(status)) return null
    return _allowMidstream(`http_${status}`, attemptIndex, policy)
  }

  const name = err?.name || ''
  if (name === 'AgentStallAbortError') return _allowMidstream('agent_stall', attemptIndex, policy)
  if (name === 'StreamStalledAbortError' || name === 'StreamStalledError' || err?.code === 'ESTREAMSTALL' || err?.streamStalled === true) {
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
  // Nominal close without the terminal frame — before OR after
  // response.created. Only a completed turn is terminal here.
  if ((closeCode === 1000 || closeCode === 1001 || closeCode === 1005) && !state.sawCompleted) {
    return _allowMidstream(`ws_${closeCode}`, attemptIndex, policy)
  }

  const failed = err?.responseFailed || state.responseFailedPayload
  if (failed) {
    // STRUCTURED evidence only: the failure's own numeric status and its
    // explicit error code/type field. The payload is never stringified and
    // searched — a message/body that merely CONTAINS "network_error" or
    // "stream_disconnected" never selects a SPECIFIC bucket. Buckets need
    // typed codes; the DEFAULT for an unrecognized (or absent) code is the
    // bounded retry below, with fatal refusal codes staying terminal.
    const detail = failed?.response?.error || failed?.error || failed
    const failedStatus = typedStatusFrom(detail, failed?.response, failed)
    if (failedStatus >= 500 && failedStatus < 600) {
      if (TERMINAL_EDGE_STATUSES.has(failedStatus)) return null
      return _allowMidstream(`http_${failedStatus}`, attemptIndex, policy)
    }
    for (const field of [detail?.code, detail?.type]) {
      const key = typeof field === 'string' ? field.trim().toLowerCase() : ''
      const classifier = RESPONSE_FAILED_CODE_CLASSIFIERS.get(key)
      if (classifier) return _allowMidstream(classifier, attemptIndex, policy)
      if (key && WIRE_ERROR_FATAL_CODES.has(key)) return null
    }
    // A typed non-transient 4xx on the failure payload is a deterministic
    // refusal even without a recognized code string.
    if (failedStatus >= 400 && failedStatus < 500 && !TRANSIENT_STATUSES.has(failedStatus)) return null
    // Default-retry: a wire failure that is neither a fatal
    // refusal nor a typed 4xx is a server-side fault — re-issue it under the
    // bounded mid-stream budget instead of failing the turn.
    return _allowMidstream('response_failed_retryable', attemptIndex, policy)
  }

  return null
}

// Explicit `response.failed` error codes/types that describe a transport-level
// interruption (these are retryable); every other code is terminal.
const RESPONSE_FAILED_CODE_CLASSIFIERS = new Map([
  ['stream_disconnected', 'response_failed_disconnected'],
  ['network_error', 'response_failed_network'],
  ['auth_context_expired', 'response_failed_auth_expired'],
  ['auth_expired', 'response_failed_auth_expired'],
  ['previous_response_not_found', 'previous_response_not_found'],
  ['websocket_connection_limit_reached', 'websocket_connection_limit'],
])

// SSE classification consumes the provider's stream-state signals.
function _classifyMidstreamSse(err, state, attemptIndex, policy) {
  if (attemptIndex >= policy.defaultRetries) return null
  const outcome = readStreamOutcome(err, state)
  if (outcome.terminalObserved) return null
  if (state.userAbort) return null
  if (outcome.replaySafe !== true) return null

  if (!err) return null
  const status = Number(err?.httpStatus || err?.status || err?.response?.status || 0)
  if (status === 401 || status === 403) return null
  if (status === 429) return 'http_429'
  if (status >= 500 && status < 600) {
    if (TERMINAL_EDGE_STATUSES.has(status)) return null
    return `http_${status}`
  }

  const name = err?.name || ''
  if (name === 'AgentStallAbortError') return 'agent_stall'
  if (name === 'StreamStalledAbortError' || name === 'StreamStalledError' || err?.code === 'ESTREAMSTALL' || err?.streamStalled === true) {
    return 'stream_stalled'
  }
  if (state.watchdogAbort === 'AgentStallAbortError') return 'agent_stall'
  if (state.watchdogAbort === 'StreamStalledAbortError') return 'stream_stalled'

  const code = err?.code || err?.cause?.code || ''
  if (code === 'ECONNRESET') return 'reset'
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA') return 'dns'

  if (classifyError(err) === 'transient') return 'connection'

  return null
}

// B) Unified transport (WS→HTTP) fallback predicate. Identical deny-order +
//    allow-list to the two former copies; `enabled` replaces the per-provider
//    env-flag check (caller computes the flag and passes it).
const TRANSPORT_FALLBACK_CLASSIFIERS = new Set([
  'timeout', 'reset', 'dns', 'refused', 'network', 'acquire_timeout', 'http_5xx',
  'first_byte_timeout',
  'ws_1006', 'ws_1011', 'ws_1012', 'ws_1000', 'ws_1001', 'ws_1005', 'ws_4000',
  'agent_stall', 'stream_stalled',
  'response_failed_disconnected', 'response_failed_network', 'response_failed_auth_expired',
  'ws_send_failed',
])
const TRANSPORT_FALLBACK_ERRNO = new Set([
  'EWSACQUIRETIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'EAI_AGAIN',
  'ENOTFOUND', 'EAI_NODATA', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT', 'EPROTO',
  'UND_ERR_DESTROYED', 'UND_ERR_CLOSED',
  'ECONNABORTED', 'ENETRESET', 'ERR_STREAM_DESTROYED',
  'ERR_HTTP2_STREAM_ERROR', 'ERR_HTTP2_SESSION_ERROR', 'ERR_HTTP2_INVALID_SESSION',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
])

export function shouldFallbackTransport(err, { signal, enabled = true } = {}) {
  if (!enabled) return false
  if (signal?.aborted) return false
  // Transport fallback re-issues the request on another transport: it is a
  // replay, so the exposure deny applies. Eligibility itself stays typed
  // (status / errno / classifier) for the WS→HTTPS switch.
  if (readStreamOutcome(err).replaySafe !== true) return false
  const status = Number(err?.httpStatus || err?.status || 0)
  // 401 is auth recovery, never transport fallback. 426 is the explicit
  // immediate WS→HTTPS switch; every other status must be TYPED transient
  // (408/409/5xx) — an arbitrary nonzero status is not fallback evidence.
  if (status === 401) return false
  if (status === 426) return true
  if (TERMINAL_EDGE_STATUSES.has(status)) return false
  if (TRANSIENT_STATUSES.has(status) || (status >= 500 && status < 600)) return true
  if (status > 0) return false
  const code = String(err?.code || '')
  if (TRANSPORT_FALLBACK_ERRNO.has(code)) return true
  const classifier = String(err?.retryClassifier || err?.midstreamClassifier || '')
  if (TRANSPORT_FALLBACK_CLASSIFIERS.has(classifier)) return true
  if (/^http_5\d\d$/.test(classifier)) return true
  if (err?.firstByteTimeout) return true
  return false
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
export const MAX_SAFE_TIMEOUT_MS = 2_147_483_647

// D) Abort-aware sleep (single copy). Resolves after `ms`, or rejects with the
//    signal's reason (or `abortMessage`) the moment the signal aborts. `sleepFn`
//    is injectable for deterministic tests. Oversized deadlines are chunked so
//    Node never clamps setTimeout(>2^31-1) to approximately 1ms.
export async function sleepWithAbort(ms, signal, sleepFn = _defaultAbortSleep, abortMessage = 'sleep aborted') {
  let remaining = Math.max(0, Number(ms) || 0)
  const sleeper = sleepFn || _defaultAbortSleep
  while (remaining > 0) {
    if (signal?.aborted) {
      const reason = signal.reason
      throw reason instanceof Error ? reason : new Error(abortMessage)
    }
    const chunk = Math.min(remaining, MAX_SAFE_TIMEOUT_MS)
    await _sleepChunkWithAbort(chunk, signal, sleeper, abortMessage)
    remaining -= chunk
  }
}

function _sleepChunkWithAbort(ms, signal, sleepFn, abortMessage) {
  if (!signal) return Promise.resolve().then(() => sleepFn(ms))
  if (sleepFn === _defaultAbortSleep) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { signal.removeEventListener('abort', onAbort) } catch {}
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        const reason = signal.reason
        reject(reason instanceof Error ? reason : new Error(abortMessage))
      }
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      const reason = signal.reason
      reject(reason instanceof Error ? reason : new Error(abortMessage))
    }
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => sleepFn(ms))
      .then(() => {
        if (settled) return
        settled = true
        try { signal.removeEventListener('abort', onAbort) } catch {}
        resolve()
      }, (err) => {
        if (settled) return
        settled = true
        try { signal.removeEventListener('abort', onAbort) } catch {}
        reject(err)
      })
  })
}

// E) Handshake classifier (moved here from openai-oauth-ws). Default-deny:
//    anything not recognized as transient returns null. HTTP 401 is reserved
//    for auth recovery and 426 for immediate HTTPS fallback. The OpenAI OAuth
//    caller opts out of 429 retries (retry429:false); all other callers
//    retain the historical retryable UnexpectedStatus policy.
export function classifyHandshakeError(err, { retry429 = true } = {}) {
  if (!err) return null
  const code = err.code || ''
  const status = Number(err.httpStatus || 0)

  if (status === 401 || status === 426 || (status === 429 && !retry429)) return null
  if (status > 0) {
    // Typed transient handshake statuses only. A 403/404/4xx upgrade refusal
    // is a deterministic decision: spending the retry budget on it cannot
    // change the answer.
    if (status === 429 || TRANSIENT_STATUSES.has(status) || (status >= 500 && status < 600)) {
      if (TERMINAL_EDGE_STATUSES.has(status)) return null
      return `http_${status}`
    }
    return null
  }

  if (code === 'ECONNRESET') return 'reset'
  if (code === 'EAI_AGAIN' || code === 'ENOTFOUND' || code === 'EAI_NODATA') return 'dns'
  if (code === 'ECONNREFUSED') return 'refused'
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout'
  if (code === 'EWSACQUIRETIMEOUT') return 'acquire_timeout'
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'EPIPE') return 'network'
  if (TRANSIENT_ERROR_CODES.has(String(code))) {
    if (code === 'UND_ERR_SOCKET' || code === 'EPROTO') return 'network'
    if (code === 'UND_ERR_DESTROYED' || code === 'UND_ERR_CLOSED' || code === 'ERR_STREAM_DESTROYED') return 'reset'
    if (code === 'ECONNABORTED' || code === 'ENETRESET') return 'reset'
    if (String(code).startsWith('ERR_HTTP2_')) return 'reset'
    if (code === 'UND_ERR_CONNECT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout'
    if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') return 'timeout'
    if (code === 'ERR_SOCKET_CONNECTION_TIMEOUT') return 'timeout'
  }

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
 *   - Classification is typed-only: an error with no status/errno/SDK type is
 *     'unknown' and is surfaced immediately instead of being replayed.
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
  const retryJitterRatio = Number(opts.retryJitterRatio ?? PROVIDER_RETRY_JITTER_RATIO)
  const retryJitterMode = opts.retryJitterMode === 'positive' ? 'positive' : 'symmetric'
  const sleepFn = typeof opts.sleepFn === 'function' ? opts.sleepFn : undefined

  let lastErr = null
  let nextDelayMs = null
  let nextDelayReason = null
  let consecutive529Errors = Math.max(0, Number(opts.initialConsecutive529Errors) || 0)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      const reason = signal.reason
      throw reason instanceof Error ? reason : new Error('withRetry: aborted')
    }
    if (attempt > 0) {
      const rawWait = nextDelayMs ?? backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 0
      // Retry-After is a server-mandated minimum. Do not cap, shorten, or
      // jitter it; cancellation remains active throughout the full wait.
      const wait = nextDelayReason === 'retry-after'
        ? Math.max(0, rawWait)
        : jitterDelayMs(rawWait, retryJitterRatio, retryJitterMode)
      onRetry?.({ attempt, maxAttempts, lastErr, delayMs: wait, delayReason: nextDelayReason })
      if (wait > 0) await sleepWithAbort(wait, signal, sleepFn, 'withRetry: sleep aborted')
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
      const status = Number(caught?.httpStatus || caught?.status || caught?.response?.status || 0)
      const kind = classifyError(caught)
      // Hard replay boundary: a retry RE-ISSUES the request, so it is denied
      // once visible output was relayed or a tool call was dispatched. Whether
      // an eligible failure is actually retried remains the typed question
      // resolved by classifyError()/status below.
      if (readStreamOutcome(caught).replaySafe !== true) throw caught
      if (isStaleKeepAliveError(caught)) {
        try { recycleLlmDispatcher() } catch { /* never let pool recycle break retry */ }
      }
      // Grok rebuilds the HTTP client on the first 5xx to escape a poisoned
      // HTTP/2 keep-alive pool (CF 522/523/524 included). 525/526 stay fatal.
      else if (status >= 500 && status < 600 && !TERMINAL_EDGE_STATUSES.has(status)) {
        try { recycleLlmDispatcher() } catch { /* never let pool recycle break retry */ }
      }
      // x-should-retry:false is an explicit server veto on retrying and is
      // honored as-is.
      // Keep this ahead of status defaults, including the request-local 429 path.
      const shouldRetryHeader = _headerValue(
        caught?.headers || caught?.response?.headers || caught?.data?.responseHeaders,
        'x-should-retry',
      )
      if (String(shouldRetryHeader || '').toLowerCase() === 'false') throw caught
      // Anthropic's non-standard positive override outranks ordinary status
      // classification. Keep subscription OAuth 429 fail-fast ownership:
      // retry429:false is the Max/Pro gate and must not wait for that window.
      if (opts.provider === 'anthropic'
        && String(shouldRetryHeader || '').toLowerCase() === 'true'
        && !(status === 429 && opts.retry429 === false)) {
        if (attempt === maxAttempts - 1) throw caught
        const retryAfterMs = retryAfterMsFromError(caught)
        if (retryAfterMs != null) {
          nextDelayMs = Math.max(0, retryAfterMs)
          nextDelayReason = 'retry-after'
        }
        continue
      }
      // The optional model fallback fires on the third 529. This
      // remains opt-in: providers pass fallbackModel only when the caller set
      // one. The hard progress veto above must run first so fallback can never
      // replay partial thinking/tool output.
      if (status === 529 && opts.fallbackModel && opts.fallbackModel !== opts.model) {
        consecutive529Errors += 1
        if (consecutive529Errors >= ANTHROPIC_MAX_CONSECUTIVE_529) {
          throw new AnthropicFallbackTriggeredError(opts.model, opts.fallbackModel, caught)
        }
      }
      if (status === 429) {
        if (opts.retry429 === false) throw caught
        const ra = retryAfterMsFromError(caught)
        // A deterministic quota refusal cannot recover by replaying the same
        // request. An explicit server retry window outranks message-text quota
        // heuristics: RESOURCE_EXHAUSTED + Retry-After/RetryInfo is transient.
        if (ra == null && isPermanentQuotaError(caught)) throw caught
        // Retry only this request. Admission concurrency is fixed and is never
        // reduced by rate limits. Respect Retry-After when present; otherwise
        // use the ordinary jittered backoff. Output/tool stamps above remain a
        // hard replay boundary.
        if (attempt === maxAttempts - 1) throw caught
        if (ra != null) {
          nextDelayMs = Math.max(0, ra)
          nextDelayReason = 'retry-after'
        }
        continue
      }
      if (kind !== 'transient') throw caught
      // Last attempt failed transiently — propagate to caller.
      if (attempt === maxAttempts - 1) throw caught
      const retryAfterMs = retryAfterMsFromError(caught)
      if (retryAfterMs != null) {
        nextDelayMs = Math.max(0, retryAfterMs)
        nextDelayReason = 'retry-after'
      }
    } finally {
      attemptTimeout?.cleanup()
    }
  }
  // Defensive — loop above always returns or throws.
  throw lastErr || new Error('withRetry: exhausted with no error captured')
}