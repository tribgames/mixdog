import { createHash, createSign } from 'node:crypto';

export const VERTEX_TOKEN_URI = 'https://oauth2.googleapis.com/token';
export const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

function base64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function parseVertexServiceAccount(raw) {
  let value;
  try {
    value = JSON.parse(String(raw || ''));
  } catch {
    throw new Error('Vertex AI service-account JSON is invalid.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Vertex AI service-account JSON is invalid.');
  }
  const clientEmail = String(value.client_email || '').trim();
  const privateKey = String(value.private_key || '').trim();
  const projectId = String(value.project_id || '').trim();
  const privateKeyId = String(value.private_key_id || '').trim();
  if (!clientEmail || !privateKey || !projectId) {
    throw new Error('Vertex AI service-account JSON must include client_email, private_key, and project_id.');
  }
  // The identity every minted access token is bound to and checked against.
  // The key fingerprint does not depend on the optional private_key_id.
  const keyFingerprint = createHash('sha256').update(privateKey).digest('hex');
  const identity = JSON.stringify([clientEmail, privateKeyId, projectId, keyFingerprint]);
  return { clientEmail, privateKey, privateKeyId, projectId, identity, tokenUri: VERTEX_TOKEN_URI };
}

export function createVertexJwtAssertion(account, nowMs = Date.now()) {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64url({ alg: 'RS256', typ: 'JWT' });
  const claims = base64url({
    iss: account.clientEmail,
    scope: VERTEX_SCOPE,
    aud: account.tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3600,
  });
  const input = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  const signature = signer
    .sign(account.privateKey)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${input}.${signature}`;
}

export class VertexAccessTokenManager {
  constructor({ credentialResolver, fetchFn = fetch, now = () => Date.now(), refreshSkewMs = TOKEN_REFRESH_SKEW_MS } = {}) {
    this.credentialResolver = credentialResolver;
    this.fetchFn = fetchFn;
    this.now = now;
    this.refreshSkewMs = refreshSkewMs;
    this.credentialRaw = '';
    this.account = null;
    // { identity, token, expiresAt }: served only to the account that minted it.
    this.cached = null;
  }

  _account() {
    const raw = String(this.credentialResolver?.() || '').trim();
    if (!raw) throw new Error('Vertex AI service-account JSON is not configured.');
    if (raw !== this.credentialRaw) {
      // Parse first: a malformed key must leave the previous state untouched
      // and keep failing, never be remembered as the current credential.
      this.account = parseVertexServiceAccount(raw);
      this.credentialRaw = raw;
    }
    return this.account;
  }

  projectId() {
    return this._account().projectId;
  }

  identity() {
    return this._account().identity;
  }

  // A request built for one account must not run under another's credentials.
  assertIdentity(identity) {
    if (this._account().identity !== identity) {
      throw Object.assign(
        new Error('Vertex AI authentication failed: the service-account credential changed during the request.'),
        { code: 'EVERTEXAUTH' }
      );
    }
  }

  // Drops only the token the server rejected; a fresher one stays cached.
  invalidate(rejectedToken) {
    if (rejectedToken && this.cached?.token === rejectedToken) this.cached = null;
  }

  async getAccessToken({ identity } = {}) {
    if (identity !== undefined) this.assertIdentity(identity);
    const account = this._account();
    const now = this.now();
    const cached = this.cached;
    if (cached?.identity === account.identity && now + this.refreshSkewMs < cached.expiresAt) {
      return cached.token;
    }

    let assertion;
    try {
      assertion = createVertexJwtAssertion(account, now);
    } catch (error) {
      throw Object.assign(new Error('Vertex AI authentication failed: could not sign the service-account JWT.'), {
        code: 'EVERTEXAUTH',
        cause: error,
      });
    }
    let response;
    try {
      response = await this.fetchFn(account.tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      });
    } catch (error) {
      throw Object.assign(new Error(`Vertex AI authentication failed: ${error?.message || 'token request failed'}`), {
        code: 'EVERTEXAUTH',
        cause: error,
      });
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {}
    if (!response.ok || !payload?.access_token) {
      const detail = String(payload?.error_description || payload?.error || `HTTP ${response.status}`).slice(0, 240);
      throw Object.assign(new Error(`Vertex AI authentication failed: ${detail}`), {
        code: 'EVERTEXAUTH',
        status: response.status,
        httpStatus: response.status,
      });
    }
    const expiresIn = Math.max(1, Number(payload.expires_in) || 3600);
    const token = String(payload.access_token);
    this.cached = { identity: account.identity, token, expiresAt: now + expiresIn * 1000 };
    return token;
  }
}
