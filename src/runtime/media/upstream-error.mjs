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

function reason(text) {
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message || parsed?.error || parsed?.message;
    return typeof message === 'string' ? message : '';
  } catch {
    return '';
  }
}

/** Build the error a lane throws for a non-OK upstream response. */
export function upstreamError(label, status, text) {
  const detail = reason(text) || String(text || '').slice(0, 300);
  if (status === 401 || status === 403) {
    if (CREDIT_HINTS.test(detail)) {
      return mediaError(`${label}: account has no usable balance — ${detail}`, 'MEDIA_BILLING_BLOCKED', status);
    }
    return mediaError(`${label}: authentication rejected — sign in again in Settings → Providers`, 'MEDIA_AUTH_REJECTED', status);
  }
  if (status === 402 || CREDIT_HINTS.test(detail)) {
    return mediaError(`${label}: account has no usable balance — ${detail}`, 'MEDIA_BILLING_BLOCKED', status || 402);
  }
  if (status === 429) {
    return mediaError(`${label}: rate limited — retry in a moment`, 'MEDIA_RATE_LIMITED', 429);
  }
  return mediaError(`${label} failed (${status})${detail ? `: ${detail}` : ''}`, 'MEDIA_UPSTREAM_FAILED', status);
}
