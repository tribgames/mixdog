/**
 * Antigravity OAuth browser login + Cloud project discovery.
 *
 * Flow: PKCE authorization on a loopback callback (port 51121, the port the
 * registered client is bound to) -> token exchange -> account email ->
 * `loadCodeAssist` for account status -> free-tier onboarding when needed ->
 * refreshed Cloud project. A login without a project id is useless: every
 * content request carries `project`.
 */
import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createOAuthPkce, parseOAuthCodeInput } from './lib/oauth-pkce.mjs';
import {
    AUTH_URL,
    CALLBACK_HOST,
    CALLBACK_PATH,
    CALLBACK_PORT,
    CLIENT_ID,
    CLIENT_SECRET,
    LOGIN_TIMEOUT_MS,
    PROJECT_ENDPOINT,
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

const ONBOARD_INTERVAL_MS = 1_000;
const CALLBACK_FAILURE_HTML = '<html><body><h2>Antigravity sign-in was not completed.</h2>'
    + '<p>Return to Mixdog for the error details and any account verification link.</p></body></html>';

export function generatePKCE() {
    return createOAuthPkce();
}

function extractProjectId(payload) {
    return typeof payload?.cloudaicompanionProject === 'string' ? payload.cloudaicompanionProject : '';
}

function accountVerificationError(validationUrl, reason, email) {
    const account = email ? ` for ${email}` : '';
    const detail = reason ? `\n${reason}` : '';
    const error = new Error(_scrubTokens(`[antigravity-oauth] Account verification required${account}.${detail}`
        + `\nVisit ${validationUrl} to continue, then sign in again.`));
    error.code = 'VALIDATION_REQUIRED';
    error.validationUrl = validationUrl;
    return error;
}

async function requestCodeAssist(action, body, context, timeoutMs = PROJECT_TIMEOUT_MS) {
    const { accessToken, fetchFn, signal } = context;
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const isPost = body !== undefined;
    const res = await fetchFn(`${PROJECT_ENDPOINT}/v1internal${isPost ? ':' : '/'}${action}`, {
        method: isPost ? 'POST' : 'GET',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...antigravityHeaders(),
        },
        ...(isPost ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (res.status !== 200) {
        const text = await res.text();
        let failure = null;
        try { failure = JSON.parse(text); } catch { /* Non-JSON errors retain their original detail below. */ }
        const details = failure?.error?.details;
        const validation = Array.isArray(details) ? details.find((entry) =>
            entry?.reason === 'VALIDATION_REQUIRED'
            && typeof entry.metadata?.validation_url === 'string'
            && entry.metadata.validation_url.length > 0) : null;
        if (validation) {
            throw accountVerificationError(validation.metadata.validation_url, failure.error.message, context.email);
        }
        const detail = _scrubTokens(text);
        throw new Error(`[antigravity-oauth] ${action} failed: ${res.status} ${res.statusText}: ${detail}`);
    }
    const payload = await res.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error(`[antigravity-oauth] invalid ${action} response`);
    }
    return payload;
}

async function fetchAccountEmail(accessToken, { fetchFn = fetch, signal = null } = {}) {
    try {
        const res = await fetchFn(USERINFO_URL, {
            headers: { Authorization: `Bearer ${accessToken}` },
            redirect: 'error',
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)]) : AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        });
        if (!res.ok) return '';
        const json = await res.json();
        return String(json?.email || '');
    } catch {
        signal?.throwIfAborted();
        return '';
    }
}

async function loadProjectState(context) {
    const body = { metadata: codeAssistMetadata() };
    let payload = await requestCodeAssist('loadCodeAssist', body, context);
    const projectId = extractProjectId(payload);
    if (payload.paidTier == null && projectId) {
        payload = await requestCodeAssist('loadCodeAssist', {
            ...body,
            cloudaicompanionProject: projectId,
        }, context);
    }
    return payload;
}

function tierIds(list, key) {
    return Array.isArray(list) ? list.map((tier) => tier?.[key]).filter((id) => typeof id === 'string' && id) : [];
}

function tierSummary(payload) {
    return `allowed tiers: [${tierIds(payload.allowedTiers, 'id').join(', ')}]; `
        + `ineligible tiers: [${tierIds(payload.ineligibleTiers, 'tierId').join(', ')}]`;
}

/**
 * Tier to onboard with. Free tier when Google allows it (or reports no tier
 * list at all); otherwise the default allowed tier that Google can provision
 * without a user-supplied Cloud project, e.g. a paid subscription tier.
 */
function onboardingTier(payload) {
    const allowed = tierIds(payload.allowedTiers, 'id');
    const ineligible = new Set(tierIds(payload.ineligibleTiers, 'tierId'));
    if (allowed.includes('free-tier')) return 'free-tier';
    if (!Array.isArray(payload.allowedTiers) && !ineligible.has('free-tier')) return 'free-tier';
    const managed = (payload.allowedTiers ?? []).filter((tier) => typeof tier?.id === 'string' && tier.id
        && tier.userDefinedCloudaicompanionProject !== true && !ineligible.has(tier.id));
    return (managed.find((tier) => tier.isDefault) ?? managed[0])?.id ?? '';
}

function noTierError(payload, email) {
    const summary = tierSummary(payload);
    const blocked = payload.ineligibleTiers?.find((tier) => tier?.tierId === 'free-tier' && tier.reasonMessage)
        ?? payload.ineligibleTiers?.find((tier) => tier?.reasonMessage);
    if (blocked) {
        const reason = `${blocked.reasonMessage}\n(${summary})`;
        if (typeof blocked.validationUrl === 'string' && blocked.validationUrl) {
            return accountVerificationError(blocked.validationUrl, reason, email);
        }
        return new Error(`[antigravity-oauth] ${_scrubTokens(reason)}`);
    }
    return new Error(`[antigravity-oauth] loadCodeAssist allowed no tier to onboard (${summary})`);
}

async function provisionProject(context, tierId) {
    const deadline = Date.now() + PROJECT_TIMEOUT_MS;
    const remaining = () => {
        const ms = deadline - Date.now();
        if (ms <= 0) throw new Error(`[antigravity-oauth] onboardUser timed out after ${PROJECT_TIMEOUT_MS}ms`);
        return ms;
    };
    let operation = await requestCodeAssist('onboardUser', {
        tierId,
        metadata: codeAssistMetadata(),
    }, context, remaining());
    while (operation.done !== true) {
        await delay(Math.min(ONBOARD_INTERVAL_MS, remaining()), undefined, { signal: context.signal ?? undefined });
        const timeoutMs = remaining();
        if (typeof operation.name !== 'string' || !operation.name) {
            throw new Error('[antigravity-oauth] onboardUser returned an operation without a name');
        }
        operation = await requestCodeAssist(operation.name, undefined, context, timeoutMs);
    }
    if (operation.error != null) {
        const { code, message } = operation.error;
        const detail = message ? `${typeof code === 'number' ? `${code}: ` : ''}${message}` : JSON.stringify(operation.error);
        throw new Error(`[antigravity-oauth] onboardUser operation failed: ${_scrubTokens(detail)}`);
    }
    if (!operation.response || typeof operation.response['@type'] !== 'string') {
        throw new Error('[antigravity-oauth] invalid onboardUser response');
    }
}

/** Resolve account eligibility and return the project from a fresh status load. */
export async function discoverProject(accessToken, { fetchFn = fetch, onProgress = null, signal = null, email = '' } = {}) {
    const context = { accessToken, fetchFn, signal, email };
    onProgress?.('Checking Cloud Code Assist account status...');
    const initial = await loadProjectState(context);
    if (initial.currentTier == null) {
        const tierId = onboardingTier(initial);
        if (!tierId) throw noTierError(initial, email);
        onProgress?.(`Provisioning the Antigravity ${tierId}...`);
        await provisionProject(context, tierId);
    }
    onProgress?.('Refreshing Cloud Code Assist project...');
    const refreshed = await loadProjectState(context);
    const projectId = extractProjectId(refreshed);
    if (!projectId) throw new Error('[antigravity-oauth] loadCodeAssist did not return a cloudaicompanionProject');
    return projectId;
}

export async function exchangeAuthorizationCode({ code, verifier, fetchFn = fetch, onProgress = null, signal = null }) {
    signal?.throwIfAborted();
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
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)]) : AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`[antigravity-oauth] token exchange ${res.status}: ${_scrubTokens(text).slice(0, 300)}`);
    }
    const json = await res.json();
    if (!json?.access_token || !json?.refresh_token) {
        throw new Error('[antigravity-oauth] token exchange response missing access_token or refresh_token');
    }
    const email = await fetchAccountEmail(json.access_token, { fetchFn, signal });
    const projectId = await discoverProject(json.access_token, { fetchFn, onProgress, signal, email });
    const tokens = {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : 0,
        project_id: projectId,
        email,
    };
    signal?.throwIfAborted();
    saveTokens(tokens);
    return tokens;
}

export async function beginOAuthLogin({
    fetchFn = fetch,
    onProgress = null,
    createServerFn = createServer,
    openBrowserFn = null,
} = {}) {
    const controller = new AbortController();
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
    let settled = false;
    let exchangePromise = null;
    const acceptCode = (code) => {
        if (exchangePromise) return exchangePromise;
        controller.signal.throwIfAborted();
        // The browser deadline ends when a code arrives; network requests have
        // their own deadlines. Browser and manual callbacks share one exchange.
        if (timeout) clearTimeout(timeout);
        timeout = null;
        exchangePromise = exchangeAuthorizationCode({
            code, verifier: pkce.verifier, fetchFn, onProgress, signal: controller.signal,
        });
        exchangePromise.then(
            (tokens) => finish(tokens),
            (error) => finish(null, error instanceof Error ? error : new Error(String(error))),
        );
        return exchangePromise;
    };
    const waitForCallback = new Promise((resolvePromise, reject) => {
        finish = (value, error = null) => {
            if (settled) return;
            settled = true;
            controller.abort();
            if (timeout) clearTimeout(timeout);
            try { server?.close(); } catch { /* already closed */ }
            if (error) reject(error);
            else resolvePromise(value);
        };
        server = createServerFn(async (req, res) => {
            const requestUrl = new URL(req.url || '/', `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
            if (requestUrl.pathname !== CALLBACK_PATH) {
                res.writeHead(404);
                res.end();
                return;
            }
            if (requestUrl.searchParams.get('state') !== state) {
                res.writeHead(400);
                res.end('Invalid OAuth state');
                return;
            }
            const authorizationError = requestUrl.searchParams.get('error');
            if (authorizationError) {
                const detail = requestUrl.searchParams.get('error_description') || authorizationError;
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(CALLBACK_FAILURE_HTML);
                // A late denial must not cancel an already accepted code.
                if (!exchangePromise) {
                    finish(null, new Error(`[antigravity-oauth] authorization failed: ${_scrubTokens(detail)}`));
                }
                return;
            }
            const code = requestUrl.searchParams.get('code')?.trim();
            if (!code) {
                res.writeHead(400);
                res.end('Missing authorization code');
                return;
            }
            try {
                await acceptCode(code);
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><body><h2>Antigravity connected.</h2><p>You can close this tab.</p></body></html>');
            } catch {
                // The shared exchange reports its error through waitForCallback.
                // Do not interpolate provider-controlled text into browser HTML.
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end(CALLBACK_FAILURE_HTML);
            }
        });
        timeout = setTimeout(() => finish(
            null,
            new Error(`[antigravity-oauth] browser authentication timed out after ${LOGIN_TIMEOUT_MS}ms`),
        ), LOGIN_TIMEOUT_MS);
        if (timeout.unref) timeout.unref();
        server.on('error', (err) => finish(
            null,
            new Error(`[antigravity-oauth] callback server failed on ${CALLBACK_HOST}:${CALLBACK_PORT}: ${err?.message || err}`),
        ));
        server.listen(CALLBACK_PORT, CALLBACK_HOST, async () => {
            if (settled) return;
            process.stderr.write(`\n[antigravity-oauth] Open this URL to log in:\n${url.toString()}\n\n`);
            try {
                if (openBrowserFn) await openBrowserFn(url.toString());
                else {
                    const { openInBrowser } = await import('../../../shared/open-url.mjs');
                    if (!settled) await openInBrowser(url.toString());
                }
            } catch (err) {
                process.stderr.write(`[antigravity-oauth] browser open failed: ${String(err?.message || err).slice(0, 200)}\n`);
            }
        });
    });

    return {
        provider: 'antigravity-oauth',
        url: url.toString(),
        waitForCallback,
        completeCode: async (input) => {
            const parsed = parseOAuthCodeInput(input, { allowHashState: true });
            if (parsed.state && parsed.state !== state) throw new Error('[antigravity-oauth] OAuth state mismatch');
            if (!parsed.code) throw new Error('[antigravity-oauth] authorization code is required');
            return await acceptCode(parsed.code);
        },
        cancel: () => { finish?.(null); },
    };
}

export async function loginOAuth() {
    const login = await beginOAuthLogin();
    return await login.waitForCallback;
}
