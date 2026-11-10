/**
 * Upstream failure translation for media lanes.
 *
 * A credential can be present and still unusable (exhausted credits, billing
 * caps, per-account gating). Those come back as raw provider JSON, so the lane
 * maps them to one legible sentence instead of leaking a wall of upstream text
 * into the Studio.
 */
import { mediaError } from './lanes.mjs';

const CREDIT_HINTS = /credit|spending limit|billing|quota|insufficient|payment/i;
// Subscription usage caps (ChatGPT plan windows), as opposed to short-lived
// rate limiting: retrying in a moment does not help until the window resets.
const USAGE_LIMIT = /usage_?limit/i;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function reason(text) {
  const parsed = parseJson(text);
  const message = parsed?.error?.message || parsed?.error || parsed?.message;
  return typeof message === 'string' ? message : '';
}

// Raw bodies are only echoed when they are short plain text; HTML error pages
// and other markup never reach the Studio.
function rawDetail(text) {
  const raw = String(text || '').trim();
  return raw && !raw.startsWith('<') ? raw.slice(0, 300) : '';
}

/** Build the error a lane throws for a non-OK upstream response. */
export function upstreamError(label, status, text) {
  const detail = reason(text) || rawDetail(text);
  if (status === 401 || status === 403) {
    if (CREDIT_HINTS.test(detail)) {
      return mediaError(`${label}: account has no usable balance — ${detail}`, 'MEDIA_BILLING_BLOCKED', status);
    }
    return mediaError(
      `${label}: authentication rejected — sign in again in Settings → Providers`,
      'MEDIA_AUTH_REJECTED',
      status
    );
  }
  if (status === 402 || CREDIT_HINTS.test(detail)) {
    return mediaError(`${label}: account has no usable balance — ${detail}`, 'MEDIA_BILLING_BLOCKED', status || 402);
  }
  if (status === 429) {
    return mediaError(`${label}: rate limited — retry in a moment`, 'MEDIA_RATE_LIMITED', 429);
  }
  return mediaError(`${label} failed (${status})${detail ? `: ${detail}` : ''}`, 'MEDIA_UPSTREAM_FAILED', status);
}

const header = (headers, name) => String(headers?.get?.(name) || '').trim();
const epochSeconds = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : 0);

// Latest reset among the exhausted windows advertised in the rate-limit
// headers. The family is named after the active limit, with the plain codex
// family as the fallback the backend also sends.
function headerResetAt(headers, limitId) {
  const families = new Set([limitId && `x-${limitId.toLowerCase().replace(/_/g, '-')}`, 'x-codex'].filter(Boolean));
  let latest = 0;
  for (const family of families) {
    for (const window of ['primary', 'secondary']) {
      const used = Number(header(headers, `${family}-${window}-used-percent`));
      const resetAt = epochSeconds(header(headers, `${family}-${window}-reset-at`));
      if (used >= 100 && resetAt > latest) latest = resetAt;
    }
  }
  return latest || null;
}

/**
 * Recognize a subscription usage-limit failure. `error` is the upstream error
 * object (`{ type, code, resets_at }`), from an HTTP body or a stream event.
 * Returns `{ limitId, resetsAt }` (epoch seconds or null), or null when the
 * failure is something else.
 */
export function usageLimitInfo(error, headers) {
  const kinds = [error?.type, error?.code, header(headers, 'x-codex-rate-limit-reached-type')];
  if (!kinds.some((kind) => typeof kind === 'string' && USAGE_LIMIT.test(kind))) return null;
  const limitId = header(headers, 'x-codex-active-limit') || String(error?.limit_id || error?.metered_feature || '');
  return { limitId, resetsAt: epochSeconds(error?.resets_at) || headerResetAt(headers, limitId) };
}

/** usageLimitInfo for a non-OK HTTP response; only 429s are usage limits. */
export function usageLimitFromResponse(status, text, headers) {
  if (status !== 429) return null;
  const parsed = parseJson(text);
  return usageLimitInfo(parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed, headers);
}

function formatResetAt(seconds) {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The error a lane throws when the subscription's usage window is exhausted. */
export function usageLimitError(label, { limitId = '', resetsAt = null } = {}) {
  const what = /image/i.test(limitId) ? 'image generation usage limit reached' : 'usage limit reached';
  const when = resetsAt ? `resets ${formatResetAt(resetsAt)}` : 'try again after the usage window resets';
  const err = mediaError(`${label}: ${what} — ${when}`, 'MEDIA_USAGE_LIMIT', 429);
  if (resetsAt) err.resetsAt = new Date(resetsAt * 1000).toISOString();
  return err;
}
