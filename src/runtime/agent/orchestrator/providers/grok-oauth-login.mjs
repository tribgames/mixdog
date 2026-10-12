// Grok OAuth browser login + PKCE exchange against xAI's shared OAuth client
// (the consent screen renders it as "Grok Build").
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { createOAuthPkce, parseOAuthCodeInput } from './lib/oauth-pkce.mjs';
import { OAUTH_PAGE_CONTENT_TYPE, oauthSuccessHtml } from './lib/oauth-page.mjs';
import { emailFromJwts } from './lib/oauth-token-utils.mjs';
import {
  CLIENT_ID,
  SCOPE,
  CALLBACK_HOST,
  CALLBACK_PORT,
  CALLBACK_PATH,
  REDIRECT_URI,
  TOKEN_TIMEOUT_MS,
  LOGIN_TIMEOUT_MS,
  fetchDiscovery,
  _normalizeExpiresAt,
  _identityFromAccessToken,
  saveTokens,
  _scrubTokens,
} from './grok-oauth-tokens.mjs';

export function generatePKCE() {
  return createOAuthPkce();
}

export async function exchangeAuthorizationCode({ discovery, pkce, code }) {
  const cleanCode = String(code || '').trim();
  if (!cleanCode) throw new Error('[grok-oauth] authorization code is required');
  const tokenRes = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: cleanCode,
      code_verifier: pkce.verifier,
      redirect_uri: REDIRECT_URI,
      // xAI re-validates the PKCE challenge at token exchange
      // (not just the verifier), so echo it back. Omitting
      // these makes the exchange fail. Matches the Grok CLI.
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    }),
    // Secret-bearing (authorization code + verifier): refuse
    // redirects so they can't be replayed to an untrusted host.
    redirect: 'error',
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    dispatcher: getLlmDispatcher(),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(`[grok-oauth] token exchange ${tokenRes.status}: ${_scrubTokens(text).slice(0, 500)}`);
  }
  const json = await tokenRes.json();
  if (!json.access_token || !json.refresh_token) {
    throw new Error('[grok-oauth] token exchange response missing access_token or refresh_token');
  }
  const identity = _identityFromAccessToken(json.access_token);
  const tokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at:
      typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : _normalizeExpiresAt(json.expires_at),
    token_endpoint: discovery.token_endpoint,
    user_id: identity.user_id || '',
    principal_type: json.principal_type || identity.principal_type || '',
    principal_id: json.principal_id || identity.principal_id || '',
    ...(emailFromJwts(json.id_token, json.access_token)
      ? { email: emailFromJwts(json.id_token, json.access_token) }
      : {}),
  };
  saveTokens(tokens);
  return tokens;
}

export async function beginOAuthLogin({ openBrowser = true } = {}) {
  const discovery = await fetchDiscovery();
  const pkce = generatePKCE();
  const state = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('plan', 'generic');
  url.searchParams.set('referrer', 'mixdog');

  let server = null;
  let timeout = null;
  let finish = null;
  const waitForCallback = new Promise((resolve, reject) => {
    let settled = false;
    finish = (value, error = null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try {
        server?.close();
      } catch {
        /* already closed */
      }
      if (error) reject(error);
      else resolve(value);
    };
    server = createServer(async (req, res) => {
      const u = new URL(req.url || '/', `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
      if (u.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = u.searchParams.get('code');
      if (!code || u.searchParams.get('state') !== state) {
        // Reject this request only; the valid callback may still arrive.
        res.writeHead(400);
        res.end('Invalid');
        return;
      }
      res.writeHead(200, { 'Content-Type': OAUTH_PAGE_CONTENT_TYPE });
      res.end(oauthSuccessHtml('Grok'));
      try {
        const tokens = await exchangeAuthorizationCode({ discovery, pkce, code });
        finish(tokens);
      } catch (err) {
        finish(null, err instanceof Error ? err : new Error(String(err)));
      }
    });
    timeout = setTimeout(() => finish(null), LOGIN_TIMEOUT_MS);
    server.listen(CALLBACK_PORT, CALLBACK_HOST, async () => {
      process.stderr.write(
        `\n[grok-oauth] Open this URL to log in (consent shows as "Grok Build"):\n${url.toString()}\n\n`
      );
      if (!openBrowser) return;
      try {
        const { openInBrowser } = await import('../../../shared/open-url.mjs');
        openInBrowser(url.toString());
      } catch (err) {
        process.stderr.write(`[grok-oauth] browser open failed: ${String(err?.message || err).slice(0, 200)}\n`);
      }
    });
    server.on('error', (err) =>
      finish(
        null,
        new Error(`[grok-oauth] callback server failed on ${CALLBACK_HOST}:${CALLBACK_PORT}: ${err?.message || err}`)
      )
    );
  });

  return {
    provider: 'grok-oauth',
    url: url.toString(),
    waitForCallback,
    completeCode: async (input) => {
      const parsed = parseOAuthCodeInput(input, { allowHashState: true });
      if (parsed.state && parsed.state !== state) throw new Error('[grok-oauth] OAuth state mismatch');
      const tokens = await exchangeAuthorizationCode({ discovery, pkce, code: parsed.code });
      finish?.(tokens);
      return tokens;
    },
    cancel: () => {
      finish?.(null);
    },
  };
}

export async function loginOAuth() {
  const login = await beginOAuthLogin();
  return await login.waitForCallback;
}
