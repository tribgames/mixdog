// Mid-stream and handshake verdicts: whether a broken WS/SSE stream may be
// resumed, fall back to another transport, or must surface.
import { readStreamOutcome } from './lib/stream-outcome.mjs';
import {
  NON_TERMINAL_STREAM_CLOSE_CODES,
  TERMINAL_EDGE_STATUSES,
  TRANSIENT_ERROR_CODES,
  TRANSIENT_STATUSES,
  WEBSOCKET_CONNECTION_LIMIT,
  WIRE_ERROR_FATAL_CODES,
  classifyError,
  typedStatusFrom,
} from './retry-classification.mjs';

// F) Retry-budget profiles as DATA. The numbers live ONLY here now.
//    ws.*Retries (5)              — one Responses stream retry budget.
//    sse.defaultRetries (3)       — anthropic single-shot SSE mid-stream budget.
export const MIDSTREAM_RETRY_POLICY = {
  ws: { transientCloseRetries: 5, defaultRetries: 5, backoff: [250, 1000, 2000, 4000, 5000] },
  sse: { defaultRetries: 3, backoff: [250, 1000, 2000, 4000] },
};

// WS buckets that earn the larger transient-close retry budget.
const WS_TRANSIENT_CLOSE_CLASSIFIERS = new Set(['ws_1006', 'ws_1011']);

function _midstreamLimitFor(classifier, policy) {
  if (policy.mode === 'ws') {
    return WS_TRANSIENT_CLOSE_CLASSIFIERS.has(classifier) ? policy.transientCloseRetries : policy.defaultRetries;
  }
  return policy.defaultRetries;
}

// WS gates each classifier against its own budget. SSE applies a single
// top-of-function budget gate and
// then returns raw classifier strings, so perClassifierGate:false returns the
// classifier unconditionally here.
function _allowMidstream(classifier, attemptIndex, policy) {
  if (policy.perClassifierGate === false) return classifier;
  return attemptIndex < _midstreamLimitFor(classifier, policy) ? classifier : null;
}

// A) Unified mid-stream classifier. Returns a classifier string or null.
//    `signals` is the provider's mid-stream state object (field names unchanged
//    from each provider's midState). `policy.mode` selects the WS or SSE path so
//    both providers reproduce their exact current branch order and gating.
export function classifyMidstreamError(err, signals, policy = {}) {
  if (!signals) return null;
  const attemptIndex = signals.attemptIndex | 0;
  if (policy.mode === 'sse') return _classifyMidstreamSse(err, signals, attemptIndex, policy);
  return _classifyMidstreamWs(err, signals, attemptIndex, policy);
}

// The stall the error or the provider's watchdog reports, if any. A stall
// after any exposure was already denied by the outcome gate.
function stallReason(err, state) {
  const name = err?.name || '';
  if (name === 'AgentStallAbortError' || state.watchdogAbort === 'AgentStallAbortError') return 'agent_stall';
  if (
    name === 'StreamStalledAbortError' ||
    name === 'StreamStalledError' ||
    err?.code === 'ESTREAMSTALL' ||
    err?.streamStalled === true ||
    state.watchdogAbort === 'StreamStalledAbortError'
  ) {
    return 'stream_stalled';
  }
  return null;
}

// The Responses WebSocket emits its hard 60-minute retirement as a top-level
// `event.error`, not `response.failed`. openai-ws-stream preserves that typed
// object on err.payload; only the documented code earns this specific bucket.
// Other pre-response error events surface to the loop, where the wire-error
// contract (typed fatal-code deny-list / default-retry) decides — never
// message text.
function isWebSocketConnectionLimit(err) {
  for (const field of [err?.payload?.code, err?.payload?.type]) {
    const key = typeof field === 'string' ? field.trim().toLowerCase() : '';
    if (key === WEBSOCKET_CONNECTION_LIMIT) return true;
  }
  return false;
}

// `response.failed` classification from STRUCTURED evidence only: the
// failure's own numeric status and its explicit error code/type field. The
// payload is never stringified and searched — a message/body that merely
// CONTAINS "network_error" or "stream_disconnected" never selects a SPECIFIC
// bucket. Buckets need typed codes; the DEFAULT for an unrecognized (or
// absent) code is the bounded retry, with fatal refusal codes staying
// terminal.
function classifyResponseFailed(failed, attemptIndex, policy) {
  const detail = failed?.response?.error || failed?.error || failed;
  const failedStatus = typedStatusFrom(detail, failed?.response, failed);
  if (failedStatus >= 500 && failedStatus < 600) {
    if (TERMINAL_EDGE_STATUSES.has(failedStatus)) return null;
    return _allowMidstream(`http_${failedStatus}`, attemptIndex, policy);
  }
  for (const field of [detail?.code, detail?.type]) {
    const key = typeof field === 'string' ? field.trim().toLowerCase() : '';
    const classifier = RESPONSE_FAILED_CODE_CLASSIFIERS.get(key);
    if (classifier) return _allowMidstream(classifier, attemptIndex, policy);
    if (key && WIRE_ERROR_FATAL_CODES.has(key)) return null;
  }
  // A typed non-transient 4xx on the failure payload is a deterministic
  // refusal even without a recognized code string.
  if (failedStatus >= 400 && failedStatus < 500 && !TRANSIENT_STATUSES.has(failedStatus)) return null;
  // Default-retry: a wire failure that is neither a fatal refusal nor a
  // typed 4xx is a server-side fault — re-issue it under the bounded
  // mid-stream budget instead of failing the turn.
  return _allowMidstream('response_failed_retryable', attemptIndex, policy);
}

// WebSocket classification consumes the provider's stream-state signals.
function _classifyMidstreamWs(err, state, attemptIndex, policy) {
  // Terminal + replay gate. A mid-stream retry re-issues the turn, so it is
  // denied once visible output was relayed or a tool call was dispatched
  // (including a nominal close-1000 before response.completed: the tool may be
  // executing). Everything below is the typed transient classification.
  const outcome = readStreamOutcome(err, state);
  if (outcome.terminalObserved) return null;
  if (outcome.replaySafe !== true) return null;
  if (err?.wsFrameTooLarge || state.wsFrameTooLarge) {
    return _allowMidstream('ws_frame_too_large', attemptIndex, policy);
  }
  if (state.firstByteTimeout || err?.firstByteTimeout) {
    return _allowMidstream('first_byte_timeout', attemptIndex, policy);
  }
  if (err?.wsSendFailed || state.wsSendFailed) {
    return _allowMidstream('ws_send_failed', attemptIndex, policy);
  }
  if (isWebSocketConnectionLimit(err)) {
    return _allowMidstream('websocket_connection_limit', attemptIndex, policy);
  }
  // Stall / local-close-4000 must be classified as RETRYABLE before the
  // pre-`response.created` deny gate below. A first-meaningful-frame timeout
  // fires with sawResponseCreated=false + close 4000 + StreamStalledError, so
  // without this the pre-created gate would return null (terminal) and the
  // stall would never route through the mid-stream retry / transport fallback.
  const stall = stallReason(err, state);
  if (stall) return _allowMidstream(stall, attemptIndex, policy);
  const closeCode = Number(err?.wsCloseCode || state.wsCloseCode || 0);
  if (closeCode === 4000) return _allowMidstream('ws_4000', attemptIndex, policy);
  // A close before response.created has not produced any response bytes to
  // the caller, so it is safe to reconnect and replay under the bounded
  // retry policy (text/tool emission was denied above before this gate).
  // NOMINAL closes count too: a pooled socket the server retires between
  // turns closes with 1000/1001/1005 and must reconnect fresh — treating
  // that as terminal killed the turn instead of reissuing it.
  if (!state.sawResponseCreated && !NON_TERMINAL_STREAM_CLOSE_CODES.has(closeCode)) return null;
  if (state.userAbort) return null;

  if (!err) return null;
  const status = Number(err?.httpStatus || 0);
  if (status === 401 || status === 403 || status === 429) return null;
  if (status >= 500 && status < 600) {
    if (TERMINAL_EDGE_STATUSES.has(status)) return null;
    return _allowMidstream(`http_${status}`, attemptIndex, policy);
  }

  if (closeCode === 1006) return _allowMidstream('ws_1006', attemptIndex, policy);
  if (closeCode === 1011) return _allowMidstream('ws_1011', attemptIndex, policy);
  if (closeCode === 1012) return _allowMidstream('ws_1012', attemptIndex, policy);
  if (closeCode > 4000 && closeCode < 5000) return null;
  // Nominal close without the terminal frame — before OR after
  // response.created. Only a completed turn is terminal here.
  if ((closeCode === 1000 || closeCode === 1001 || closeCode === 1005) && !state.sawCompleted) {
    return _allowMidstream(`ws_${closeCode}`, attemptIndex, policy);
  }

  const failed = err?.responseFailed || state.responseFailedPayload;
  if (failed) return classifyResponseFailed(failed, attemptIndex, policy);
  return null;
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
]);

// SSE classification consumes the provider's stream-state signals.
function _classifyMidstreamSse(err, state, attemptIndex, policy) {
  if (attemptIndex >= policy.defaultRetries) return null;
  const outcome = readStreamOutcome(err, state);
  if (outcome.terminalObserved) return null;
  if (state.userAbort) return null;
  if (outcome.replaySafe !== true) return null;

  if (!err) return null;
  const status = Number(err?.httpStatus || err?.status || err?.response?.status || 0);
  if (status === 401 || status === 403) return null;
  if (status === 429) return 'http_429';
  if (status >= 500 && status < 600) {
    if (TERMINAL_EDGE_STATUSES.has(status)) return null;
    return `http_${status}`;
  }

  const name = err?.name || '';
  if (name === 'AgentStallAbortError') return 'agent_stall';
  if (
    name === 'StreamStalledAbortError' ||
    name === 'StreamStalledError' ||
    err?.code === 'ESTREAMSTALL' ||
    err?.streamStalled === true
  ) {
    return 'stream_stalled';
  }
  if (state.watchdogAbort === 'AgentStallAbortError') return 'agent_stall';
  if (state.watchdogAbort === 'StreamStalledAbortError') return 'stream_stalled';

  const code = err?.code || err?.cause?.code || '';
  if (code === 'ECONNRESET') return 'reset';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA') return 'dns';

  if (classifyError(err) === 'transient') return 'connection';

  return null;
}

// B) Unified transport (WS→HTTP) fallback predicate. Identical deny-order +
//    allow-list to the two former copies; `enabled` replaces the per-provider
//    env-flag check (caller computes the flag and passes it).
const TRANSPORT_FALLBACK_CLASSIFIERS = new Set([
  'timeout',
  'reset',
  'dns',
  'refused',
  'network',
  'acquire_timeout',
  'http_5xx',
  'first_byte_timeout',
  'ws_1006',
  'ws_1011',
  'ws_1012',
  'ws_1000',
  'ws_1001',
  'ws_1005',
  'ws_4000',
  'agent_stall',
  'stream_stalled',
  'response_failed_disconnected',
  'response_failed_network',
  'response_failed_auth_expired',
  'ws_send_failed',
]);
const TRANSPORT_FALLBACK_ERRNO = new Set([
  'EWSACQUIRETIMEOUT',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EAI_NODATA',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
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
]);

export function shouldFallbackTransport(err, { signal, enabled = true } = {}) {
  if (!enabled) return false;
  if (signal?.aborted) return false;
  // Transport fallback re-issues the request on another transport: it is a
  // replay, so the exposure deny applies. Eligibility itself stays typed
  // (status / errno / classifier) for the WS→HTTPS switch.
  if (readStreamOutcome(err).replaySafe !== true) return false;
  const status = Number(err?.httpStatus || err?.status || 0);
  // 401 is auth recovery, never transport fallback. 426 is the explicit
  // immediate WS→HTTPS switch; every other status must be TYPED transient
  // (408/409/5xx) — an arbitrary nonzero status is not fallback evidence.
  if (status === 401) return false;
  if (status === 426) return true;
  if (TERMINAL_EDGE_STATUSES.has(status)) return false;
  if (TRANSIENT_STATUSES.has(status) || (status >= 500 && status < 600)) return true;
  if (status > 0) return false;
  const code = String(err?.code || '');
  if (TRANSPORT_FALLBACK_ERRNO.has(code)) return true;
  const classifier = String(err?.retryClassifier || err?.midstreamClassifier || '');
  if (TRANSPORT_FALLBACK_CLASSIFIERS.has(classifier)) return true;
  if (/^http_5\d\d$/.test(classifier)) return true;
  if (err?.firstByteTimeout) return true;
  return false;
}

// E) Handshake classifier. Default-deny: anything not recognized as transient
//    returns null. HTTP 401 is reserved for auth recovery and 426 for immediate
//    HTTPS fallback. The OpenAI OAuth caller opts out of 429 retries
//    (retry429:false); all other callers retain the historical retryable
//    UnexpectedStatus policy.
export function classifyHandshakeError(err, { retry429 = true } = {}) {
  if (!err) return null;
  const code = err.code || '';
  const status = Number(err.httpStatus || 0);

  if (status === 401 || status === 426 || (status === 429 && !retry429)) return null;
  if (status > 0) {
    // Typed transient handshake statuses only. A 403/404/4xx upgrade refusal
    // is a deterministic decision: spending the retry budget on it cannot
    // change the answer.
    if (status === 429 || TRANSIENT_STATUSES.has(status) || (status >= 500 && status < 600)) {
      if (TERMINAL_EDGE_STATUSES.has(status)) return null;
      return `http_${status}`;
    }
    return null;
  }

  if (code === 'ECONNRESET') return 'reset';
  if (code === 'EAI_AGAIN' || code === 'ENOTFOUND' || code === 'EAI_NODATA') return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
  if (code === 'EWSACQUIRETIMEOUT') return 'acquire_timeout';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'EPIPE') return 'network';
  if (TRANSIENT_ERROR_CODES.has(String(code))) {
    if (code === 'UND_ERR_SOCKET' || code === 'EPROTO') return 'network';
    if (code === 'UND_ERR_DESTROYED' || code === 'UND_ERR_CLOSED' || code === 'ERR_STREAM_DESTROYED') return 'reset';
    if (code === 'ECONNABORTED' || code === 'ENETRESET') return 'reset';
    if (String(code).startsWith('ERR_HTTP2_')) return 'reset';
    if (code === 'UND_ERR_CONNECT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
    if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') return 'timeout';
    if (code === 'ERR_SOCKET_CONNECTION_TIMEOUT') return 'timeout';
  }

  return null;
}
