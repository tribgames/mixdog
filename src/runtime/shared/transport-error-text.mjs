// Connection-level failure → one short user-facing sentence.
//
// Transport errors reach the UI in many shapes: a Node errno on the error
// itself, an undici SocketError buried in `cause`, a bare fetch message
// ('fetch failed', 'terminated') with no code at all, or a gateway 5xx. Every
// surface that shows a failure reads them through this one classifier so the
// user sees "Connection to the provider was lost (UND_ERR_SOCKET)." instead of
// the runtime's raw wording, while the code stays visible for diagnosis.

const MAX_CAUSE_DEPTH = 8;

const LOST_CODES = new Set([
  'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ENETRESET', 'EPROTO',
  'UND_ERR_SOCKET', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED', 'UND_ERR_ABORTED',
  'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_HTTP2_STREAM_ERROR', 'ERR_HTTP2_SESSION_ERROR', 'ERR_HTTP2_INVALID_SESSION',
  'ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_STREAM_CANCEL',
]);
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL',
  'ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_FAIL', 'EAI_NONAME',
  'UND_ERR_CONNECT',
]);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);
const TLS_CODE_RE = /^(?:UNABLE_TO_|CERT_|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|ERR_TLS_|HOSTNAME_MISMATCH)/;
const UNAVAILABLE_STATUSES = new Set([502, 503, 504, 521, 522, 523, 524]);

// Bare runtime messages that carry no code: undici body abort, Node/Chromium/
// WebKit fetch failures, the Anthropic/OpenAI SDK connection wrapper. Matched
// whole so a shell job "terminated by signal" or a session "terminated" notice
// never reads as a provider disconnect.
const LOST_BARE_MESSAGE_RE = /^(?:terminated|socket hang up|other side closed|connection error\.?)$/i;
const FETCH_BARE_MESSAGE_RE = /^(?:fetch failed|failed to fetch|couldn'?t fetch\.?|load failed|network error)$/i;
const LOST_PHRASE_RE = /\b(?:socket hang up|other side closed|connection (?:was )?reset(?: by peer)?|network unreachable|premature close|stream (?:was )?destroyed)\b/i;
const UNREACHABLE_PHRASE_RE = /\b(?:connection refused|getaddrinfo|dns lookup failed|host (?:not found|unreachable))\b/i;
const TIMEOUT_PHRASE_RE = /\b(?:connect(?:ion)? timed? ?out|headers timeout|body timeout)\b/i;
const GATEWAY_STATUS_MESSAGE_RE = /\b(?:API|HTTP(?: fallback)?)\s+(50[234]|52[1-4])\b/;

function causeChain(error) {
  const chain = [];
  const seen = new Set();
  let cursor = error;
  while (cursor && typeof cursor === 'object' && chain.length < MAX_CAUSE_DEPTH && !seen.has(cursor)) {
    chain.push(cursor);
    seen.add(cursor);
    cursor = cursor.cause;
  }
  return chain;
}

function messageOf(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && typeof value.message === 'string') return value.message.trim();
  return '';
}

function typedStatus(error) {
  if (!error || typeof error !== 'object') return 0;
  for (const value of [error.httpStatus, error.status, error.response?.status]) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  return 0;
}

/**
 * Classify a connection-level failure by walking the error and its `cause`
 * chain. Returns `{ kind, code, status }` or null when the failure is not a
 * transport problem. `code` is the innermost errno/undici code (the most
 * specific cause), preferred over the outer wrapper's code.
 */
export function classifyTransportError(error) {
  const chain = typeof error === 'string' ? [] : causeChain(error);
  const messages = typeof error === 'string' ? [error.trim()] : chain.map(messageOf);
  let code = '';
  let kind = null;
  // Innermost typed code wins: an outer TypeError('fetch failed') wraps the
  // SocketError that actually explains the failure.
  for (let index = chain.length - 1; index >= 0; index--) {
    const item = chain[index];
    const itemCode = String(item?.code || '').toUpperCase();
    const itemName = String(item?.name || '');
    if (itemCode && TLS_CODE_RE.test(itemCode)) { kind = 'tls'; code = itemCode; break; }
    if (LOST_CODES.has(itemCode)) { kind = 'lost'; code = itemCode; break; }
    if (UNREACHABLE_CODES.has(itemCode)) { kind = 'unreachable'; code = itemCode; break; }
    if (TIMEOUT_CODES.has(itemCode)) { kind = 'timeout'; code = itemCode; break; }
    if (itemName === 'SocketError') { kind = 'lost'; code = itemCode; break; }
    if (itemName === 'ConnectTimeoutError' || itemName === 'HeadersTimeoutError' || itemName === 'BodyTimeoutError') {
      kind = 'timeout'; code = itemCode; break;
    }
  }
  if (!kind) {
    const status = typedStatus(chain[0]);
    if (UNAVAILABLE_STATUSES.has(status)) return { kind: 'unavailable', code: '', status };
    const gateway = GATEWAY_STATUS_MESSAGE_RE.exec(messages[0] || '');
    if (gateway) return { kind: 'unavailable', code: '', status: Number(gateway[1]) };
  }
  if (!kind) {
    for (const message of messages) {
      if (!message) continue;
      if (LOST_BARE_MESSAGE_RE.test(message) || LOST_PHRASE_RE.test(message)) { kind = 'lost'; break; }
      if (UNREACHABLE_PHRASE_RE.test(message)) { kind = 'unreachable'; break; }
      if (TIMEOUT_PHRASE_RE.test(message)) { kind = 'timeout'; break; }
      if (FETCH_BARE_MESSAGE_RE.test(message)) { kind = 'unreachable'; break; }
    }
  }
  if (!kind) return null;
  return { kind, code, status: 0 };
}

const TRANSPORT_SENTENCES = {
  lost: 'Connection to the provider was lost',
  unreachable: 'Could not reach the provider',
  timeout: 'The provider did not respond in time',
  tls: 'Provider TLS certificate check failed',
  unavailable: 'Provider is temporarily unavailable',
};

/** User-facing sentence for a transport failure, or null when not one. */
export function transportErrorText(error) {
  const verdict = classifyTransportError(error);
  if (!verdict) return null;
  const detail = verdict.code || (verdict.status ? String(verdict.status) : '');
  return `${TRANSPORT_SENTENCES[verdict.kind]}${detail ? ` (${detail})` : ''}.`;
}
