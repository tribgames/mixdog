// Grok OAuth browser login + PKCE exchange, extracted from grok-oauth.mjs.
/**
 * Grok CLI OAuth provider ("Grok Build").
 *
 * Authenticates against xAI's shared OAuth client via PKCE (discovery at
 * https://auth.x.ai/.well-known/openid-configuration). Credentials come from
 * Mixdog's own token store (grok-oauth.json).
 *
 * Every OAuth inference request routes through cli-chat-proxy.grok.com/v1,
 * matching Grok Build's session-auth contract. Model discovery still merges
 * api.x.ai and proxy catalogs because each publishes a different subset.
 *
 * Inference is delegated to an inner OpenAICompatProvider('xai') — the only
 * preset wired for the Responses API — with the proxy URL + CLI headers
 * injected via config.extraHeaders, bearer swapped for the OAuth access token.
 */
import { createServer } from 'http';
import { randomBytes, randomUUID, createHash } from 'crypto';
import { readFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { getPluginData } from '../config.mjs';
import { writeJsonAtomicSync, withFileLock } from '../../../shared/atomic-file.mjs';
import { boundProviderAuthPath } from '../../../shared/provider-auth-binding.mjs';
import { enrichModels, getModelMetadataSync } from './model-catalog.mjs';
import { sanitizeModelList } from './model-list-sanitize.mjs';
import { makeModelCache } from './model-cache.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';
import { createTimeoutSignal } from '../stall-policy.mjs';
import { populateHttpStatusFromMessage } from './retry-classifier.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import { normalizeGrokToolSchemas } from './lib/grok-tool-schema.mjs';

// --- Constants ---
// xAI's shared OAuth client. The consent screen renders this as "Grok Build".
import { CLIENT_ID, SCOPE, CALLBACK_HOST, CALLBACK_PORT, CALLBACK_PATH, REDIRECT_URI, TOKEN_TIMEOUT_MS, LOGIN_TIMEOUT_MS, fetchDiscovery, _normalizeExpiresAt, _identityFromAccessToken, saveTokens, _scrubTokens } from './grok-oauth-tokens.mjs';

export function generatePKCE() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
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
        expires_at: typeof json.expires_in === 'number'
            ? Date.now() + json.expires_in * 1000
            : _normalizeExpiresAt(json.expires_at),
        token_endpoint: discovery.token_endpoint,
        user_id: identity.user_id || '',
        principal_type: json.principal_type || identity.principal_type || '',
        principal_id: json.principal_id || identity.principal_id || '',
    };
    saveTokens(tokens);
    return tokens;
}

export function parseOAuthCodeInput(input) {
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

export async function beginOAuthLogin() {
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
            res.end('<html><body><h2>Grok login successful! You can close this tab.</h2></body></html>');
            try {
                const tokens = await exchangeAuthorizationCode({ discovery, pkce, code });
                finish(tokens);
            } catch (err) {
                finish(null, err instanceof Error ? err : new Error(String(err)));
            }
        });
        timeout = setTimeout(() => finish(null), LOGIN_TIMEOUT_MS);
        server.listen(CALLBACK_PORT, CALLBACK_HOST, async () => {
            process.stderr.write(`\n[grok-oauth] Open this URL to log in (consent shows as "Grok Build"):\n${url.toString()}\n\n`);
            try {
                const { openInBrowser } = await import('../../../shared/open-url.mjs');
                openInBrowser(url.toString());
            } catch (err) {
                process.stderr.write(`[grok-oauth] browser open failed: ${String(err?.message || err).slice(0, 200)}\n`);
            }
        });
        server.on('error', (err) => finish(null, new Error(`[grok-oauth] callback server failed on ${CALLBACK_HOST}:${CALLBACK_PORT}: ${err?.message || err}`)));
    });

    return {
        provider: 'grok-oauth',
        url: url.toString(),
        waitForCallback,
        completeCode: async (input) => {
            const parsed = parseOAuthCodeInput(input);
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
