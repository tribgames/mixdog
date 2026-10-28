import { createSign } from 'node:crypto';

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
  if (!clientEmail || !privateKey || !projectId) {
    throw new Error('Vertex AI service-account JSON must include client_email, private_key, and project_id.');
  }
  return { clientEmail, privateKey, projectId, tokenUri: VERTEX_TOKEN_URI };
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
    this.token = '';
    this.expiresAt = 0;
  }

  _account() {
    const raw = String(this.credentialResolver?.() || '').trim();
    if (!raw) throw new Error('Vertex AI service-account JSON is not configured.');
    if (raw !== this.credentialRaw) {
      this.credentialRaw = raw;
      this.account = parseVertexServiceAccount(raw);
      this.invalidate();
    }
    return this.account;
  }

  projectId() {
    return this._account().projectId;
  }

  invalidate() {
    this.token = '';
    this.expiresAt = 0;
  }

  async getAccessToken({ force = false } = {}) {
    const account = this._account();
    const now = this.now();
    if (!force && this.token && now + this.refreshSkewMs < this.expiresAt) return this.token;

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
    this.token = String(payload.access_token);
    this.expiresAt = now + expiresIn * 1000;
    return this.token;
  }
}
