// Provider error kind: one semantic verdict for a thrown provider error,
// shared by retry policy, account rotation and the UI. Leaf module: it reads
// the typed fields provider boundaries stamp on errors (status, code,
// headers, retryAfterMs, resetAt, quotaScope, reauthRequired) and falls back
// to the older fields (httpStatus, responseFailed, providerError, SDK error
// bodies, RPC status strings). Message text is consulted only for untyped
// errors and only for unambiguous wordings.

export const PROVIDER_ERROR_KINDS = Object.freeze([
  'overloaded',
  'rate_limited',
  'quota_exhausted',
  'entitlement',
  'billing',
  'auth',
  'permission',
  'context_overflow',
  'request_too_large',
  'policy',
  'service_tier_unavailable',
  'invalid_request',
  'transient',
  'unknown',
]);

const MAX_CAUSE_CHAIN_DEPTH = 8;

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

export function headerValue(headers, name) {
  if (!headers) return null;
  const lower = name.toLowerCase();
  if (typeof headers.get === 'function') return headers.get(name) ?? headers.get(lower);
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

function wireDetail(err) {
  const failed = err?.responseFailed;
  return failed?.response?.error || failed?.error || err?.providerError || failed || null;
}

// Every place a provider error may carry its response headers, outermost
// first: the error itself, the SDK response, preserved wire `error.headers`.
function headerSources(err) {
  const detail = wireDetail(err);
  return [
    err?.headers,
    err?.response?.headers,
    err?.data?.responseHeaders,
    err?.error?.headers,
    detail?.headers,
    err?.providerError?.headers,
    err?.payload?.error?.headers,
  ].filter((headers) => headers && typeof headers === 'object');
}

/** The first value of response header `name` across every preserved header source. */
export function errorHeaderValue(err, name) {
  for (const headers of headerSources(err)) {
    const value = headerValue(headers, name);
    if (value != null && value !== '') return value;
  }
  return null;
}

export function typedErrorCode(err) {
  const detail = wireDetail(err);
  for (const field of [detail?.code, detail?.type, err?.providerErrorCode, err?.code, err?.error?.code]) {
    if (typeof field === 'string' && field.trim()) return field.trim().toLowerCase();
  }
  return '';
}

// ── Retry-After ─────────────────────────────────────────────────────────────
const MESSAGE_DELAY_CODES = new Set(['rate_limit_exceeded', 'slow_down']);
const MESSAGE_DELAY_RE =
  /(?:try again in|retry (?:again )?(?:in|after)|wait(?: for)?)\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b/i;

// Zero or non-positive advice is no advice: the caller's local backoff applies
// and a later source may still advise.
function finitePositive(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function retryInfoDelayMs(details) {
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    const delay = detail?.retryDelay;
    let ms = null;
    if (typeof delay === 'string') {
      const match = delay.trim().match(/^(\d+(?:\.\d+)?)s$/);
      if (match) ms = Number(match[1]) * 1000;
    } else if (delay && typeof delay === 'object') {
      ms = Number(delay.seconds || 0) * 1000 + Number(delay.nanos || 0) / 1_000_000;
    }
    if (finitePositive(ms) != null) return Math.ceil(ms);
  }
  return null;
}

function messageDelayMs(err) {
  const detail = wireDetail(err) || err?.error || null;
  for (const message of [detail?.message, err?.error?.message, err?.message]) {
    if (typeof message !== 'string' || !message) continue;
    const match = message.match(MESSAGE_DELAY_RE);
    if (!match) continue;
    const value = finitePositive(match[1]);
    if (value == null) continue;
    const unit = String(match[2] || '').toLowerCase();
    if (unit === 'ms' || unit.startsWith('millisecond')) return Math.ceil(value);
    if (unit === 'm' || unit.startsWith('min')) return Math.ceil(value * 60_000);
    return Math.ceil(value * 1000);
  }
  return null;
}

/**
 * The server-advised wait before re-issuing, in ms; null when the server gave
 * none. Precedence: the boundary-stamped `retryAfterMs`, Retry-After headers
 * (any preserved source), Google RetryInfo (`details` / SDK `errorDetails`),
 * and finally the delay a TYPED rate_limit_exceeded / slow_down message names.
 * Window resets (`resetAt`, anthropic-ratelimit-unified-reset) are never
 * retry advice: they are reported separately for display and cooldown.
 */
export function retryAfterMsFromError(err) {
  if (!err || typeof err !== 'object') return null;
  // A deadline captured once at the boundary (`retryAfterAt`)
  // survives a transport switch: report what is left of it.
  for (const item of boundedCauseChain(err).slice(0, 2)) {
    const at = Number(item?.retryAfterAt);
    if (Number.isFinite(at) && at > 0) return Math.max(0, at - Date.now());
  }
  for (const item of boundedCauseChain(err).slice(0, 2)) {
    const stamped = finitePositive(item?.retryAfterMs);
    if (stamped != null) return stamped;
  }
  const retryAfterMs = finitePositive(errorHeaderValue(err, 'retry-after-ms'));
  if (retryAfterMs != null) return retryAfterMs;
  const retryAfter = errorHeaderValue(err, 'retry-after');
  if (retryAfter != null) {
    const seconds = finitePositive(retryAfter);
    if (seconds != null) return Math.ceil(seconds * 1000);
    const untilDate = finitePositive(Date.parse(String(retryAfter)) - Date.now());
    if (untilDate != null) return untilDate;
  }
  const detail = wireDetail(err);
  for (const details of [
    err.details,
    err.error?.details,
    err.data?.error?.details,
    err.errorDetails,
    err.error?.errorDetails,
    detail?.details,
  ]) {
    const delay = retryInfoDelayMs(details);
    if (delay != null) return delay;
  }
  if (MESSAGE_DELAY_CODES.has(typedErrorCode(err))) return messageDelayMs(err);
  return null;
}

// ── Transport evidence ──────────────────────────────────────────────────────
export const TRANSIENT_SDK_NAMES = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
]);
const STALL_NAMES = new Set(['StreamStalledError', 'StreamStalledAbortError', 'AgentStallAbortError']);
// 'terminated' / 'other side closed' / 'socket hang up' are the body-read
// forms of the same disconnect (undici aborts the response body when the peer
// closes mid-stream and may not attach a cause).
export const BARE_FETCH_TRANSPORT_MESSAGE_RE =
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
// versions, so the stable suffix names the class.
export const TLS_RECORD_FAILURE_RE = /^ERR_SSL_[A-Z0-9_/]*BAD_RECORD_MAC$/i;

/** True for a socket/TLS errno that describes a transient transport fault. */
export function isTransientErrorCode(code) {
  const value = String(code || '');
  return TRANSIENT_ERROR_CODES.has(value) || TLS_RECORD_FAILURE_RE.test(value);
}

const TRANSIENT_WS_CLOSE_CODES = new Set([1000, 1001, 1005, 1006, 1011, 1012]);

function transportEvidence(err, chain, status) {
  if (err.truncatedStream === true || err.code === 'TRUNCATED_STREAM' || err.streamStalled === true) return true;
  if (TRANSIENT_WS_CLOSE_CODES.has(Number(err.wsCloseCode ?? err.streamCloseCode ?? 0))) return true;
  if (chain.some((item) => isTransientErrorCode(item?.code))) return true;
  const names = chain.map((item) => String(item?.name || ''));
  if (names.some((name) => TRANSIENT_SDK_NAMES.has(name) || STALL_NAMES.has(name))) return true;
  return !status && chain.some((item) => BARE_FETCH_TRANSPORT_MESSAGE_RE.test(String(item?.message || '').trim()));
}

// ── Context / size wording (untyped fallback) ───────────────────────────────
// Token-context refusals: the conversation is longer than the model's window.
export const TOKEN_CONTEXT_OVERFLOW_PATTERNS = [
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
// Byte/media size refusals: the request body itself is too large.
export const REQUEST_SIZE_PATTERNS = [
  /request payload size exceeds the limit/i, // Google (400, byte-size limit)
  // A 413 re-wrapped by a proxy or aggregator without its status.
  /request entity too large/i,
  /request exceeds the maximum size/i,
];

// Capacity wording on an untyped 429 ("… is at capacity").
const CAPACITY_MESSAGE_RE = /\bat capacity\b|\boverloaded\b|\bserver is busy\b/i;
// Unambiguous quota wordings, read only under `legacyQuotaWording`.
const LEGACY_BILLING_MESSAGE_RE = /\binsufficient_quota\b|exceeded your (?:current )?quota/i;
const LEGACY_QUOTA_MESSAGE_RE = /\bquota_exceeded\b|\busage_limit_reached\b|hit your usage limit/i;

// ── Typed codes ─────────────────────────────────────────────────────────────
const CODE_KINDS = new Map(
  Object.entries({
    policy: [
      'cyber_policy',
      'bio_policy',
      'cyber_policy_violation',
      'bio_policy_violation',
      'misalignment_policy_violation',
      'content_policy_violation',
      'content_filter',
      'safety',
      'recitation',
      'invalid_prompt',
    ],
    billing: [
      'insufficient_quota',
      'credit_balance_exhausted',
      'organization_spend_limit_exceeded',
      'project_spend_limit_exceeded',
      'organization_usage_limit_exceeded',
      'billing_not_active',
      'billing_hard_limit_reached',
      'payment_required',
      'insufficient_g1_credits_balance',
    ],
    entitlement: ['usage_not_included'],
    quota_exhausted: ['quota_exceeded', 'quota_exhausted', 'usage_limit_reached', 'provider_accounts_exhausted'],
    context_overflow: ['context_length_exceeded', 'context_window_exceeded', 'model_context_window_exceeded'],
    request_too_large: ['request_too_large', 'payload_too_large', 'request_entity_too_large'],
    auth: ['invalid_api_key', 'authentication_error', 'unauthenticated', 'unauthorized', 'invalid_authentication'],
    permission: ['permission_error', 'permission_denied', 'forbidden'],
    overloaded: [
      'server_is_overloaded',
      'overloaded_error',
      'overloaded',
      'server_overloaded',
      'model_capacity_exhausted',
      'model_capacity_exceeded',
    ],
    // The requested service tier has no capacity: the same request at the
    // same tier is refused again, so it is final rather than an overload.
    service_tier_unavailable: ['flex_unavailable'],
    rate_limited: ['rate_limit_exceeded', 'rate_limit_error', 'rate_limited', 'slow_down', 'too_many_requests'],
    transient: [
      'server_error',
      'api_error',
      'internal',
      'internal_error',
      'unavailable',
      'service_unavailable',
      'deadline_exceeded',
      'timeout',
      'previous_response_not_found',
      'websocket_connection_limit_reached',
      'stream_disconnected',
      'network_error',
      // Replay safety is still the stream-outcome gate's call (classifyError).
      'malformed_stream',
    ],
    invalid_request: [
      'invalid_request',
      'invalid_request_error',
      'invalid_argument',
      'failed_precondition',
      'bad_request',
      'not_found',
      'not_found_error',
      'model_not_found',
      'unsupported_parameter',
    ],
  }).flatMap(([kind, codes]) => codes.map((code) => [code, kind]))
);
const RESOURCE_EXHAUSTED = 'resource_exhausted';
// When several typed codes are present (an envelope type plus a specific
// code), the most specific verdict wins.
const KIND_RANK = [
  'policy',
  'billing',
  'entitlement',
  'quota_exhausted',
  'context_overflow',
  'request_too_large',
  'auth',
  'permission',
  'service_tier_unavailable',
  'overloaded',
  'rate_limited',
  'transient',
  'invalid_request',
];

function codeFields(item) {
  const detail = wireDetail(item);
  return [
    detail?.code,
    detail?.type,
    detail?.status,
    item?.providerErrorCode,
    item?.code,
    item?.type,
    item?.error?.code,
    item?.error?.type,
    item?.error?.status,
    item?.error?.error?.code,
    item?.error?.error?.type,
    item?.payload?.code,
    item?.payload?.type,
    item?.payload?.error?.code,
    item?.payload?.error?.type,
    item?.geminiStatus,
    item?.status,
  ];
}

function typedCodes(chain) {
  const codes = [];
  for (const item of chain) {
    if (!item || typeof item !== 'object') continue;
    for (const field of codeFields(item)) {
      if (typeof field !== 'string') continue;
      const code = field.trim().toLowerCase();
      if (code && !codes.includes(code)) codes.push(code);
    }
  }
  return codes;
}

const VALID_STATUS = (n) => Number.isFinite(n) && n >= 100 && n <= 599;

function statusOf(err) {
  for (const value of [err?.httpStatus, err?.status, err?.statusCode, err?.response?.status]) {
    const n = Number(value);
    if (VALID_STATUS(n)) return Math.floor(n);
  }
  return 0;
}

function kindFromStatus(status) {
  if (status === 401) return 'auth';
  if (status === 402) return 'billing';
  if (status === 403) return 'permission';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limited';
  if (status === 529) return 'overloaded';
  if (status === 408 || status === 409 || status === 425) return 'transient';
  if (status === 525 || status === 526) return null;
  if (status >= 400 && status < 500) return 'invalid_request';
  if (status >= 500 && status < 600) return 'transient';
  return null;
}

function firstOf(chain, read) {
  for (const item of chain) {
    const value = item && typeof item === 'object' ? read(item) : undefined;
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function resetAtOf(err, chain) {
  const stamped = firstOf(chain, (item) => {
    const n = Number(item.resetAt);
    return Number.isFinite(n) && n > 0 ? n : null;
  });
  if (stamped != null) return stamped;
  const exhausted = Number(err?.quotaExhausted?.resetAt);
  return Number.isFinite(exhausted) && exhausted > 0 ? exhausted : null;
}

function quotaScopeOf(chain) {
  return firstOf(chain, (item) => {
    const scope = typeof item.quotaScope === 'string' ? item.quotaScope.trim().toLowerCase() : '';
    return scope === 'minute' || scope === 'day' || scope === 'plan' ? scope : null;
  });
}

// The most specific kind the typed codes name; { kind: null } when none does.
function kindFromCodes(codes, scope) {
  let kind = null;
  let code = '';
  for (const candidate of codes) {
    let candidateKind = CODE_KINDS.get(candidate) || null;
    if (candidate === RESOURCE_EXHAUSTED) {
      // Google uses one code for per-minute throttles and spent quotas; the
      // boundary names a spent quota with quotaScope day/plan. Without that
      // evidence it is a request-local rate limit.
      candidateKind = scope === 'day' || scope === 'plan' ? 'quota_exhausted' : 'rate_limited';
    }
    if (candidateKind && (kind === null || KIND_RANK.indexOf(candidateKind) < KIND_RANK.indexOf(kind))) {
      kind = candidateKind;
      code = candidate;
    }
  }
  return { kind, code };
}

/** The kind an error's typed codes alone name (no status, flag or wording); null when none does. */
export function typedCodeKind(err) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return null;
  const chain = boundedCauseChain(err);
  return kindFromCodes(typedCodes(chain), quotaScopeOf(chain)).kind;
}

function messageOf(err, chain) {
  const detail = wireDetail(err);
  return [detail?.message, err?.error?.message, ...chain.map((item) => item?.message)]
    .filter((message) => typeof message === 'string' && message)
    .join('\n');
}

/**
 * Classify a provider error into one semantic kind.
 * `options.text:false` skips the message-wording fallbacks, for retry
 * policy that must decide from typed evidence alone. `options.quotaFlags:false`
 * ignores the header-derived providerQuota / quotaExceeded flags.
 * @returns {{ kind: string, code: string, status: number, retryAfterMs: number|null, resetAt: number|null }}
 */
export function providerErrorKind(err, options = {}) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) {
    return { kind: 'unknown', code: '', status: 0, retryAfterMs: null, resetAt: null };
  }
  const chain = boundedCauseChain(err);
  const status = statusOf(err);
  const retryAfterMs = retryAfterMsFromError(err);
  const resetAt = resetAtOf(err, chain);
  const scope = quotaScopeOf(chain);
  const codes = typedCodes(chain);
  const describe = (kind, code = typedErrorCode(err)) => ({ kind, code: code || '', status, retryAfterMs, resetAt });

  // Validated account-pool evidence and boundary-stamped re-auth decide first.
  if (err.quotaExhausted && typeof err.quotaExhausted === 'object') return describe('quota_exhausted');
  if (chain.some((item) => item?.reauthRequired === true)) return describe('auth');

  let { kind, code } = kindFromCodes(codes, scope);
  // Explicit quota flags (Anthropic unified-status rejected headers) outrank a
  // generic rate-limit code or status; they never turn an overload (or a more
  // specific refusal) into quota.
  const quotaFlagged =
    options.quotaFlags !== false &&
    chain.some((item) => item?.providerQuota === true || item?.quotaExceeded === true);
  if (quotaFlagged && (!kind || kind === 'rate_limited')) kind = 'quota_exhausted';
  // Wordings, for untyped errors only (a typed code always decides).
  const text = options.text !== false && (!kind || kind === 'invalid_request') ? messageOf(err, chain) : '';
  // Capacity wording counts only on a typed 429 ("… is at capacity"): it
  // keeps such a 429 from reading as a rate limit. An untyped 5xx stays an
  // ordinary transient server fault, whatever its body says. Quota or billing
  // wording never yields a quota kind: that takes a typed code, a quota flag
  // or a quota scope (text may refine only the displayed message).
  if (!kind && !codes.length && text && status === 429 && CAPACITY_MESSAGE_RE.test(text)) kind = 'overloaded';
  // Presentation-only fallback (`legacyQuotaWording`): a fully UNTYPED error
  // (no status, code, retry advice, quota flag or scope — e.g. persisted
  // failure text) may still read as a usage limit from unambiguous wording.
  // Retry, rotation and blocking never enable it.
  if (
    options.legacyQuotaWording === true &&
    !kind &&
    !codes.length &&
    !status &&
    retryAfterMs == null &&
    !scope &&
    text
  ) {
    if (LEGACY_BILLING_MESSAGE_RE.test(text)) kind = 'billing';
    else if (LEGACY_QUOTA_MESSAGE_RE.test(text)) kind = 'quota_exhausted';
  }
  if (!kind) kind = kindFromStatus(status);
  if ((!kind || kind === 'invalid_request') && text) {
    if (TOKEN_CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(text))) kind = 'context_overflow';
    else if (REQUEST_SIZE_PATTERNS.some((re) => re.test(text))) kind = 'request_too_large';
  }
  if (!kind && transportEvidence(err, chain, status)) kind = 'transient';
  // A provider wire error event without a deterministic code is a server-side fault.
  if (!kind && (err.responseFailed != null || err.providerWireError === true)) kind = 'transient';
  kind = kind || 'unknown';
  // The quota window the server names outranks the code's default reading.
  if (scope === 'minute' && kind === 'quota_exhausted') kind = 'rate_limited';
  // A day/plan window on a rate limit is a spent quota. A resetAt alone is
  // not: rate-limit 429s carry window resets too (kept for display/cooldown).
  if (kind === 'rate_limited' && (scope === 'day' || scope === 'plan')) kind = 'quota_exhausted';
  return describe(kind, code || undefined);
}

/** Kinds whose refusal no wait or replay can change: quota, plan and billing. */
export const QUOTA_KINDS = new Set(['quota_exhausted', 'entitlement', 'billing']);
/** Kinds that are deterministic refusals of this request (never replayed as-is). */
export const DETERMINISTIC_KINDS = new Set([
  ...QUOTA_KINDS,
  'policy',
  'auth',
  'permission',
  'context_overflow',
  'request_too_large',
  'service_tier_unavailable',
  'invalid_request',
]);
