/**
 * openai-error-contract.mjs — the one place the OpenAI provider boundary
 * stamps the shared error contract onto a thrown error:
 *
 *   status / httpStatus  typed HTTP status
 *   code                 lowercased error code/type from the JSON body or wire event
 *   headers              response headers (HTTP, WS handshake, nested error.headers)
 *   retryAfterMs         server advice, uncapped (Retry-After / Retry-After-Ms)
 *   resetAt              epoch ms from quota reset fields (resets_at, resets_in_seconds)
 *
 * Pure: no I/O. Message text is never parsed for status or code.
 */
import { retryAfterMsFromError, sleepWithAbort } from './retry-classifier.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Parse an HTTP error body ONCE into its contract fields. `message` is the
 * body's own message (untruncated); callers truncate for diagnostics.
 */
export function parseErrorBody(text) {
  let json = null;
  try {
    json = JSON.parse(String(text || ''));
  } catch {}
  const error = isObject(json?.error) ? json.error : isObject(json) ? json : null;
  const rawCode = error?.code ?? error?.type ?? (typeof json?.error === 'string' ? json.error : null);
  const code = typeof rawCode === 'string' && rawCode.trim() ? rawCode.trim().toLowerCase() : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  return { json, error, code, message };
}

function epochMsFrom(value) {
  if (typeof value === 'string' && value.trim() && !Number.isFinite(Number(value))) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Epoch seconds (the wire form) vs epoch milliseconds.
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/** Absolute quota reset time (epoch ms) from the first source carrying one; 0 when none. */
export function resetAtFrom(...sources) {
  for (const source of sources) {
    if (!isObject(source)) continue;
    const absolute = epochMsFrom(source.resets_at ?? source.reset_at ?? source.resetsAt);
    if (absolute) return absolute;
    const inSeconds = Number(source.resets_in_seconds ?? source.reset_in_seconds);
    if (Number.isFinite(inSeconds) && inSeconds > 0) return Date.now() + Math.round(inSeconds * 1000);
  }
  return 0;
}

// ── User-facing messages for typed wire errors ───────────────────────────────
const QUOTA_EXCEEDED_MESSAGE = 'Quota exceeded. Check your plan and billing details.';
const USAGE_NOT_INCLUDED_MESSAGE =
  'To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.';
const SERVER_OVERLOADED_MESSAGE = 'Selected model is at capacity. Please try a different model.';
const WS_CONNECTION_LIMIT_MESSAGE =
  'Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.';
const PREVIOUS_RESPONSE_NOT_FOUND_MESSAGE = 'Previous response was not found. Retrying the full request.';
const QUOTA_EXCEEDED_CODES = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
]);
// Wire codes whose own message is empty fall back to this copy.
const FALLBACK_MESSAGES = Object.freeze({
  websocket_connection_limit_reached: WS_CONNECTION_LIMIT_MESSAGE,
  previous_response_not_found: PREVIOUS_RESPONSE_NOT_FOUND_MESSAGE,
});

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  if (typeof headers.get === 'function') return String(headers.get(name) ?? '').trim();
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return String(Array.isArray(value) ? value[0] : (value ?? '')).trim();
  }
  return '';
}

function ordinalSuffix(day) {
  if (day >= 11 && day <= 13) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th';
}

/** Retry timestamp: "3:04 PM" today, else "Mar 5th, 2026 3:04 PM" (local time). */
export function formatRetryTimestamp(resetsAtMs, now = Date.now()) {
  const reset = new Date(resetsAtMs);
  const time = reset.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (reset.toDateString() === new Date(now).toDateString()) return time;
  const month = reset.toLocaleDateString('en-US', { month: 'short' });
  return `${month} ${reset.getDate()}${ordinalSuffix(reset.getDate())}, ${reset.getFullYear()} ${time}`;
}

const WORKSPACE_REACHED_MESSAGES = Object.freeze({
  workspace_owner_credits_depleted: 'Your workspace is out of credits. Add credits to continue.',
  workspace_member_credits_depleted:
    'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.',
  workspace_owner_usage_limit_reached:
    'You hit your spend cap set in your workspace. Increase your spend cap to continue.',
  workspace_member_usage_limit_reached:
    'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.',
});
const PRO_PLANS = new Set(['pro', 'prolite', 'promax']);
const ADMIN_PLANS = new Set([
  'team',
  'self_serve_business_prolite',
  'self_serve_business_usage_based',
  'business',
  'ent26',
  'enterprise_cbp_automation',
  'enterprise_cbp_usage_based',
]);

/**
 * Usage-limit copy: per-limit name first, then workspace
 * credits / spend cap, then the promo message, then the plan upgrade copy.
 * @param {{planType?: string, resetsAtMs?: number, promo?: string, reachedType?: string, limitName?: string, now?: number}} f
 */
export function usageLimitMessage({ planType, resetsAtMs, promo, reachedType, limitName, now } = {}) {
  const at = resetsAtMs ? formatRetryTimestamp(resetsAtMs, now) : '';
  const suffix = at ? ` Try again at ${at}.` : ' Try again later.';
  const suffixOr = at ? ` or try again at ${at}.` : ' or try again later.';
  const name = String(limitName || '').trim();
  if (name && !/^(codex|gpt-reserve)$/i.test(name)) {
    return `You’ve hit your usage limit for ${name}. Switch to another model now,${suffixOr}`;
  }
  const workspace = WORKSPACE_REACHED_MESSAGES[String(reachedType || '').toLowerCase()];
  if (workspace) return workspace;
  if (promo) return `You’ve hit your usage limit. ${promo},${suffixOr}`;
  const plan = String(planType || '').toLowerCase();
  if (plan === 'plus') {
    return `You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits${suffixOr}`;
  }
  if (ADMIN_PLANS.has(plan)) {
    return `You’ve hit your usage limit. To get more access now, send a request to your admin${suffixOr}`;
  }
  if (plan === 'free' || plan === 'go') {
    return `You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus),${suffixOr}`;
  }
  if (PRO_PLANS.has(plan)) {
    return `You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits${suffixOr}`;
  }
  return `You’ve hit your usage limit.${suffix}`;
}

/** The user-facing copy for a typed wire error, or '' when none applies. */
function typedWireErrorMessage({ code, type, error, headers, resetAt }) {
  if (type === 'usage_limit_reached' || code === 'usage_limit_reached') {
    const limitId = headerValue(headers, 'x-codex-active-limit').toLowerCase().replace(/_/g, '-');
    return usageLimitMessage({
      planType: error?.plan_type,
      resetsAtMs: resetAt,
      promo: headerValue(headers, 'x-codex-promo-message'),
      reachedType: headerValue(headers, 'x-codex-rate-limit-reached-type'),
      limitName: limitId ? headerValue(headers, `x-${limitId}-limit-name`) : '',
    });
  }
  if (type === 'usage_not_included' || code === 'usage_not_included') return USAGE_NOT_INCLUDED_MESSAGE;
  if (QUOTA_EXCEEDED_CODES.has(code) || type === 'insufficient_quota') return QUOTA_EXCEEDED_MESSAGE;
  if (code === 'server_is_overloaded') return SERVER_OVERLOADED_MESSAGE;
  const fallback = FALLBACK_MESSAGES[code];
  return fallback && !String(error?.message || '').trim() ? fallback : '';
}

// Swap the server's own text inside `err.message` for the mapped copy; the
// original stays on providerError. `userMessage` always carries the copy.
function applyTypedWireMessage(err, mapped, original) {
  err.userMessage = mapped;
  const current = String(err.message || '');
  const raw = String(original || '');
  for (const needle of [raw, raw.slice(0, 200)]) {
    if (needle && current.endsWith(needle)) {
      err.message = current.slice(0, current.length - needle.length) + mapped;
      return;
    }
  }
  if (!raw && current) err.message = `${current}: ${mapped}`;
}
/**
 * Stamp the contract onto `err`. Every field is optional input; only the
 * ones present are written, and a field already on `err` is never replaced
 * by an absent one.
 *
 * @param {Error} err
 * @param {object} src
 * @param {number} [src.status]
 * @param {object} [src.headers]     Headers or plain object
 * @param {string} [src.code]        already-lowercased code
 * @param {object} [src.error]       parsed error object (code/type/resets_at/headers)
 * @param {object} [src.event]       wire event the error was built from
 */
export function applyErrorContract(err, { status, headers, code, error, event } = {}) {
  try {
    const n = Number(status);
    if (Number.isFinite(n) && n >= 100 && n <= 599) {
      err.status = n;
      err.httpStatus = n;
    }
    const wireHeaders = headers ?? error?.headers ?? event?.error?.headers ?? event?.response?.error?.headers ?? event?.headers;
    if (wireHeaders && typeof wireHeaders === 'object') err.headers = wireHeaders;
    const rawCode = code ?? error?.code ?? error?.type ?? null;
    if (typeof rawCode === 'string' && rawCode.trim()) err.code = rawCode.trim().toLowerCase();
    const resetAt = resetAtFrom(error, event?.error, event?.response?.error, event);
    if (resetAt) err.resetAt = resetAt;
    const retryAfterMs = retryAfterMsFromError(err);
    if (retryAfterMs != null) {
      err.retryAfterMs = retryAfterMs;
      // Server advice is a deadline captured once, so a
      // later transport switch cannot restart or skip it.
      if (err.retryAfterAt == null) err.retryAfterAt = Date.now() + retryAfterMs;
    }
    const type = typeof error?.type === 'string' ? error.type.trim().toLowerCase() : '';
    const mapped = typedWireErrorMessage({ code: err.code || '', type, error, headers: err.headers, resetAt: err.resetAt });
    if (mapped) applyTypedWireMessage(err, mapped, error?.message);
  } catch {}
  return err;
}

/**
 * A response.incomplete with reason `content_filter` is a policy refusal:
 * type it so no layer mistakes it for a transient or untyped failure. The
 * wire event is deliberately NOT attached as `responseFailed` (that marker
 * makes unknown codes default-retryable).
 */
export function markContentFilter(err, reason) {
  if (String(reason || '').trim().toLowerCase() !== 'content_filter') return err;
  err.code = 'content_filter';
  err.providerErrorCode = 'content_filter';
  return err;
}

/**
 * The error for a non-2xx HTTP response whose body has been read as `text`.
 * The message carries a bounded diagnostic; the structured fields come from
 * the full parsed body.
 */
export function httpResponseError({ label, status, headers, text, initialResponse = false, diagnosticLimit = 200 }) {
  const parsed = parseErrorBody(text);
  const diagnostic = (parsed.message || String(text || '')).slice(0, diagnosticLimit);
  const err = new Error(diagnostic ? `${label} ${status}: ${diagnostic}` : `${label} ${status}`);
  if (initialResponse) err.initialResponseError = true;
  if (parsed.error) err.providerError = parsed.error;
  if (parsed.code) err.providerErrorCode = parsed.code;
  return applyErrorContract(err, { status, headers, code: parsed.code, error: parsed.error, event: parsed.json });
}

// The route decides the HTTP/SSE label: the api-key `openai` provider is not OAuth.
export const httpLabel = (auth) => (auth?.type === 'openai-direct' ? 'OpenAI HTTP fallback' : 'OpenAI OAuth HTTP fallback');

/**
 * Changing transport must not bypass the server's retry deadline.
 * Sleeps until the deadline the failed attempt captured (abortable).
 */
export async function waitForRetryDeadline(err, externalSignal, sleepFn) {
  // retryAfterMsFromError reports what is left of the captured retryAfterAt.
  const remaining = retryAfterMsFromError(err) ?? 0;
  if (!(remaining > 0)) return;
  await sleepWithAbort(remaining, externalSignal, sleepFn, 'OpenAI transport fallback wait aborted');
}
