/**
 * Antigravity OAuth browser login + Cloud project discovery.
 *
 * Flow: PKCE authorization on a loopback callback (port 51121, the port the
 * registered client is bound to) -> token exchange -> account email ->
 * `loadCodeAssist` for an existing Cloud project, falling back to `onboardUser`
 * which provisions one. A login without a project id is useless: every content
 * request carries `project`.
 */
import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { createOAuthPkce, parseOAuthCodeInput } from './lib/oauth-pkce.mjs';
import {
    AUTH_URL,
    CALLBACK_HOST,
    CALLBACK_PATH,
    CALLBACK_PORT,
    CLIENT_ID,
    CLIENT_SECRET,
    LOGIN_TIMEOUT_MS,
    PROJECT_ENDPOINTS,
    PROJECT_TIMEOUT_MS,
    REDIRECT_URI,
    SCOPES,
    TOKEN_TIMEOUT_MS,
    TOKEN_URL,
    USERINFO_URL,
    _scrubTokens,
    antigravityHeaders,
    codeAssistMetadata,
    saveTokens,
} from './antigravity-oauth-tokens.mjs';

const ONBOARD_MAX_ATTEMPTS = 8;
const ONBOARD_INTERVAL_MS = 2_000;

export function generatePKCE() {
    return createOAuthPkce();
}

function readProjectId(value) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object' && typeof value.id === 'string' && value.id.trim()) {
        return value.id.trim();
    }
    return '';
}

function extractProjectId(payload) {
    if (!payload || typeof payload !== 'object') return '';
    for (const key of ['cloudaicompanionProject', 'projectId', 'project']) {
        const id = readProjectId(payload[key]);
        if (id) return id;
    }
    return '';
}

function defaultTierId(allowedTiers, currentTier) {
    if (Array.isArray(allowedTiers) && allowedTiers.length) {
        const preferred = allowedTiers.find((tier) => tier?.isDefault && String(tier?.id || '').trim());
        if (preferred) return String(preferred.id).trim();
        const first = allowedTiers.find((tier) => String(tier?.id || '').trim());
        if (first) return String(first.id).trim();
    }
    const current = String(currentTier?.id || '').trim();
    return current || 'free-tier';
}

async function postJson(url, body, accessToken, { fetchFn = fetch, signal = null } = {}) {
    return await fetchFn(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...antigravityHeaders(),
        },
        body: JSON.stringify(body),
        signal: signal || AbortSignal.timeout(PROJECT_TIMEOUT_MS),
    });
}

export async function fetchAccountEmail(accessToken, { fetchFn = fetch } = {}) {
    try {
        const res = await fetchFn(USERINFO_URL, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        });
        if (!res.ok) return '';
        const json = await res.json();
        return String(json?.email || '');
    } catch { return ''; }
}

/**
 * Resolve the Cloud project backing this account, provisioning one when the
 * account has none. Endpoints are tried in order because only production
 * answers `loadCodeAssist` reliably for managed accounts.
 */
export async function discoverProject(accessToken, { fetchFn = fetch, onProgress = null } = {}) {
    let tierId = 'free-tier';
    let loaded = false;
    let lastError = '';
    for (const endpoint of PROJECT_ENDPOINTS) {
        try {
            onProgress?.('Checking for an existing project...');
            const res = await postJson(
                `${endpoint}/v1internal:loadCodeAssist`,
                { metadata: codeAssistMetadata() },
                accessToken,
                { fetchFn },
            );
            if (!res.ok) {
                lastError = `${res.status} ${_scrubTokens(await res.text().catch(() => '')).slice(0, 200)}`;
                continue;
            }
            loaded = true;
            const payload = await res.json();
            const existing = extractProjectId(payload);
            if (existing) return existing;
            tierId = defaultTierId(payload?.allowedTiers, payload?.currentTier);
            break;
        } catch (err) {
            lastError = String(err?.message || err).slice(0, 200);
        }
    }
    if (!loaded && lastError) {
        throw new Error(`[antigravity-oauth] loadCodeAssist failed: ${lastError}`);
    }

    onProgress?.('Provisioning a project...');
    for (const endpoint of PROJECT_ENDPOINTS) {
        for (let attempt = 1; attempt <= ONBOARD_MAX_ATTEMPTS; attempt += 1) {
            try {
                const res = await postJson(
                    `${endpoint}/v1internal:onboardUser`,
                    { tierId, metadata: codeAssistMetadata() },
                    accessToken,
                    { fetchFn },
                );
                if (!res.ok) break;
                const payload = await res.json();
                const provisioned = extractProjectId(payload?.response) || extractProjectId(payload);
                if (payload?.done && provisioned) return provisioned;
                // The operation is long-running: poll the same endpoint.
                onProgress?.(`Waiting for project provisioning (${attempt}/${ONBOARD_MAX_ATTEMPTS})...`);
                await new Promise((r) => setTimeout(r, ONBOARD_INTERVAL_MS));
            } catch {
                break;
            }
        }
    }
    throw new Error('[antigravity-oauth] could not resolve a Cloud project for this account');
}

export async function exchangeAuthorizationCode({ code, verifier, fetchFn = fetch, onProgress = null }) {
    const cleanCode = String(code || '').trim();
    if (!cleanCode) throw new Error('[antigravity-oauth] authorization code is required');
    const res = await fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: cleanCode,
            grant_type: 'authorization_code',
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
        }),
        // Secret-bearing (code + verifier): refuse redirects so neither can be
        // replayed against an untrusted host.
        redirect: 'error',
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`[antigravity-oauth] token exchange ${res.status}: ${_scrubTokens(text).slice(0, 300)}`);
    }
    const json = await res.json();
    if (!json?.access_token || !json?.refresh_token) {
        throw new Error('[antigravity-oauth] token exchange response missing access_token or refresh_token');
    }
    const email = await fetchAccountEmail(json.access_token, { fetchFn });
    const projectId = await discoverProject(json.access_token, { fetchFn, onProgress });
    const tokens = {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : 0,
        project_id: projectId,
        email,
    };
    saveTokens(tokens);
    return tokens;
}

export async function beginOAuthLogin({ fetchFn = fetch } = {}) {
    const pkce = generatePKCE();
    const state = randomBytes(16).toString('hex');
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', SCOPES.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // Offline + forced consent is what yields a refresh token on re-login.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');

    let server = null;
    let timeout = null;
    let finish = null;
    const waitForCallback = new Promise((resolvePromise, reject) => {
        let settled = false;
        finish = (value, error = null) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            try { server?.close(); } catch { /* already closed */ }
            if (error) reject(error);
            else resolvePromise(value);
        };
        server = createServer(async (req, res) => {
            const requestUrl = new URL(req.url || '/', `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
            if (requestUrl.pathname !== CALLBACK_PATH) {
                res.writeHead(404);
                res.end();
                return;
            }
            const code = requestUrl.searchParams.get('code');
            if (!code || requestUrl.searchParams.get('state') !== state) {
                res.writeHead(400);
                res.end('Invalid');
                finish(null);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>Antigravity login successful! You can close this tab.</h2></body></html>');
            try {
                finish(await exchangeAuthorizationCode({ code, verifier: pkce.verifier, fetchFn }));
            } catch (err) {
                finish(null, err instanceof Error ? err : new Error(String(err)));
            }
        });
        timeout = setTimeout(() => finish(null), LOGIN_TIMEOUT_MS);
        if (timeout.unref) timeout.unref();
        server.listen(CALLBACK_PORT, CALLBACK_HOST, async () => {
            process.stderr.write(`\n[antigravity-oauth] Open this URL to log in:\n${url.toString()}\n\n`);
            try {
                const { openInBrowser } = await import('../../../shared/open-url.mjs');
                openInBrowser(url.toString());
            } catch (err) {
                process.stderr.write(`[antigravity-oauth] browser open failed: ${String(err?.message || err).slice(0, 200)}\n`);
            }
        });
        server.on('error', (err) => finish(
            null,
            new Error(`[antigravity-oauth] callback server failed on ${CALLBACK_HOST}:${CALLBACK_PORT}: ${err?.message || err}`),
        ));
    });

    return {
        provider: 'antigravity-oauth',
        url: url.toString(),
        waitForCallback,
        completeCode: async (input) => {
            const parsed = parseOAuthCodeInput(input);
            if (parsed.state && parsed.state !== state) throw new Error('[antigravity-oauth] OAuth state mismatch');
            const tokens = await exchangeAuthorizationCode({ code: parsed.code, verifier: pkce.verifier, fetchFn });
            finish?.(tokens);
            return tokens;
        },
        cancel: () => { finish?.(null); },
    };
}

export async function loginOAuth() {
    const login = await beginOAuthLogin();
    return await login.waitForCallback;
}
