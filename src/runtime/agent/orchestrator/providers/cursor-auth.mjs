import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { writeJsonAtomicSync, withFileLock } from '../../../shared/atomic-file.mjs';
import { boundProviderAuthPath } from '../../../shared/provider-auth-binding.mjs';
import { openInBrowser } from '../../../shared/open-url.mjs';

const LOGIN_URL = 'https://cursor.com/loginDeepControl';
const POLL_URL = 'https://api2.cursor.sh/auth/poll';
const REFRESH_URL = 'https://api2.cursor.sh/auth/exchange_user_api_key';
const REFRESH_SKEW_MS = 5 * 60_000;
// Upper bound for the SHARED token exchange. It replaces the first caller's
// abort signal, which must never govern work every other waiter depends on.
const REFRESH_TIMEOUT_MS = 30_000;
let refreshInFlight = null;

// Wait on the shared refresh while still honouring THIS caller's abort signal.
// Aborting only ends this caller's wait; the exchange keeps running for the
// remaining waiters and still publishes its result.
function awaitSharedRefresh(promise, signal) {
    if (!(signal instanceof AbortSignal)) return promise;
    const abortError = () => (signal.reason instanceof Error
        ? signal.reason
        : new Error('Cursor token refresh wait aborted'));
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
            (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
        );
    });
}

function credentialsPath() {
    const bound = boundProviderAuthPath('cursor-oauth');
    if (bound) return resolve(bound);
    const explicit = process.env.CURSOR_OAUTH_CREDENTIALS_PATH;
    if (explicit) return resolve(explicit);
    const dir = resolvePluginData();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, 'cursor-oauth.json');
}

export function cursorTokenExpiry(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3 || !parts[1]) return 0;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return Number(payload?.exp) > 0 ? Number(payload.exp) * 1000 : 0;
    } catch {
        return 0;
    }
}

function loadStoredCredentials() {
    if (process.env.CURSOR_ACCESS_TOKEN) {
        return {
            access_token: process.env.CURSOR_ACCESS_TOKEN,
            refresh_token: null,
            expires_at: cursorTokenExpiry(process.env.CURSOR_ACCESS_TOKEN),
            source: 'CURSOR_ACCESS_TOKEN',
        };
    }
    const path = credentialsPath();
    if (!existsSync(path)) return null;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        if (!raw?.access_token) return null;
        return {
            ...raw,
            expires_at: Number(raw.expires_at) || cursorTokenExpiry(raw.access_token),
            source: 'Mixdog token store',
        };
    } catch {
        return null;
    }
}

function saveCredentials(tokens) {
    writeJsonAtomicSync(credentialsPath(), tokens, {
        lock: true,
        fsyncDir: true,
        mode: 0o600,
        secret: true,
    });
}

export function hasCursorOAuthCredentials() {
    const tokens = loadStoredCredentials();
    if (!tokens?.access_token) return false;
    const expiresAt = Number(tokens.expires_at) || 0;
    return expiresAt === 0 || expiresAt > Date.now() || Boolean(tokens.refresh_token);
}

export function describeCursorOAuthCredentials() {
    const tokens = loadStoredCredentials();
    if (!tokens?.access_token) {
        return {
            authenticated: false,
            usable: false,
            refreshable: false,
            reauthRequired: false,
            status: 'Not Set',
            detail: 'Mixdog token store or CURSOR_ACCESS_TOKEN',
        };
    }
    const expiresAt = Number(tokens.expires_at) || 0;
    const expired = expiresAt > 0 && expiresAt <= Date.now();
    const expiring = expiresAt > 0 && expiresAt <= Date.now() + REFRESH_SKEW_MS;
    const refreshable = Boolean(tokens.refresh_token);
    const reauthRequired = expired && !refreshable;
    return {
        authenticated: !reauthRequired,
        usable: !expired,
        refreshable,
        reauthRequired,
        status: reauthRequired ? 'Reauth Required' : expired ? 'Refresh Required' : expiring ? 'Refresh Soon' : refreshable ? 'Valid' : 'Access Only',
        detail: tokens.source || 'Cursor OAuth',
        expiresAt: expiresAt || null,
    };
}

export function forgetCursorOAuthCredentials() {
    const path = credentialsPath();
    if (!existsSync(path)) return { removed: false };
    unlinkSync(path);
    return { removed: true };
}

export function generateCursorOAuthParams() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const uuid = randomUUID();
    const params = new URLSearchParams({
        challenge,
        uuid,
        mode: 'login',
        redirectTarget: 'cli',
    });
    return { verifier, challenge, uuid, loginUrl: `${LOGIN_URL}?${params}` };
}

export async function exchangeCursorToken(token, { fetchFn = fetch, signal } = {}) {
    const response = await fetchFn(REFRESH_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: '{}',
        signal,
        redirect: 'error',
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const error = new Error(`Cursor token exchange failed (${response.status})${detail ? `: ${detail}` : ''}`);
        error.status = response.status;
        throw error;
    }
    const data = await response.json();
    if (!data?.accessToken) throw new Error('Cursor token exchange returned no access token');
    return {
        access_token: data.accessToken,
        refresh_token: data.refreshToken || token,
        expires_at: cursorTokenExpiry(data.accessToken) || Date.now() + 60 * 60_000,
    };
}

export async function pollCursorOAuth(uuid, verifier, {
    fetchFn = fetch,
    signal,
    delayFn = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
    maxAttempts = 150,
} = {}) {
    let delay = 1000;
    let consecutiveErrors = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Cursor OAuth cancelled');
        await delayFn(delay);
        try {
            const response = await fetchFn(`${POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`, { signal });
            if (response.status === 404) {
                consecutiveErrors = 0;
                delay = Math.min(Math.ceil(delay * 1.2), 10_000);
                continue;
            }
            if (!response.ok) throw new Error(`Cursor OAuth failed (${response.status})`);
            const data = await response.json();
            if (!data?.accessToken) throw new Error('Cursor OAuth returned no access token');
            return {
                access_token: data.accessToken,
                refresh_token: data.refreshToken,
                expires_at: cursorTokenExpiry(data.accessToken) || Date.now() + 60 * 60_000,
            };
        } catch (error) {
            if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
            consecutiveErrors += 1;
            if (consecutiveErrors >= 3) throw error;
        }
    }
    throw new Error('Cursor OAuth timed out');
}

export async function beginCursorOAuthLogin(options = {}) {
    const params = generateCursorOAuthParams();
    const controller = new AbortController();
    process.stderr.write(`\n[cursor-oauth] Open the Cursor sign-in page:\n${params.loginUrl}\n\n`);
    openInBrowser(params.loginUrl);
    const waitForCallback = pollCursorOAuth(params.uuid, params.verifier, {
        ...options,
        signal: controller.signal,
    }).then((tokens) => {
        saveCredentials(tokens);
        return tokens;
    });
    return {
        provider: 'cursor-oauth',
        url: params.loginUrl,
        manualUrl: null,
        waitForCallback,
        cancel: () => controller.abort(new Error('Cursor OAuth cancelled')),
    };
}

export async function loginCursorOAuth() {
    const login = await beginCursorOAuthLogin();
    return await login.waitForCallback;
}

export async function resolveCursorOAuthAccessToken({ forceRefresh = false, fetchFn = fetch, signal } = {}) {
    let tokens = loadStoredCredentials();
    if (!tokens?.access_token) throw new Error('Cursor OAuth is not connected. Open /providers in Mixdog to sign in.');
    const expiring = tokens.expires_at > 0 && tokens.expires_at <= Date.now() + REFRESH_SKEW_MS;
    if (!forceRefresh && !expiring) return tokens.access_token;
    if (!tokens.refresh_token) {
        if (!tokens.expires_at || tokens.expires_at > Date.now()) return tokens.access_token;
        throw new Error('Cursor access token expired and has no refresh token. Open /providers in Mixdog to sign in again.');
    }
    if (!refreshInFlight) {
        const startingTokens = tokens;
        const refreshPath = credentialsPath();
        refreshInFlight = withFileLock(`${refreshPath}.refresh.lock`, async () => {
            const latest = loadStoredCredentials() || startingTokens;
            const validAfter = Date.now() + (forceRefresh ? 0 : REFRESH_SKEW_MS);
            const generationChanged = latest.access_token !== startingTokens.access_token
                || latest.refresh_token !== startingTokens.refresh_token;
            if (generationChanged && (!latest.expires_at || latest.expires_at > validAfter)) {
                return latest;
            }
            if (!latest.refresh_token) {
                throw new Error('Cursor OAuth refresh token is unavailable. Open /providers in Mixdog to sign in again.');
            }
            // Deliberately NOT the caller's signal: this exchange is shared by
            // every concurrent waiter, so letting the first caller's abort
            // (turn cancel / session close) kill it would fail the refresh for
            // all of them and leave the process without a usable token. Its own
            // timeout bounds the request instead.
            const next = await exchangeCursorToken(latest.refresh_token, {
                fetchFn,
                signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
            });
            if (!process.env.CURSOR_ACCESS_TOKEN) {
                saveCredentials(next);
            }
            return next;
        }, {
            timeoutMs: 120_000,
            staleMs: 120_000,
            secret: true,
        })
            .finally(() => { refreshInFlight = null; });
        // Every waiter may abandon its wait; keep the shared rejection observed.
        refreshInFlight.catch(() => {});
    }
    tokens = await awaitSharedRefresh(refreshInFlight, signal);
    return tokens.access_token;
}
