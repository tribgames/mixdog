import { statSync } from 'node:fs';

/** The file's modification time in ms; 0 when it cannot be stat-ed. */
export function fileMtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

export function expiryFromAccessToken(token) {
  const exp = Number(decodeJwtPayload(token)?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

// The email claim of the id_token / access token a login or refresh already
// returned; opaque tokens simply yield nothing.
export function emailFromJwts(...tokens) {
  for (const token of tokens) {
    const email = decodeJwtPayload(token)?.email;
    if (typeof email === 'string' && email.trim()) return email.trim();
  }
  return '';
}

const cleanIdentityText = (value) => (typeof value === 'string' ? value.trim().slice(0, 200) : '');

/**
 * The real account behind a credential: `id` is the provider's stable account
 * or user id, `email` its human label. Null when the credential names neither.
 */
export function normalizeAccountIdentity(raw) {
  const id = cleanIdentityText(raw?.id);
  const email = cleanIdentityText(raw?.email);
  const organizationId = cleanIdentityText(raw?.organizationId);
  if (!id && !email) return null;
  return { ...(id ? { id } : {}), ...(email ? { email } : {}), ...(organizationId ? { organizationId } : {}) };
}

/** Identity keys a provider's describe() reports (never tokens). */
export function accountIdentityFields(identity) {
  const normalized = normalizeAccountIdentity(identity);
  return {
    ...(normalized?.email ? { email: normalized.email } : {}),
    ...(normalized?.id ? { identityId: normalized.id } : {}),
  };
}

/** Stable ids decide when both sides have one; email only when an id is missing. */
export function sameAccountIdentity(a, b) {
  const left = normalizeAccountIdentity(a);
  const right = normalizeAccountIdentity(b);
  if (!left || !right) return false;
  if (left.id && right.id) return left.id === right.id;
  return Boolean(left.email && right.email && left.email.toLowerCase() === right.email.toLowerCase());
}

// expires_at may arrive as a unix number (seconds or milliseconds), a numeric
// string, or an ISO-8601 string. Normalize to epoch milliseconds; 0 means unknown.
export function normalizeExpiresAtMs(value) {
  if (typeof value === 'string' && !Number.isFinite(Number(value.trim() || NaN))) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Whether a stored `{ access_token, refresh_token?, expires_at }` document is a
 * sign-in: it can refresh, or its access token is known to be unexpired. A copy
 * made without a refresh token (an isolated dev instance, so it cannot rotate
 * the original's) coasts on the access token until then; one with no known
 * expiry and no refresh token is incomplete, not a sign-in.
 */
export function isSignedInTokenDocument(raw) {
  if (!raw?.access_token) return false;
  if (raw.refresh_token) return true;
  const expiresAt = normalizeExpiresAtMs(raw.expires_at ?? raw.expiresAt) || expiryFromAccessToken(raw.access_token);
  return expiresAt > Date.now();
}

/**
 * Status record for a stored OAuth credential that has an access token.
 * `expiresAt` is epoch ms (0 = unknown); `detail` labels the credential source.
 */
export function oauthCredentialStatus({ hasRefresh, expiresAt, detail, refreshSkewMs }) {
  const expired = expiresAt > 0 && expiresAt <= Date.now();
  const expiring = expiresAt > 0 && expiresAt < Date.now() + refreshSkewMs;
  if (!hasRefresh) {
    return {
      authenticated: expiresAt === 0 || !expired,
      usable: expiresAt === 0 || !expired,
      refreshable: false,
      reauthRequired: expired,
      status: expired ? 'Reauth Required' : 'Access Only',
      detail: `${detail}; no refresh token`,
      expiresAt,
    };
  }
  let status = 'Valid';
  if (expired) status = 'Refresh Required';
  else if (expiring) status = 'Refresh Soon';
  return {
    authenticated: true,
    usable: !expired,
    refreshable: true,
    reauthRequired: false,
    status,
    detail,
    expiresAt,
  };
}

const TRANSIENT_OAUTH_RE =
  /\b(?:403|429|50[0-4])\b|rate[ _-]?limit|too many requests|bad gateway|service unavailable|gateway time-?out|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network/i;
const DEAD_GRANT_RE =
  /invalid_grant|invalid_token|unauthorized_client|refresh[ _-]?token[^.\n]{0,40}\b(?:expired|revoked)\b/i;

/** True only when the token endpoint definitively rejected the grant (re-login needed). */
export function isDefinitiveOAuthFailure(text, status = 0) {
  const s = Number(status) || 0;
  const body = String(text || '');
  if (s === 403 || s === 429 || s >= 500) return false;
  if (TRANSIENT_OAUTH_RE.test(body)) return false;
  if (DEAD_GRANT_RE.test(body)) return true;
  return s === 401;
}

// Fields whose string values are secrets, snake_case or camelCase. `code` is
// not one: it is also every API's error/status code. The authorization code
// is redacted by value — exchange paths pass it in `secretValues`.
const SECRET_FIELD =
  '(?:access_?token|refresh_?token|id_?token|client_?secret|code_?verifier|code_?challenge|device_?code|api_?key|token|key|secret|password|assertion)';
const SECRET_KEY_RE = new RegExp(`^${SECRET_FIELD}$`, 'i');
// Fallback for text that is not JSON. `"field": value` — a string (possibly
// cut off) or a bare non-numeric value in malformed JSON.
const JSON_SECRET_RE = new RegExp(
  `"(${SECRET_FIELD})"\\s*:\\s*(?:"(?:[^"\\\\]|\\\\.)*"?|(?!-?\\d|true\\b|false\\b|null\\b)[^,}\\]\\s]+)`,
  'gi'
);
// Form-encoded or query `field=value`.
const FORM_SECRET_RE = new RegExp(`(^|[^A-Za-z0-9_])(${SECRET_FIELD})=[^&\\s"']*`, 'gi');
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?/g;

// Bearer/JWT/Anthropic tokens and the given secret values, anywhere in `text`.
function scrubTokenText(text, secretValues) {
  let scrubbed = text
    .replace(/Bearer [A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9._-]+/g, '[REDACTED]')
    .replace(JWT_RE, '[REDACTED]');
  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret) {
      scrubbed = scrubbed.split(secret).join('[REDACTED]');
    }
  }
  return scrubbed;
}

// A JSON object or array is redacted on its parsed form, so escaped key names
// (`client\u005fsecret`) cannot slip past a pattern. Numbers keep their exact
// source text; an untouched body is returned as it came. Null when `text` is
// not a JSON object or array.
function scrubJsonSecrets(text, secretValues) {
  let parsed;
  try {
    parsed = JSON.parse(text, (_key, value, context) =>
      typeof value === 'number' ? JSON.rawJSON(context.source) : value
    );
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || JSON.isRawJSON(parsed)) return null;
  let changed = false;
  // Each decoded string (keys too) gets the full redaction: it may hold
  // form-encoded fields, a query string or JSON of its own.
  const scrubString = (value) => {
    const scrubbed = scrubOAuthSecrets(value, secretValues);
    if (scrubbed !== value) changed = true;
    return scrubbed;
  };
  const walk = (value) => {
    if (typeof value === 'string') return scrubString(value);
    if (!value || typeof value !== 'object' || JSON.isRawJSON(value)) return value;
    if (Array.isArray(value)) return value.map(walk);
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => {
        if (SECRET_KEY_RE.test(key) && typeof inner === 'string') {
          changed = true;
          return [key, '[REDACTED]'];
        }
        return [scrubString(key), walk(inner)];
      })
    );
  };
  const scrubbed = walk(parsed);
  return changed ? JSON.stringify(scrubbed) : text;
}

/** Redact OAuth secrets from a body or message: secret fields (decoded JSON
 *  keys, or JSON-like and form-encoded text), bearer/JWT/Anthropic tokens,
 *  and the given values. Numeric and status codes are kept. */
export function scrubOAuthSecrets(text, secretValues = []) {
  const raw = String(text || '');
  const json = scrubJsonSecrets(raw, secretValues);
  if (json !== null) return json;
  return scrubTokenText(
    raw
      .replace(JSON_SECRET_RE, (_match, key) => `"${key}":"[REDACTED]"`)
      .replace(FORM_SECRET_RE, (_match, lead, key) => `${lead}${key}=[REDACTED]`),
    secretValues
  );
}

// --- Token-exchange failures a sign-in page may show ---

export const OAUTH_NETWORK_HINT = 'Check your proxy/VPN: Mixdog uses the system proxy, or HTTPS_PROXY.';
const NETWORK_CODE = /^(?:E[A-Z0-9]+|UND_ERR_[A-Z0-9_]+|ERR_[A-Z0-9_]+)$/;

/**
 * The transport cause of a fetch that got no answer: its error code
 * (ECONNRESET, UND_ERR_CONNECT_TIMEOUT, ENOTFOUND…) or "timed out". Only codes,
 * never messages, which may quote anything. Null for a cancel or a non-network
 * error.
 */
export function oauthNetworkCause(error) {
  if (!error || typeof error !== 'object' || error.name === 'AbortError') return null;
  if (error.name === 'TimeoutError') return 'timed out';
  for (let e = error, depth = 0; e && typeof e === 'object' && depth < 5; e = e.cause, depth += 1) {
    if (typeof e.code === 'string' && NETWORK_CODE.test(e.code)) return e.code;
  }
  return error.name === 'TypeError' ? 'network error' : null;
}

// Errors whose message was built only from codes, statuses and redacted
// bodies: the only ones a failure page quotes.
const publicErrors = new WeakSet();

/** Mark `error` as safe to show on the sign-in failure page. */
export function oauthPublicError(error) {
  publicErrors.add(error);
  return error;
}

/** A fetch failure as `<operation> request failed (<cause>). <hint>`; other errors unchanged. */
export function oauthRequestError(operation, error) {
  const cause = oauthNetworkCause(error);
  return cause ? oauthPublicError(new Error(`${operation} request failed (${cause}). ${OAUTH_NETWORK_HINT}`)) : error;
}

/** A token endpoint's body for an error message: secrets redacted, whitespace folded, shortened. */
export function oauthBodySummary(text, secretValues = []) {
  return scrubOAuthSecrets(text, secretValues).replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** A token endpoint's HTTP failure as `<operation> <status>: <redacted body>`. */
export function oauthHttpError(operation, status, text, secretValues = []) {
  const summary = oauthBodySummary(text, secretValues);
  return oauthPublicError(new Error(`${operation} ${status}${summary ? `: ${summary}` : ''}`));
}

/** The token response's JSON. A body that does not parse is named by its
 *  status only: the parser's message quotes the body, tokens included. */
export async function oauthResponseJson(response, operation) {
  try {
    return await response.json();
  } catch (error) {
    if (error?.name !== 'SyntaxError') throw oauthRequestError(operation, error);
    throw oauthPublicError(new Error(`${operation} returned a malformed response (HTTP ${response.status})`));
  }
}

/** The failure page reason: the summary, plus the error's message only when it is page-safe. */
export function oauthFailureReason(summary, error) {
  return error && publicErrors.has(error) ? `${summary}\n${error.message}` : summary;
}
