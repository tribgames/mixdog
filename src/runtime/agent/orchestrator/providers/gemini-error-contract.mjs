/**
 * gemini-error-contract.mjs — Google RPC error details → the provider error
 * contract shared by Gemini (REST + SDK) and Antigravity:
 *   status, code (lowercased), retryAfterMs (uncapped), resetAt (epoch ms),
 *   quotaScope ('minute' | 'day' | undefined).
 *
 * Details come from `error.details` (REST body) or `errorDetails` (SDK
 * GoogleGenerativeAIFetchError). Entries are google.rpc.RetryInfo,
 * QuotaFailure and ErrorInfo.
 */

const DURATION_RE = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/;
const DURATION_PART_RE = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
const DURATION_UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const BARE_SECONDS_RE = /^\d+(?:\.\d+)?$/;

// Google error classification: a per-minute quota with no RetryInfo is
// retried after one quota window.
export const GEMINI_PER_MINUTE_RETRY_MS = 60_000;

// "Please retry in 34.07s" (Gemini API) / "reset after 2h1m1s" (Cloud Code).
const MESSAGE_DELAY_RE = /(?:please retry in|reset after)\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i;
const LIMIT_ZERO_RE = /limit:\s*0(?!\d|\.\d)/i;
const CAPACITY_MESSAGE_RE = /exhausted your capacity|capacity exceeded|model_capacity_exhausted/i;
// ErrorInfo reasons that name a spent quota with no window of its own.
const TERMINAL_REASONS = new Set(['quota_exhausted', 'insufficient_g1_credits_balance']);
const CAPACITY_REASONS = new Set(['model_capacity_exhausted', 'model_capacity_exceeded']);

const GOOGLE_STATUS_HTTP = {
  INVALID_ARGUMENT: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  RESOURCE_EXHAUSTED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
};

function detailType(entry) {
  return typeof entry?.['@type'] === 'string' ? entry['@type'] : '';
}

function durationMs(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (BARE_SECONDS_RE.test(text)) return Math.ceil(Number(text) * 1000);
    if (!DURATION_RE.test(text)) return null;
    let total = 0;
    for (const [, amount, unit] of text.matchAll(DURATION_PART_RE)) total += Number(amount) * DURATION_UNIT_MS[unit];
    return Math.ceil(total);
  }
  if (value && typeof value === 'object') {
    const ms = Number(value.seconds || 0) * 1000 + Number(value.nanos || 0) / 1_000_000;
    return Number.isFinite(ms) && ms >= 0 ? Math.ceil(ms) : null;
  }
  return null;
}

// A zero wait is no advice: the caller's normal backoff (or the per-minute
// window) applies instead of an immediate re-issue.
function adviceMs(value) {
  const ms = durationMs(value);
  return ms > 0 ? ms : undefined;
}

function scopeOf(text) {
  if (/per[\s_-]?day|daily/i.test(text)) return 'day';
  if (/per[\s_-]?minute/i.test(text)) return 'minute';
  return undefined;
}

/**
 * `quotaScope` is 'minute' / 'day' from the typed quota ids only (never from
 * the length of the server's wait); 'plan' marks a spent
 * quota with no window (ErrorInfo QUOTA_EXHAUSTED, or a QuotaFailure
 * violation with a zero limit; message prose alone never counts). Capacity
 * (MODEL_CAPACITY_EXHAUSTED / "exhausted your capacity") is an overload of the
 * shared pool: code `model_capacity_exhausted`, never a quota scope.
 * @param {{ details?: unknown, errorDetails?: unknown, googleStatus?: string, message?: string }} input
 * @returns {{ code?: string, retryAfterMs?: number, resetAt?: number, quotaScope?: 'minute'|'day'|'plan' }}
 */
export function geminiErrorContract({ details, errorDetails, googleStatus, message } = {}) {
  const list = [details, errorDetails].flatMap((entry) => (Array.isArray(entry) ? entry : []));
  let reason = '';
  let retryAfterMs;
  let resetAt;
  const scopes = new Set();
  let zeroLimit = false;
  for (const entry of list) {
    const type = detailType(entry);
    if (type.endsWith('.RetryInfo') || entry?.retryDelay !== undefined) {
      retryAfterMs ??= adviceMs(entry.retryDelay);
    }
    if (type.endsWith('.QuotaFailure') || Array.isArray(entry?.violations)) {
      for (const violation of entry.violations || []) {
        const scope = scopeOf(String(violation?.quotaId || ''));
        if (scope) scopes.add(scope);
        // A spent allowance is named by the typed violation, not by prose.
        if (
          String(violation?.quotaValue ?? '').trim() === '0' ||
          LIMIT_ZERO_RE.test(String(violation?.description || ''))
        ) {
          zeroLimit = true;
        }
      }
    }
    if (type.endsWith('.ErrorInfo') || typeof entry?.reason === 'string') {
      if (!reason && typeof entry.reason === 'string') reason = entry.reason.trim().toLowerCase();
      const metadata = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
      retryAfterMs ??= adviceMs(metadata.quotaResetDelay);
      const stamp = Date.parse(String(metadata.quotaResetTimeStamp || ''));
      if (resetAt === undefined && Number.isFinite(stamp)) resetAt = stamp;
      const scope = scopeOf(
        [metadata.quotaId, metadata.quota_limit, metadata.quota_metric, entry.reason].filter(Boolean).join(' ')
      );
      if (scope) scopes.add(scope);
    }
  }
  const text = typeof message === 'string' ? message : '';
  // The message names capacity only when nothing typed said otherwise (a
  // reason, a quota id or RetryInfo outranks it, as in classifyGoogleError).
  const capacity =
    CAPACITY_REASONS.has(reason) ||
    (!reason && scopes.size === 0 && retryAfterMs === undefined && CAPACITY_MESSAGE_RE.test(text));
  // A per-day violation outlasts any per-minute one reported with it.
  let quotaScope;
  if (scopes.has('day')) quotaScope = 'day';
  else if (scopes.has('minute')) quotaScope = 'minute';
  if (retryAfterMs === undefined) {
    const named = MESSAGE_DELAY_RE.exec(text);
    if (named) retryAfterMs = adviceMs(named[1]);
  }
  // Per-minute quota with no RetryInfo: wait one quota window.
  if (retryAfterMs === undefined && quotaScope === 'minute' && !capacity) retryAfterMs = GEMINI_PER_MINUTE_RETRY_MS;
  if (resetAt === undefined && retryAfterMs !== undefined) resetAt = Date.now() + retryAfterMs;
  if (!capacity && !quotaScope && (TERMINAL_REASONS.has(reason) || zeroLimit)) quotaScope = 'plan';
  const status = typeof googleStatus === 'string' ? googleStatus.trim().toLowerCase() : '';
  const code = capacity ? 'model_capacity_exhausted' : reason || status;
  return {
    ...(code ? { code } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(quotaScope ? { quotaScope } : {}),
  };
}

/** Copy the contract fields onto `err`; an already-typed `code` is kept. */
export function applyGeminiErrorContract(err, input) {
  const { code, ...rest } = geminiErrorContract(input);
  Object.assign(err, rest);
  if (code && !(typeof err.code === 'string' && err.code)) err.code = code;
  return err;
}

/**
 * The `{ error: {...} }` envelope a Gemini/Cloud Code stream carries in-band
 * instead of an HTTP error status. Returns the typed error, or null when the
 * chunk is an ordinary payload.
 */
export function geminiInBandError(chunk, label) {
  const detail = chunk && typeof chunk === 'object' ? chunk.error : null;
  if (!detail || (typeof detail !== 'object' && typeof detail !== 'string')) return null;
  const body = typeof detail === 'object' ? detail : { message: detail };
  const googleStatus = typeof body.status === 'string' ? body.status : '';
  const status =
    Number.isFinite(Number(body.code)) && Number(body.code) > 0
      ? Number(body.code)
      : GOOGLE_STATUS_HTTP[googleStatus.toUpperCase()];
  const err = new Error(
    `${label} in-band error${status ? ` ${status}` : ''}: ${String(body.message || googleStatus || 'unknown').slice(0, 300)}`
  );
  err.name = 'GeminiInBandError';
  if (status) {
    err.status = status;
    err.httpStatus = status;
  }
  if (googleStatus) err.geminiStatus = googleStatus.toUpperCase();
  err.error = body;
  const details = body.details ?? body.errorDetails;
  if (Array.isArray(details)) err.details = details;
  return applyGeminiErrorContract(err, { details, googleStatus, message: body.message });
}

/** Throw the typed in-band error when `chunk` is an error envelope. */
export function assertNoGeminiInBandError(chunk, label) {
  const err = geminiInBandError(chunk, label);
  if (err) throw err;
}

const FINISH_KINDS = new Map(
  Object.entries({
    complete: ['STOP'],
    output_limit: ['MAX_TOKENS'],
    // Content refused by policy: deterministic, never re-asked.
    policy: [
      'SAFETY',
      'BLOCKLIST',
      'PROHIBITED_CONTENT',
      'SPII',
      'IMAGE_SAFETY',
      'IMAGE_PROHIBITED_CONTENT',
      'ESCALATION',
      'PUP_LIMITED_DISABLED',
    ],
    language: ['LANGUAGE'],
    recitation: ['RECITATION', 'IMAGE_RECITATION'],
    // The model produced no usable call: the same request is re-asked.
    invalid_tool_call: ['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'MALFORMED_RESPONSE'],
    // Tool-call terminals a re-ask cannot fix.
    tool_call: ['TOO_MANY_TOOL_CALLS', 'MISSING_THOUGHT_SIGNATURE'],
    continuation: ['CONTINUATION'],
    other: ['OTHER', 'IMAGE_OTHER', 'NO_IMAGE'],
  }).flatMap(([kind, reasons]) => reasons.map((reason) => [reason, kind]))
);

/** Finish (or `PROMPT_`-prefixed block) reason without wire prefixes. */
export function geminiNormalizeFinishReason(finishReason) {
  return String(finishReason || '')
    .replace(/^FINISH_REASON_/, '')
    .replace(/^PROMPT_/, '')
    .replace(/^BLOCK_REASON_/, '');
}

/**
 * Kind of a documented finishReason / blockReason: 'none' (absent or
 * UNSPECIFIED: the stream is unfinished), 'complete', 'output_limit',
 * 'policy', 'language', 'recitation', 'invalid_tool_call', 'tool_call',
 * 'continuation' or 'other' (OTHER and any undocumented future reason).
 */
export function geminiFinishReasonKind(finishReason) {
  const reason = geminiNormalizeFinishReason(finishReason);
  if (!reason || reason === 'UNSPECIFIED') return 'none';
  return FINISH_KINDS.get(reason) || 'other';
}

/** Policy-refusal code for a finishReason, or null for any other reason. */
export function geminiPolicyFinishCode(finishReason) {
  switch (geminiFinishReasonKind(finishReason)) {
    case 'policy':
      return 'safety';
    case 'recitation':
      return 'recitation';
    case 'language':
      return 'content_filter';
    default:
      return null;
  }
}

/**
 * Evidence a terminal response carries beyond its finishReason: candidate and
 * prompt safety ratings, the finish message, the prompt block reason and any
 * continuation token. Only present fields are returned.
 */
export function geminiFinishErrorFields(response) {
  const candidate = response?.candidates?.[0];
  const feedback = response?.promptFeedback;
  const fields = {
    finishMessage: candidate?.finishMessage,
    safetyRatings: candidate?.safetyRatings,
    blockReason: feedback?.blockReason,
    promptSafetyRatings: feedback?.safetyRatings,
    continuationToken: candidate?.continuationToken,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/**
 * Typed result for a CONTINUATION finish, which this client cannot resume
 * (Gemini direct only). Keeps the original error's partial turn and the
 * token so a caller can continue it out of band.
 */
export function geminiContinuationUnsupportedError(incomplete, response) {
  return Object.assign(incomplete, geminiFinishErrorFields(response), {
    name: 'GeminiContinuationUnsupportedError',
    code: 'CONTINUATION_UNSUPPORTED',
    continuationUnsupported: true,
    message: 'Gemini response stopped with finishReason=CONTINUATION; continuation is not supported by this client',
  });
}
