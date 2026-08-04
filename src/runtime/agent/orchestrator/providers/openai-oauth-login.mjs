/**
 * OpenAI ChatGPT OAuth PKCE login flow.
 *
 * Extracted from openai-oauth.mjs: PKCE generation, authorization-code
 * exchange, the localhost callback server, and interactive login helpers.
 * openai-oauth.mjs re-exports beginOAuthLogin/loginOAuth as a facade so
 * existing importers resolve unchanged. Token persistence + JWT parsing stay
 * owned by openai-oauth.mjs and are injected here to avoid a circular import
 * of its module-level token store state.
 */
import { createServer } from 'http';
import { randomBytes, createHash } from 'crypto';

const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const CODEX_OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;

function generatePKCE() {
    const verifier = randomBytes(64).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

function _scrubOAuthLoginBody(text) {
    return String(text || '')
        .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[REDACTED]"')
        .replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"[REDACTED]"')
        .replace(/"id_token"\s*:\s*"[^"]+"/g, '"id_token":"[REDACTED]"')
        .replace(/[A-Za-z0-9_-]{32,}\.[A-Za-z0-9._-]+/g, '[REDACTED]');
}

function _parseOAuthCodeInput(input) {
    const value = String(input || '').trim();
    if (!value) return { code: '', state: '' };
    try {
        const url = new URL(value);
        const code = url.searchParams.get('code') || '';
        const state = url.searchParams.get('state') || '';
        if (code || state) return { code, state };
    } catch { /* not a URL */ }
    if (value.includes('#')) {
        const [code, state] = value.split('#', 2);
        return { code: String(code || '').trim(), state: String(state || '').trim() };
    }
    if (value.includes('code=')) {
        const params = new URLSearchParams(value.startsWith('?') ? value.slice(1) : value);
        return { code: params.get('code') || '', state: params.get('state') || '' };
    }
    return { code: value, state: '' };
}

/**
 * @param {object} deps
 * @param {string} deps.clientId
 * @param {string} deps.originator
 * @param {(token:string)=>(string|undefined)} deps.extractAccountId
 * @param {(token:string)=>number} deps.expiryFromAccessToken
 * @param {(tokens:object)=>void} deps.saveTokens
 */
export function createOpenAIOAuthLogin(deps) {
    const { clientId, originator, extractAccountId, expiryFromAccessToken, saveTokens } = deps;

    async function exchangeAuthorizationCode({ pkce, code }) {
        const cleanCode = String(code || '').trim();
        if (!cleanCode) throw new Error('[openai-oauth] authorization code is required');
        const tokenRes = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: cleanCode,
                redirect_uri: REDIRECT_URI,
                client_id: clientId,
                code_verifier: pkce.verifier,
            }),
            redirect: 'error',
            signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        });
        if (!tokenRes.ok) {
            const text = await tokenRes.text().catch(() => '');
            throw new Error(`[openai-oauth] token exchange ${tokenRes.status}: ${_scrubOAuthLoginBody(text).slice(0, 500)}`);
        }
        const json = await tokenRes.json();
        if (!json.access_token || !json.refresh_token) {
            throw new Error('[openai-oauth] token exchange response missing access_token or refresh_token');
        }
        const expiresAt = (typeof json.expires_in === 'number'
            ? Date.now() + json.expires_in * 1000
            : 0) || expiryFromAccessToken(json.access_token);
        const tokens = {
            access_token: json.access_token,
            refresh_token: json.refresh_token,
            expires_at: expiresAt,
            account_id: extractAccountId(json.access_token),
        };
        saveTokens(tokens);
        return tokens;
    }

    async function beginOAuthLogin() {
        const pkce = generatePKCE();
        const state = randomBytes(16).toString('hex');
        const url = new URL(AUTHORIZE_URL);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', REDIRECT_URI);
        url.searchParams.set('scope', CODEX_OAUTH_SCOPE);
        url.searchParams.set('code_challenge', pkce.challenge);
        url.searchParams.set('code_challenge_method', 'S256');
        url.searchParams.set('id_token_add_organizations', 'true');
        url.searchParams.set('codex_cli_simplified_flow', 'true');
        url.searchParams.set('state', state);
        url.searchParams.set('originator', originator);

        let server = null;
        let timeout = null;
        let finish = null;
        const waitForCallback = new Promise((resolve, reject) => {
            let settled = false;
            finish = (value, error = null) => {
                if (settled) return;
                settled = true;
                if (timeout) clearTimeout(timeout);
                try { server?.close(); } catch { /* already closed */ }
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
                    res.writeHead(400);
                    res.end('Invalid');
                    finish(null);
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><body><h2>OpenAI OAuth login successful! You can close this tab.</h2></body></html>');
                try {
                    const tokens = await exchangeAuthorizationCode({ pkce, code });
                    finish(tokens);
                } catch (err) {
                    finish(null, err instanceof Error ? err : new Error(String(err)));
                }
            });
            timeout = setTimeout(() => finish(null), LOGIN_TIMEOUT_MS);
            server.listen(CALLBACK_PORT, CALLBACK_HOST, async () => {
                process.stderr.write(`\n[openai-oauth] Open this URL to log in to ChatGPT (OpenAI OAuth):\n${url.toString()}\n\n`);
                try {
                    const { openInBrowser } = await import('../../../shared/open-url.mjs');
                    openInBrowser(url.toString());
                } catch (err) {
                    process.stderr.write(`[openai-oauth] browser open failed: ${String(err?.message || err).slice(0, 200)}\n`);
                }
            });
            server.on('error', (err) => finish(null, new Error(`[openai-oauth] callback server failed on ${CALLBACK_HOST}:${CALLBACK_PORT}: ${err?.message || err}`)));
        });

        return {
            provider: 'openai-oauth',
            url: url.toString(),
            waitForCallback,
            completeCode: async (input) => {
                const parsed = _parseOAuthCodeInput(input);
                if (parsed.state && parsed.state !== state) throw new Error('[openai-oauth] OAuth state mismatch');
                const tokens = await exchangeAuthorizationCode({ pkce, code: parsed.code });
                finish?.(tokens);
                return tokens;
            },
            cancel: () => {
                finish?.(null);
            },
        };
    }

    async function loginOAuth() {
        const login = await beginOAuthLogin();
        return await login.waitForCallback;
    }

    return { beginOAuthLogin, loginOAuth };
}
