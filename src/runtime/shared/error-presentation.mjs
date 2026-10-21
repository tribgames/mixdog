import { PROVIDER_ERROR_KINDS, providerErrorKind } from '../agent/orchestrator/providers/provider-error-kind.mjs';
import { transportErrorText } from './transport-error-text.mjs';

const DETAILS_LIMIT = 12_000;
const SUMMARY_LIMIT = 180;
// "<wrapper>: The latest message cannot fit this model (CODE): <sizes>. <cause and remedy>"
const LATEST_TURN_RE =
  /The latest message cannot fit this model \(LATEST_TURN_EXCEEDS_CONTEXT\)(: it needs about [\d,]+ tokens, but the [^.]* window leaves [\d,]+ for it\.)([\s\S]*)$/;

/** Diagnostic text must be safe before it reaches a view, copy button or log. */
export function safeErrorDetails(value) {
  let text = String(value ?? '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escape sequences (ESC) from diagnostic text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\b((?:https?|ssh):\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/([?&](?:token|access_token|refresh_token|api_key|key|code|signature|sig)=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|client_secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1[redacted]'
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      '[redacted]'
    )
    .replace(/data:[\w.+/-]+;base64,[A-Za-z0-9+/=\s]+/g, '[image data]')
    .replace(/(["']data["']\s*:\s*["'])[A-Za-z0-9+/=]{256,}(["'])/g, '$1[image data]$2')
    .trim();
  if (text.length > DETAILS_LIMIT) text = `${text.slice(0, DETAILS_LIMIT)}\n…`;
  return text;
}

function messageOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if (typeof value.message === 'string') return value.message;
    if (typeof value.detail === 'string') return value.detail;
    try {
      return JSON.stringify(value);
    } catch {
      return 'Unknown error';
    }
  }
  return value == null ? '' : String(value);
}

function unwrap(value) {
  const raw = messageOf(value).trim();
  const start = raw.indexOf('{');
  let parsed;
  if (start >= 0) {
    try {
      parsed = JSON.parse(raw.slice(start));
    } catch {
      /* not a JSON envelope */
    }
  }
  const envelope = parsed && typeof parsed === 'object' ? parsed : value;
  const nested = envelope?.error;
  const stringOrNull = (value) => (typeof value === 'string' ? value : null);
  const message = stringOrNull(nested) ?? stringOrNull(nested?.message) ?? stringOrNull(envelope?.message) ?? raw;
  const status = Number(
    value?.httpStatus ||
      value?.status ||
      value?.response?.status ||
      envelope?.status ||
      /\b(?:API|HTTP(?: fallback)?)\s+([45]\d\d)\b/i.exec(raw)?.[1] ||
      0
  );
  const code = String(nested?.code || nested?.type || envelope?.code || '');
  return { raw, message, status, code };
}

/** A 429 the provider sent without quota headers: a refusal, not an exhausted limit. */
export function isRejected429(value) {
  return /\bAPI 429 request rejected\b/.test(messageOf(value));
}

// Provider kind → presentation. Summaries are also the persisted form of a
// failure, so each maps back to its kind when only the text survives.
const KIND_COPY = {
  overloaded: ['overloaded', 'The provider is busy right now.', 'Try again later or choose another model.'],
  rate_limited: ['rate-limit', 'The provider is temporarily rate-limiting requests.', 'Try again shortly.'],
  quota_exhausted: [
    'quota',
    'The provider usage limit was reached.',
    'Wait for the limit to reset or choose another account.',
  ],
  entitlement: [
    'entitlement',
    "This model isn't included in your plan.",
    'Upgrade your plan, or choose another model or provider.',
  ],
  billing: [
    'billing',
    'The provider account is out of credits or at its spend limit.',
    'Check your billing with the provider, then try again.',
  ],
  permission: [
    'permission',
    "You don't have access to this resource.",
    'Check your account permissions, or choose another model.',
  ],
  context_overflow: [
    'context-overflow',
    'The conversation is too long for this model.',
    'Compact the conversation or start a new one.',
  ],
  request_too_large: [
    'payload-size',
    'The request exceeds the size limit.',
    'Reduce the attachments or request size, then try again.',
  ],
  policy: [
    'policy',
    'The provider refused this request under its safety policy.',
    'Rephrase the request or choose another model.',
  ],
  service_tier_unavailable: [
    'service-tier',
    'The requested service tier is unavailable right now.',
    'Switch to the standard tier or try again later.',
  ],
};
const SUMMARY_KINDS = new Map(Object.entries(KIND_COPY).map(([providerKind, [, summary]]) => [summary, providerKind]));

function waitLabel(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

/** Local HH:mm, prefixed with month/day when the reset is not today. */
function resetLabel(resetAt) {
  const reset = new Date(resetAt);
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(reset.getHours())}:${pad(reset.getMinutes())}`;
  return reset.toDateString() === new Date().toDateString()
    ? time
    : `${reset.getMonth() + 1}/${reset.getDate()} ${time}`;
}

// A refused request that names its model as unknown, retired or not offered
// to this account. Read only for request-refusal kinds, so a typed overload,
// quota or auth failure never reads as a missing model.
const MODEL_REFUSAL_KINDS = new Set(['invalid_request', 'permission', 'unknown']);
const MODEL_UNAVAILABLE_CODES = new Set(['model_not_found', 'model_not_supported']);
// The model must be the subject of the refusal, at the start of a line or
// sentence ("The model `x` does not exist", "models/x is not found", Ollama's
// `model "x" not found`), or the refusal names it ("Unknown model", "… is not
// a valid model ID", Anthropic's bare "model: x"). A model merely mentioned
// beside some other missing thing ("For model x, tool lookup: route not
// found") does not count.
const MODEL_REFUSAL_PREDICATE =
  "(?:(?:is|was|has been)\\s+)?(?:not found|does not exist|doesn'?t exist|not (?:supported|available)|(?:currently\\s+)?unavailable|no longer (?:available|supported)|deprecated|retired|removed)\\b";
const SENTENCE_START = '(?:^|[.:;!]\\s+)';
const MODEL_UNAVAILABLE_RE = new RegExp(
  [
    // "The model `x` does not exist", "models/x is not found", Vertex
    // "Publisher Model `…` was not found", Ollama `model "x" not found`.
    `${SENTENCE_START}(?:(?:the|this|that|requested|selected|publisher)\\s+)*models?(?:\\/\\S+|\\s+[\`'"]?[\\w./:@-]+[\`'"]?)?\\s+${MODEL_REFUSAL_PREDICATE}`,
    // OpenAI "The 'gpt-x' model is not supported when using Codex …".
    `${SENTENCE_START}(?:the\\s+)?[\`'"][^\`'"\\n]+[\`'"]\\s+model\\s+${MODEL_REFUSAL_PREDICATE}`,
    `${SENTENCE_START}(?:unknown|invalid|unsupported) model\\b`,
    // OpenRouter: no provider serves this model id.
    `${SENTENCE_START}no endpoints found for [\\w.-]+\\/[\\w.:-]+`,
    '\\bis not a valid model\\b',
    '^model: \\S+$',
  ].join('|'),
  'im'
);

/**
 * True when `error` (or its text) says the requested model is unknown,
 * retired or not offered to this account: a typed model code, or provider
 * wording with the model as the subject of the refusal.
 */
export function namesUnavailableModel(error) {
  if (!error) return false;
  if (typeof error === 'string') return MODEL_UNAVAILABLE_RE.test(error);
  const codes = [error.code, error.providerErrorCode, error.error?.code, error.providerError?.code];
  if (codes.some((code) => MODEL_UNAVAILABLE_CODES.has(String(code || '').toLowerCase()))) return true;
  return [error.message, error.error?.message, error.providerError?.message, error.detail]
    .filter((text) => typeof text === 'string' && text)
    .some((text) => MODEL_UNAVAILABLE_RE.test(text));
}
const MODEL_UNAVAILABLE_COPY = [
  'model-unavailable',
  "This model isn't available for this account.",
  'Choose another model, or check the model and endpoint in Providers.',
];
const NOT_FOUND_SUMMARY = "The provider couldn't find the requested model or endpoint.";
// A tool definition the provider's schema validator refused (an MCP or custom
// tool schema), named by the field path or wording each API uses.
const TOOL_SCHEMA_RE =
  /invalid schema for (?:function|tool)\b|\btools\.\d+\.(?:custom\.)?input_schema\b|\bfunction_declarations\[\d+\]\.parameters\b|\btools\[\d+\]\.function\.parameters\b|\binvalid (?:tool|function) (?:schema|parameters|definition)\b/i;
const TOOL_SCHEMA_COPY = [
  'tool-schema',
  'The provider rejected a tool definition.',
  'Disable the tool or MCP server named in the details, then try again.',
];

// The first line of a provider message worth showing as-is; '' for a stack
// frame, a markup page or a raw JSON body.
function firstReadableLine(clean) {
  const lines = clean
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines.find((line) => !/^at\s|^\{|^<!doctype|^<html/i.test(line)) || '';
  return first && !/^[{[]|^<|(?:API|HTTP)\s+[45]\d\d.*[<{]/i.test(first) ? first : '';
}

// Only legacy items (no persisted descriptor) and untyped strings reach this.
const LEGACY_TEXT_KINDS = [
  [/The provider usage limit was reached|quota.*(?:hit|exceed)|usage limit/i, 'quota_exhausted'],
  [/rate[_ -]?limit|too many requests/i, 'rate_limited'],
];

/**
 * The provider kind descriptor: the persisted one, else typed evidence, else
 * wording. `typed` is true when the kind came from a persisted descriptor or a
 * typed error: wording heuristics must then never override it.
 */
function classify(value, raw, clean, status, code) {
  const persisted = value?.errorKind;
  if (persisted && PROVIDER_ERROR_KINDS.includes(persisted.kind)) {
    return { descriptor: persisted, typed: persisted.kind !== 'unknown' };
  }
  const hasTypedFields =
    value &&
    typeof value === 'object' &&
    Boolean(value.status || value.httpStatus || value.response?.status || value.code || value.retryAfterMs);
  if (!hasTypedFields) {
    // Legacy persisted strings: their wording (and wait) is the only evidence.
    const legacy = SUMMARY_KINDS.get(clean) ?? LEGACY_TEXT_KINDS.find(([re]) => re.test(clean))?.[1];
    if (legacy) {
      const wait = /retryAfter=(\d+)(ms|s|m)\b/i.exec(raw);
      const retryAfterMs = wait ? Number(wait[1]) * { ms: 1, s: 1000, m: 60_000 }[wait[2].toLowerCase()] : undefined;
      return { descriptor: { kind: legacy, ...(retryAfterMs ? { retryAfterMs } : {}) }, typed: false };
    }
  }
  let descriptor = value && typeof value === 'object' ? providerErrorKind(value) : null;
  const typed = Boolean(descriptor) && descriptor.kind !== 'unknown';
  if (!descriptor || descriptor.kind === 'unknown') {
    descriptor = providerErrorKind(
      Object.assign(new Error(raw), { ...(status ? { status } : {}), ...(code ? { code } : {}) })
    );
  }
  if (descriptor.kind === 'unknown') {
    const known = SUMMARY_KINDS.get(clean);
    const legacy = known ?? LEGACY_TEXT_KINDS.find(([re]) => re.test(clean))?.[1];
    if (legacy) return { descriptor: { ...descriptor, kind: legacy }, typed: false };
  }
  return { descriptor, typed };
}

/** Presentation only: never changes retry policy or the underlying failure. */
export function describeError(value) {
  const { raw, message, status: textStatus, code: textCode } = unwrap(value);
  const details = safeErrorDetails(raw);
  const clean = safeErrorDetails(message)
    .replace(/^(?:Error invoking remote method ['"][^'"]+['"]:\s*)?(?:Error:\s*)?/i, '')
    .trim();
  const { descriptor, typed } = classify(value, raw, clean, textStatus, textCode);
  // A typed or persisted kind owns the verdict: its own status and code stand
  // in for the text-derived ones, and wording below may only refine it.
  const status = typed ? Number(descriptor.status) || 0 : textStatus;
  const code = typed ? String(descriptor.code || '') : textCode;
  // A 429 refusal without quota headers refines a rate limit, nothing else.
  const rejected429 = isRejected429(value) && (!typed || descriptor.kind === 'rate_limited');
  const copy = KIND_COPY[descriptor.kind];
  const retryAfterMs = Number(descriptor.retryAfterMs) > 0 ? Number(descriptor.retryAfterMs) : null;
  const resetAt = Number(descriptor.resetAt) > 0 ? Number(descriptor.resetAt) : null;
  let kind = 'unknown';
  let summary = '';
  let recovery = '';
  // Localization hook: a recovery that carries a value is given as a template.
  let recoveryTemplate = '';
  let params = null;
  // A persisted descriptor keeps the status and errno code, not the cause
  // chain: rebuild the transport evidence from them. Wording only reads for
  // untyped failures and transient ones (a bare "fetch failed" is that evidence).
  const transport =
    transportErrorText(value) ||
    (typed && transportErrorText({ code: code.toUpperCase(), status })) ||
    (!typed || descriptor.kind === 'transient' ? transportErrorText(raw) : null);
  if (
    value?.reauthRequired === true ||
    (!typed &&
      /invalid_grant|refresh token (?:expired|revoked|not available)|sign in again|sign-in expired|Reauth Required/i.test(
        raw
      ))
  ) {
    kind = 'reauth';
    summary = 'Sign-in expired.';
    recovery = 'Sign in again from Providers.';
  } else if (
    descriptor.kind === 'auth' ||
    (descriptor.kind === 'unknown' &&
      /\b(?:invalid|expired)\s+(?:api[ _-]?key|access token|credentials?)\b|Provider authentication failed/i.test(
        clean
      ))
  ) {
    kind = 'authentication';
    summary = 'Provider authentication failed';
    recovery = 'Check your sign-in or API key, then try again.';
  } else if (rejected429) {
    kind = 'request';
    summary = 'The provider rejected this request.';
    recovery = 'Review the request details before trying again.';
  } else if (
    ['invalid_request', 'unknown', 'request_too_large'].includes(descriptor.kind) &&
    /image.*dimensions.*exceed|image.*(?:too large|maximum.*(?:size|dimension))|many-image requests|An attached image exceeds the provider limit/i.test(
      clean
    )
  ) {
    kind = 'image-size';
    summary = 'An attached image exceeds the provider limit.';
    recovery = 'Reduce the image dimensions or number of images, then try again.';
  } else if (
    clean === MODEL_UNAVAILABLE_COPY[1] ||
    (MODEL_REFUSAL_KINDS.has(descriptor.kind) &&
      (MODEL_UNAVAILABLE_CODES.has(code) || MODEL_UNAVAILABLE_RE.test(clean)))
  ) {
    [kind, summary, recovery] = MODEL_UNAVAILABLE_COPY;
  } else if (
    clean === TOOL_SCHEMA_COPY[1] ||
    (['invalid_request', 'unknown'].includes(descriptor.kind) && TOOL_SCHEMA_RE.test(clean))
  ) {
    [kind, summary, recovery] = TOOL_SCHEMA_COPY;
  } else if (
    clean === NOT_FOUND_SUMMARY ||
    (MODEL_REFUSAL_KINDS.has(descriptor.kind) && (status === 404 || status === 410))
  ) {
    // The provider's own words name what is missing; the next step is the same.
    kind = 'not-found';
    summary = firstReadableLine(clean) || NOT_FOUND_SUMMARY;
    recovery = MODEL_UNAVAILABLE_COPY[2];
  } else if (LATEST_TURN_RE.test(clean)) {
    // The latest message cannot fit the window (compact/runner.mjs): the
    // sizes are the headline, the cause and remedy the next step.
    const [, headline, rest] = LATEST_TURN_RE.exec(clean);
    kind = 'latest-turn-size';
    summary = `The latest message cannot fit this model${headline}`;
    recovery = rest.trim();
  } else if (
    descriptor.kind === 'unknown' &&
    /payload too large|request (?:body )?too large|The request exceeds the size limit/i.test(clean)
  ) {
    [kind, summary, recovery] = KIND_COPY.request_too_large;
  } else if (copy) {
    [kind, summary, recovery] = copy;
    if (descriptor.kind === 'rate_limited' && retryAfterMs) {
      recovery = `Try again in ${waitLabel(retryAfterMs)}.`;
      recoveryTemplate = 'Try again in {{wait}}.';
      params = { wait: waitLabel(retryAfterMs) };
    } else if (descriptor.kind === 'quota_exhausted' && resetAt) {
      recovery = `It resets at ${resetLabel(resetAt)}. Switch accounts or providers to continue now.`;
      recoveryTemplate = 'It resets at {{time}}. Switch accounts or providers to continue now.';
      params = { time: resetLabel(resetAt) };
    }
  } else if (transport) {
    kind = 'connection';
    summary = transport.replace(/\.$/, '');
    recovery = 'Check the connection, then try again.';
  } else if (
    rejected429 ||
    status === 400 ||
    status === 422 ||
    code === 'invalid_request_error' ||
    clean === 'The provider rejected this request.'
  ) {
    kind = 'request';
    summary = 'The provider rejected this request.';
    recovery = 'Review the request details before trying again.';
  } else {
    summary = firstReadableLine(clean) || 'Something went wrong.';
  }
  summary = summary.replace(/\s+/g, ' ').trim() || 'Something went wrong.';
  if (summary.length > SUMMARY_LIMIT) summary = `${summary.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…`;
  const fingerprintStatus = kind === 'reauth' ? '' : status || '';
  return {
    kind,
    summary,
    recovery,
    recoveryTemplate,
    params,
    providerKind: descriptor.kind,
    resetAt,
    retryAfterMs,
    details,
    // Known structured failures ignore volatile indexes; unknown failures
    // retain their diagnostic identity rather than merging unrelated work.
    fingerprint: kind === 'unknown' ? details : `${kind}:${fingerprintStatus}`,
  };
}
