// Token expiry reading for dev-isolated.mjs, moved from Node's
// src/runtime/agent/orchestrator/providers/lib/oauth-token-utils.mjs when K1 deleted it.

function decodeJwtPayload(token) {
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

export function normalizeExpiresAtMs(value) {
  if (typeof value === 'string' && !Number.isFinite(Number(value.trim() || NaN))) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}
