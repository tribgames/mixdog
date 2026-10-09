// Structural error classification: typed status, transience, auth, context
// overflow, retry-after and stream-close verdicts shared by every provider.
import { readStreamOutcome } from './lib/stream-outcome.mjs';

// HTTP statuses considered transient — safe to retry with backoff.
//   408 — request timeout
//   500/502/503/504 — server errors (overload / bad gateway / timeout)
//   429 is handled separately by withRetry(): only the affected request waits
//   with jitter; provider/account admission concurrency remains fixed.
export const TRANSIENT_STATUSES = new Set([408, 409, 425]);

// HTTP statuses that mean "permanent: stop retrying, surface to caller".
//   401/403 — auth issue
//   404 — not found
//   400/422 — bad request (deterministic)
const AUTH_STATUSES = new Set([401, 403]);
const PERMANENT_STATUSES = new Set([400, 404, 405, 410, 415, 422]);
// Cloudflare origin-TLS pages never clear on retry (grok-build edge_client).
export const TERMINAL_EDGE_STATUSES = new Set([525, 526]);
const GEMINI_TRANSIENT_RPC_CODES = new Set(['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'ABORTED', 'INTERNAL']);
const PREVIOUS_RESPONSE_NOT_FOUND = 'previous_response_not_found';
export const WEBSOCKET_CONNECTION_LIMIT = 'websocket_connection_limit_reached';
const RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded';
const CONTEXT_OVERFLOW_CODES = new Set(['context_length_exceeded', 'context_window_exceeded', 'request_too_large']);
const TRANSIENT_SDK_NAMES = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
]);
const ANTHROPIC_RESET_HEADER = 'anthropic-ratelimit-unified-reset';
const ANTHROPIC_RESET_CAP_MS = 300_000;

// Structured status fields a provider error / wire event may carry. A value is
// accepted only when it is a real numeric HTTP status; string codes
// ('server_error', 'forbidden', ...) and free text are ignored, so nothing is
// ever synthesized from a message.
const TYPED_STATUS_KEYS = ['httpStatus', 'http_status', 'status', 'statusCode', 'status_code', 'code'];

/**
 * Read the first TYPED HTTP status carried by any of `sources` (error object,
 * wire event, event.response.error payload, ...). Returns 0 when none of them
 * declares one. Never inspects message text.
 */
export function typedStatusFrom(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of TYPED_STATUS_KEYS) {
      const n = Number(source[key]);
      if (Number.isFinite(n) && n >= 100 && n <= 599) return Math.floor(n);
    }
  }
  return 0;
}

/** The typed HTTP status an error carries in any of its usual spots; 0 when none. */
const statusOfError = (err) => Number(err?.httpStatus || err?.status || err?.response?.status || 0) || 0;

// The verdict a typed HTTP status (or a typed stream shape) gives, in
// precedence order; null when the status decides nothing.
function classifyByStatus(err, status) {
  if (AUTH_STATUSES.has(status)) return 'auth';
  // Stale previous_response_id is recoverable by dropping the chain and
  // re-issuing a full frame, which is the retryable path. A typed
  // 400 here is not a deterministic payload refusal.
  if (shouldDropPreviousResponseId(err)) return 'transient';
  if (typedErrorCode(err) === WEBSOCKET_CONNECTION_LIMIT) return 'transient';
  if (status === 429) return 'permanent';
  if (PERMANENT_STATUSES.has(status) || (status >= 400 && status < 500 && !TRANSIENT_STATUSES.has(status)))
    return 'permanent';
  // Truncated SSE stream (message_start without message_stop). These are
  // idempotent to retry: the partial result is discarded, and a pendingToolUse
  // means the tool_use input JSON never completed, so re-requesting is safe.
  // A current permanent/auth status and cancellation were checked above.
  if (err.truncatedStream === true || err.code === 'TRUNCATED_STREAM') return 'transient';
  if (TERMINAL_EDGE_STATUSES.has(status)) return 'permanent';
  if (TRANSIENT_STATUSES.has(status) || (status >= 500 && status < 600)) return 'transient';
  return null;
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
  if (!err) return 'unknown';
  // Canonical stream-outcome contract owns replay safety: exposed
  // text/reasoning or a dispatched/ambiguous complete tool call makes
  // re-issuing the same turn unsafe (double side effect / output
  // concatenation) → 'permanent'. Everything else stays classifiable by the
  // typed rules below; an unknown/untyped failure ends as 'unknown', never a
  // blanket retry.
  if (readStreamOutcome(err).replayUnsafe === true) return 'permanent';
  // Cancellation is a caller decision, never a transport symptom. Anthropic's
  // APIUserAbortError inherits Error without overriding `name`, so recognize
  // only exact SDK constructor/type markers (plus standard AbortError markers)
  // across the bounded chain before considering stale connection causes.
  const chain = boundedCauseChain(err);
  if (chain.some(isExplicitUserAbortError)) return 'permanent';
  // Current typed HTTP status outranks stale stream/connection annotations.
  const status = statusOfError(err);
  return classifyByStatus(err, status) || classifyByTransport(err, chain, status) || 'unknown';
}

// A turn that ended on a malformed or unexpected tool call produced no usable
// call at all (the typed finish reason says so); the reference client re-asks
// the same request, bounded, instead of failing the turn.
const INVALID_TOOL_CALL_FINISH_REASONS = new Set(['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL']);

function isInvalidToolCallFinish(err) {
  if (err?.providerIncomplete !== true) return false;
  const reason = String(err.finishReason || '')
    .replace(/^FINISH_REASON_/, '')
    .toUpperCase();
  if (!INVALID_TOOL_CALL_FINISH_REASONS.has(reason)) return false;
  return !(Array.isArray(err.partialToolCalls) && err.partialToolCalls.length > 0);
}

// Transport symptoms, consulted only once no status verdict applied.
function classifyByTransport(err, chain, status) {
  if (isInvalidToolCallFinish(err)) return 'transient';
  // A stream that closed WITHOUT its terminal frame is a transport symptom,
  // not a model verdict: the socket carries no HTTP status and no Node errno,
  // so without this it classified as 'unknown' and no loop-level replay was
  // ever attempted (observed live: pooled WS retired by the server between
  // turns → close 1000 before response.created → the whole turn failed).
  // Reference behavior retries the same disconnect (codex `CodexErr::Stream`
  // is_retryable, and a stream fallback/retry applies); the exposure deny above
  // still fails closed for anything already relayed or dispatched.
  if (isNonTerminalStreamClose(err)) return 'transient';

  // Cursor's resumed tool-result stream cannot safely reopen the same wire
  // request. Let the outer loop rebuild a fresh request from committed history.
  if (isCursorTransientTransportError(err)) return 'transient';

  // Socket-level codes (Node errno) — DNS / reset / refused / timeout are all
  // transient: we can retry the same request and may succeed.
  if (chain.some((item) => isTransientErrorCode(item?.code))) return 'transient';
  // Anthropic/OpenAI SDK connection + timeout classes, plus undici timeout
  // names, may not carry a Node errno. Native fetch wraps errno in cause.code,
  // which the bounded chain check above already covers.
  if (chain.some((item) => TRANSIENT_SDK_NAMES.has(String(item?.name || '')))) return 'transient';
  if (isGeminiTransientRpc(err)) return 'transient';

  // Bare fetch transport failures carry NO status and NO errno; their only
  // signal is the runtime's message ('fetch failed' Node, 'Failed to fetch'
  // Chromium, "Couldn't fetch" / 'Load failed' WebKit-family gateways —
  // observed live: one such blip failed a turn whose retry succeeded 27s
  // later). Replay PERMISSION is still owned by the exposure contract; this
  // only lets the retry ladder treat the symptom as transport instead of
  // failing the turn outright.
  if (!status && chain.some((item) => BARE_FETCH_TRANSPORT_MESSAGE_RE.test(String(item?.message || '').trim())))
    return 'transient';

  // Provider wire error event (`response.failed` / terminal `error` frame):
  // default-retry. Every response.failed whose typed code is not a
  // deterministic refusal is retryable (fatal codes are an explicit
  // allow-list), and server_error / server_is_overloaded count as retryable
  // too. Evidence stays
  // structural — the event's own typed code/type field — message text is
  // never parsed. Exposure precedence is preserved: the replayUnsafe gate at
  // the top of this function already returned 'permanent' for any stream
  // that relayed output or dispatched a tool call.
  return classifyWireErrorEvent(err) || null;
}

const MAX_CAUSE_CHAIN_DEPTH = 8;
// 'terminated' / 'other side closed' / 'socket hang up' are the body-read
// forms of the same disconnect (undici aborts the response body when the peer
// closes mid-stream and may not attach a cause).
const BARE_FETCH_TRANSPORT_MESSAGE_RE =
  /^(?:fetch failed|failed to fetch|couldn'?t fetch\.?|load failed|network error|terminated|other side closed|socket hang up)$/i;
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EAI_NODATA',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'EPROVIDERTIMEOUT',
  'EGEMINITIMEOUT',
  'ESTREAMSTALL',
  'EWSACQUIRETIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT',
  'EPROTO',
  'UND_ERR_DESTROYED',
  'UND_ERR_CLOSED',
  'ECONNABORTED',
  'ENETRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_HTTP2_STREAM_ERROR',
  'ERR_HTTP2_SESSION_ERROR',
  'ERR_HTTP2_INVALID_SESSION',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

// TLS record corruption on a flaky link or a meddling proxy. Node builds the
// ERR_SSL_* code from the OpenSSL reason string, which differs across OpenSSL
// versions (…SSLV3_ALERT_BAD_RECORD_MAC, …SSL/TLS_ALERT_BAD_RECORD_MAC,
// …DECRYPTION_FAILED_OR_BAD_RECORD_MAC), so the stable suffix names the class.
const TLS_RECORD_FAILURE_RE = /^ERR_SSL_[A-Z0-9_/]*BAD_RECORD_MAC$/i;

/** True for a socket/TLS errno that describes a transient transport fault. */
export function isTransientErrorCode(code) {
  const value = String(code || '');
  return TRANSIENT_ERROR_CODES.has(value) || TLS_RECORD_FAILURE_RE.test(value);
}

// Cursor's HTTP/2 bridge preserves provider-specific codes in `cursorCode`.
// These codes all describe an incomplete transport turn, not a model verdict.
// Replay permission remains fail-closed in the stream-outcome gate above.
const CURSOR_TRANSIENT_ERROR_CODES = new Set([
  'stream_aborted',
  'goaway',
  'connection_timeout',
  'stream_idle_timeout',
  'stream_park_timeout',
  'incomplete_stream',
]);

// WebSocket close codes that can end a Responses stream BEFORE its terminal
// frame. 1000/1001/1005 are "nominal" closes the server sends when it retires
// a pooled socket; 1006/1011/1012 are abnormal/overload closes. None of them
// is a completed turn, and all are safe to re-issue when nothing was exposed.
// 4000 is our own local stall close and keeps the stall classification path.
export const NON_TERMINAL_STREAM_CLOSE_CODES = new Set([1000, 1001, 1005, 1006, 1011, 1012]);

/**
 * True when the error describes a stream socket that closed without the
 * provider's terminal frame (response.completed / message_stop). Replay
 * PERMISSION is still owned by the stream-outcome contract; this predicate
 * only answers "was this a transport-level disconnect".
 */
export function isNonTerminalStreamClose(err) {
  if (!err || typeof err !== 'object') return false;
  const code = Number(err.wsCloseCode ?? err.streamCloseCode ?? 0) || 0;
  if (!NON_TERMINAL_STREAM_CLOSE_CODES.has(code)) return false;
  return readStreamOutcome(err).terminalObserved !== true;
}

// Network-outage class: the uplink itself failed (DNS, connect, reset, socket
// close, undici transport). Our own watchdog codes (stall, acquire/provider
// timeouts) are deliberately absent — those describe a LIVE connection that
// went quiet, which is a provider symptom, not a lost network.
const CONNECTION_FAILURE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EAI_NODATA',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'ECONNABORTED',
  'ENETRESET',
  'EPROTO',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_DESTROYED',
  'UND_ERR_CLOSED',
  'ERR_STREAM_DESTROYED',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

/**
 * True when the failure is the NETWORK dropping, not the provider refusing or
 * faulting: the connection could not be made, or it broke mid-response. This
 * is a transport symptom the loop may recover from (replay after retraction,
 * or continuing from completed tool calls). A typed HTTP status disqualifies
 * the failure — the server answered, so the network was up.
 */
export function isConnectionFailure(err) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return false;
  const chain = boundedCauseChain(err);
  if (chain.some(isExplicitUserAbortError)) return false;
  if (statusOfError(err)) return false;
  if (
    chain.some((item) => {
      const code = String(item?.code || '');
      return CONNECTION_FAILURE_CODES.has(code) || TLS_RECORD_FAILURE_RE.test(code);
    })
  ) {
    return true;
  }
  if (chain.some((item) => TRANSIENT_SDK_NAMES.has(String(item?.name || '')))) return true;
  return chain.some((item) => BARE_FETCH_TRANSPORT_MESSAGE_RE.test(String(item?.message || '').trim()));
}

/**
 * True when a stream ended WITHOUT its terminal frame because the transport
 * gave out: a stall, a truncation, a non-terminal close or a dropped
 * connection. A typed provider refusal that also lacks a terminal frame is
 * not a cut.
 */
export function isStreamCut(err) {
  const outcome = readStreamOutcome(err);
  if (outcome.terminalObserved === true) return false;
  return (
    outcome.stallObserved === true ||
    outcome.truncatedStream === true ||
    isNonTerminalStreamClose(err) ||
    isConnectionFailure(err)
  );
}

/**
 * A cut while a tool call's arguments were still streaming. That call never
 * ran, and re-sending the identical request tends to be cut at the same place
 * (large arguments stream for minutes; proxies and CDNs cut long responses),
 * so no layer re-issues it unchanged: the agent loop replays it with a notice
 * telling the model to split the content into smaller calls.
 */
export function isToolInputCut(err) {
  return readStreamOutcome(err).pendingToolInput === true && isStreamCut(err);
}

// The provider was never reached: name resolution, routing, refusal or the
// connect handshake failed, so nothing was sent or received. Only this class
// is worth waiting out for minutes — the identical request succeeds once the
// network is back (a lift, a sleeping laptop, a router reboot), and the
// reference client keeps a sampling turn alive until such a connection
// recovers. A stream that dropped mid-response is not this class: it keeps
// the short, bounded retry budget.
const CONNECT_FAILURE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NODATA',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/** True when the connection itself could not be established (see above). */
export function isConnectFailure(err) {
  if (!isConnectionFailure(err)) return false;
  return boundedCauseChain(err).some((item) => CONNECT_FAILURE_CODES.has(String(item?.code || '')));
}

// The provider is reachable but temporarily unable to serve: a typed 5xx
// (overload included) or 408, a retryable provider wire error other than a
// rate limit, a transient RPC status, or a response that never arrived in
// time. Deterministic refusals (4xx, quota, auth) and rate limits are never
// this class. The agent loop may wait out a provider ladder spent on it with
// bounded recovery cycles, but only while nothing has reached the user.
const SERVER_TIMEOUT_CODES = new Set([
  'EPROVIDERTIMEOUT',
  'EGEMINITIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const SERVER_TIMEOUT_NAMES = new Set(['APIConnectionTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError']);

export function isServerUnavailable(err) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return false;
  const chain = boundedCauseChain(err);
  if (chain.some(isExplicitUserAbortError)) return false;
  const status = statusOfError(err);
  if (status) return status === 408 || (status >= 500 && status < 600 && !TERMINAL_EDGE_STATUSES.has(status));
  if (isRetryableWireErrorEvent(err)) return typedErrorCode(err) !== RATE_LIMIT_EXCEEDED;
  return chain.some((item) => {
    const rpc = [item?.geminiStatus, item?.error?.status, typeof item?.status === 'string' ? item.status : ''];
    if (rpc.some((field) => GEMINI_TRANSIENT_RPC_CODES.has(String(field || '').toUpperCase()))) return true;
    return SERVER_TIMEOUT_CODES.has(String(item?.code || '')) || SERVER_TIMEOUT_NAMES.has(String(item?.name || ''));
  });
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
  if (!err || signal?.aborted) return false;
  const outcome = readStreamOutcome(err);
  // A completed turn needs no fallback; a user cancel must never be re-issued.
  if (outcome.terminalObserved || outcome.userAbort) return false;
  // Exposure/dispatch fails closed — re-running would duplicate output or a
  // side effect.
  if (outcome.replaySafe !== true) return false;
  // A cut mid tool-argument stream is replayed by the loop with a split-call
  // notice, never re-issued unchanged here.
  if (isToolInputCut(err)) return false;
  return classifyError(err) === 'transient' || outcome.stallObserved === true || outcome.truncatedStream === true;
}

export function boundedCauseChain(err) {
  const chain = [];
  const seen = new Set();
  let cursor = err;
  while (cursor && chain.length < MAX_CAUSE_CHAIN_DEPTH && !seen.has(cursor)) {
    chain.push(cursor);
    seen.add(cursor);
    cursor = cursor?.cause;
  }
  return chain;
}

export function isExplicitUserAbortError(err) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return false;
  if (err.name === 'AbortError' || err.name === 'APIUserAbortError' || err.code === 'ABORT_ERR') return true;
  if (err.type === 'APIUserAbortError' || err.type === 'api_user_abort_error') return true;
  try {
    return err.constructor?.name === 'APIUserAbortError';
  } catch {
    return false;
  }
}

/**
 * Detect Cursor's typed incomplete-stream transport failures independently of
 * replay permission. A reasoning/text-bearing failure is still classified as
 * permanent by classifyError(), but a caller that can retract that output may
 * use this predicate to continue from already-committed tool history.
 */
export function isCursorTransientTransportError(err) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return false;
  const chain = boundedCauseChain(err);
  if (chain.some(isExplicitUserAbortError)) return false;
  if (statusOfError(err)) return false;
  return chain.some((item) => CURSOR_TRANSIENT_ERROR_CODES.has(String(item?.cursorCode || '')));
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
  // Wordings other backends use for the same refusal, each tied to a context
  // or input-length noun so a tokens-per-minute rate limit never matches.
  /prompt too long/i, // z.ai, Ollama
  /prompt exceeds max length/i, // z.ai CN endpoint
  /input is too long for requested model/i, // Amazon Bedrock
  /input token count.*exceeds the maximum/i, // Google
  /request payload size exceeds the limit/i, // Google (400, byte-size limit)
  // A 413 re-wrapped by a proxy or aggregator without its status.
  /request entity too large/i,
  /request exceeds the maximum size/i,
  /maximum prompt length is \d+/i, // xAI
  /exceeds (?:the )?maximum allowed input length/i, // OpenRouter relays
  /is longer than the model'?s context length/i, // Together AI
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi
  /too large for model with \d+ maximum context length/i, // Mistral
  /range of input length should be/i, // DashScope / Qwen
  /model_context_window_exceeded/i, // z.ai finish reason surfaced as text
];

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
  if (!err || _depth > 2) return false;
  if (statusOfError(err) === 413) return true;
  const code = typedErrorCode(err);
  if (code && CONTEXT_OVERFLOW_CODES.has(code)) return true;
  const msg = (typeof err === 'string' ? err : err?.message) || '';
  if (msg && CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(msg))) return true;
  if (err.cause != null && err.cause !== err) return isContextOverflowError(err.cause, _depth + 1);
  if (err.response?.data != null) return isContextOverflowError(err.response.data, _depth + 1);
  return false;
}

export function headerValue(headers, name) {
  if (!headers) return null;
  const lower = name.toLowerCase();
  if (typeof headers.get === 'function') return headers.get(name) ?? headers.get(lower);
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

export function retryAfterMsFromError(err) {
  const headers = err?.headers || err?.response?.headers || err?.data?.responseHeaders || null;
  const retryAfterMs = headerValue(headers, 'retry-after-ms');
  if (retryAfterMs != null && retryAfterMs !== '') {
    const n = Number(retryAfterMs);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter != null && retryAfter !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const dateMs = Date.parse(String(retryAfter));
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  // Google RPC RetryInfo encodes retryDelay as a protobuf Duration. Preserve
  // the same precedence as Retry-After: a server-provided retry window means
  // RESOURCE_EXHAUSTED is request-local, not a permanent quota refusal.
  const detailLists = [err?.details, err?.error?.details, err?.data?.error?.details];
  for (const details of detailLists) {
    if (!Array.isArray(details)) continue;
    for (const detail of details) {
      const delay = detail?.retryDelay;
      if (typeof delay === 'string') {
        const match = delay.trim().match(/^(\d+(?:\.\d+)?)s$/);
        if (match) return Math.ceil(Number(match[1]) * 1000);
      } else if (delay && typeof delay === 'object') {
        const seconds = Number(delay.seconds || 0);
        const nanos = Number(delay.nanos || 0);
        const ms = seconds * 1000 + nanos / 1_000_000;
        if (Number.isFinite(ms) && ms >= 0) return Math.ceil(ms);
      }
    }
  }
  const resetHeader = headerValue(headers, ANTHROPIC_RESET_HEADER);
  if (resetHeader != null && resetHeader !== '') {
    const resetUnixSec = Number(resetHeader);
    if (Number.isFinite(resetUnixSec) && resetUnixSec > 0) {
      const delayMs = Math.ceil(resetUnixSec * 1000 - Date.now());
      if (delayMs > 0) return Math.min(delayMs, ANTHROPIC_RESET_CAP_MS);
    }
  }
  // Codex parses the server-supplied window from a TYPED rate_limit_exceeded
  // payload. Message text never decides whether to retry — only how long to
  // wait after the typed code is already in hand. Headers / RetryInfo win.
  if (typedErrorCode(err) === RATE_LIMIT_EXCEEDED) {
    const delay = rateLimitRetryAfterMsFromMessage(err);
    if (delay != null) return delay;
  }
  return null;
}

export function isPermanentQuotaError(err) {
  const status = statusOfError(err);
  // Gemini uses RESOURCE_EXHAUSTED for both daily quota and per-minute
  // rate limits. A 429 is request-local (Google/LiteLLM retry); without a
  // 429 the same code stays a deterministic quota refusal.
  const permanentCodes = new Set(['insufficient_quota', 'quota_exceeded']);
  if (status !== 429) permanentCodes.add('resource_exhausted');
  for (const item of boundedCauseChain(err)) {
    const codes = [item?.code, item?.error?.code];
    if (codes.some((code) => permanentCodes.has(String(code || '').toLowerCase()))) return true;
  }
  return false;
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
export const WIRE_ERROR_FATAL_CODES = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'insufficient_quota',
  'quota_exceeded',
  'resource_exhausted',
  'usage_not_included',
  'usage_limit_reached',
  'invalid_prompt',
  'bio_policy',
  'cyber_policy',
  'invalid_request',
  'invalid_request_error',
  'invalid_api_key',
  'authentication_error',
  'permission_error',
  'permission_denied',
  'billing_not_active',
]);

export function typedErrorCode(err) {
  const failed = err?.responseFailed;
  const detail = failed?.response?.error || failed?.error || err?.providerError || failed || null;
  for (const field of [detail?.code, detail?.type, err?.providerErrorCode, err?.code, err?.error?.code]) {
    if (typeof field === 'string' && field.trim()) return field.trim().toLowerCase();
  }
  return '';
}

/**
 * True when the typed wire/SDK code is previous_response_not_found.
 * Callers drop lastResponseId / previous_response_id and re-issue a full frame.
 */
export function shouldDropPreviousResponseId(err) {
  return typedErrorCode(err) === PREVIOUS_RESPONSE_NOT_FOUND;
}

function isGeminiTransientRpc(err) {
  for (const item of boundedCauseChain(err)) {
    for (const field of [item?.geminiStatus, item?.error?.status]) {
      if (typeof field !== 'string') continue;
      const key = field.toUpperCase();
      if (GEMINI_TRANSIENT_RPC_CODES.has(key) || key === 'RESOURCE_EXHAUSTED') return true;
    }
    if (typeof item?.status === 'string') {
      const key = item.status.toUpperCase();
      if (GEMINI_TRANSIENT_RPC_CODES.has(key)) return true;
    }
    const code = item?.code;
    if (typeof code === 'string' && GEMINI_TRANSIENT_RPC_CODES.has(code.toUpperCase())) return true;
  }
  return false;
}

export function isStaleKeepAliveError(err) {
  return boundedCauseChain(err).some((item) => {
    const code = String(item?.code || '');
    return code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET';
  });
}

const RATE_LIMIT_RETRY_AFTER_RE = /try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)\b/i;

function rateLimitRetryAfterMsFromMessage(err) {
  const failed = err?.responseFailed;
  const detail = failed?.response?.error || failed?.error || err?.providerError || err?.error || null;
  const messages = [detail?.message, err?.message];
  for (const message of messages) {
    if (typeof message !== 'string' || !message) continue;
    const match = message.match(RATE_LIMIT_RETRY_AFTER_RE);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0) continue;
    const unit = String(match[2] || '').toLowerCase();
    return unit === 'ms' ? Math.ceil(value) : Math.ceil(value * 1000);
  }
  return null;
}

// 'transient' | 'permanent' for errors born from a provider wire error event;
// null for everything else (no blanket retry for untyped local failures).
function classifyWireErrorEvent(err) {
  if (!err || (err.responseFailed == null && err.providerWireError !== true)) return null;
  const code = typedErrorCode(err);
  if (code && WIRE_ERROR_FATAL_CODES.has(code)) return 'permanent';
  return 'transient';
}

/**
 * True when `err` came from a provider wire error event whose typed code is
 * not a deterministic refusal — i.e. the send-with-recovery loop may replay
 * it (after text retraction when something was exposed). classifyError()
 * reports 'permanent' the moment output was exposed, so the loop names this
 * symptom directly, exactly like stall/truncated/non-terminal-close.
 */
export function isRetryableWireErrorEvent(err) {
  return classifyWireErrorEvent(err) === 'transient';
}

/**
 * Grok Build StreamError: a mid-stream wire fault is retryable even when the
 * envelope type is invalid_request_error, unless a typed 4xx status or a
 * deterministic refusal code (quota/context/auth) is present.
 */
export function isRetryableStreamErrorEvent(err) {
  if (classifyWireErrorEvent(err) === 'transient') return true;
  if (err?.providerWireError !== true) return false;
  const status = statusOfError(err);
  if (status && status >= 400 && status < 500 && !TRANSIENT_STATUSES.has(status)) return false;
  const code = typedErrorCode(err);
  if (code && WIRE_ERROR_FATAL_CODES.has(code) && code !== 'invalid_request' && code !== 'invalid_request_error') {
    return false;
  }
  return true;
}
