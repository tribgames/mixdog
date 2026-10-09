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

// expires_at may arrive as a unix number (seconds or milliseconds) or an
// ISO-8601 string. Normalize to epoch milliseconds; 0 means unknown.
export function normalizeExpiresAtMs(value) {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
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

export function scrubOAuthSecrets(text, secretValues = []) {
  let scrubbed = String(text || '')
    .replace(/Bearer [A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9._-]+/g, '[REDACTED]')
    .replace(
      /"(accessToken|refreshToken|access_token|refresh_token|code|key)"\s*:\s*"[^"]+"/g,
      (_match, key) => `"${key}":"[REDACTED]"`
    );
  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret) {
      scrubbed = scrubbed.split(secret).join('[REDACTED]');
    }
  }
  return scrubbed;
}
