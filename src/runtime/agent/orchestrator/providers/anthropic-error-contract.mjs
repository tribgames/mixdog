/**
 * anthropic-error-contract.mjs — the fields every error thrown at an Anthropic
 * provider boundary carries, so the shared core never has to re-derive them
 * from message text:
 *
 *   status / httpStatus  the HTTP status
 *   code                 the lowercased Anthropic error type (`rate_limit_error`,
 *                        `overloaded_error`, ...); a 413 is always
 *                        `request_too_large` (a byte/media size refusal), which
 *                        stays distinct from a 400 `invalid_request_error`
 *                        "prompt is too long" (a token-count refusal)
 *   headers              the response headers, preserved as received
 *   retryAfterMs         the server's Retry-After / retry-after-ms window, uncapped
 *   resetAt              epoch ms of anthropic-ratelimit-unified-reset, uncapped
 */
import { headerValue, retryAfterMsFromError } from './retry-classification.mjs';

const RESET_HEADER = 'anthropic-ratelimit-unified-reset';
const REQUEST_TOO_LARGE = 'request_too_large';

// Anthropic's documented error-type enumeration by status, used only when the
// body names no type of its own.
const STATUS_ERROR_TYPE = new Map([
  [400, 'invalid_request_error'],
  [401, 'authentication_error'],
  [403, 'permission_error'],
  [404, 'not_found_error'],
  [409, 'conflict_error'],
  [413, REQUEST_TOO_LARGE],
  [429, 'rate_limit_error'],
  [500, 'api_error'],
  [504, 'timeout_error'],
  [529, 'overloaded_error'],
]);

const BODY_TYPE_RE = /"error"\s*:\s*\{\s*"type"\s*:\s*"([A-Za-z_]+)"/;

function present(value) {
  return value != null && value !== '';
}

function lowered(value) {
  return typeof value === 'string' && value.trim() && value.trim() !== 'error' ? value.trim().toLowerCase() : '';
}

/** The lowercased error type named by an Anthropic error body (JSON text or parsed object). */
export function anthropicErrorTypeFromBody(body) {
  if (body && typeof body === 'object') return lowered((body.error && body.error.type) || body.type);
  const match = BODY_TYPE_RE.exec(String(body || ''));
  return match ? lowered(match[1]) : '';
}

/** Retry-After / retry-after-ms in ms, uncapped; null when the server sent neither. */
export function retryAfterMsFromHeaders(headers) {
  if (!present(headerValue(headers, 'retry-after-ms')) && !present(headerValue(headers, 'retry-after'))) return null;
  return retryAfterMsFromError({ headers });
}

/** Epoch ms of the unified rate-limit reset header, uncapped; null when absent or past. */
export function resetAtFromHeaders(headers) {
  const raw = headerValue(headers, RESET_HEADER);
  if (!present(raw)) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : null;
}

/**
 * Stamp the contract onto `err`. Existing `headers` and a finite
 * `retryAfterMs` are preserved. `type` is the wire error type when the caller
 * already parsed one; otherwise it is read from `bodyText` (or err.error, the
 * SDK's parsed body, or err.message) and finally from the status.
 */
export function applyAnthropicErrorContract(err, { status, headers, type = '', bodyText = '' } = {}) {
  if (!err || typeof err !== 'object') return err;
  const httpStatus = Number(status || err.httpStatus || err.status || 0) || 0;
  if (httpStatus) {
    err.status = httpStatus;
    err.httpStatus = httpStatus;
    const wireType =
      lowered(type) ||
      anthropicErrorTypeFromBody(bodyText) ||
      anthropicErrorTypeFromBody(err.error) ||
      anthropicErrorTypeFromBody(err.message) ||
      STATUS_ERROR_TYPE.get(httpStatus) ||
      '';
    const code = httpStatus === 413 ? REQUEST_TOO_LARGE : wireType;
    if (code) err.code = code;
  }
  if (!err.headers && headers) err.headers = headers;
  const effectiveHeaders = err.headers || headers || null;
  if (!(err.retryAfterMs != null && Number.isFinite(Number(err.retryAfterMs)))) {
    const retryAfterMs = retryAfterMsFromHeaders(effectiveHeaders);
    if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
  }
  const resetAt = resetAtFromHeaders(effectiveHeaders);
  if (resetAt != null) err.resetAt = resetAt;
  return err;
}
