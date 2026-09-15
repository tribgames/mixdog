import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';

// ---------------------------------------------------------------------------
// Credential isolation. This suite writes and DELETES the openai-oauth token
// file, so the store is pinned inside a unique temp directory before any
// module import and before any filesystem operation:
//   - MIXDOG_DATA_DIR relocates the whole data dir;
//   - OPENAI_OAUTH_CREDENTIALS_PATH is cleared, because the store honours it
//     and an operator value would point at real credentials;
//   - an explicit provider auth binding outranks both, so the resolved path
//     cannot depend on the ambient account roster either.
// Every destructive helper re-resolves the path and re-asserts containment,
// and cleanup restores the environment in a finally. No operator credential
// file is read, written or deleted by this suite.
// ---------------------------------------------------------------------------
const sandbox = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'mixdog-openai-tokens-')));
const sandboxTokenPath = join(sandbox, 'openai-oauth.json');
const previousEnv = {
    dataDir: process.env.MIXDOG_DATA_DIR,
    credentialsPath: process.env.OPENAI_OAUTH_CREDENTIALS_PATH,
};
process.env.MIXDOG_DATA_DIR = sandbox;
delete process.env.OPENAI_OAUTH_CREDENTIALS_PATH;

const { replaceProviderAuthBindings } = await import('../../../shared/provider-auth-binding.mjs');
const restoreAuthBindings = replaceProviderAuthBindings({ 'openai-oauth': sandboxTokenPath });

let restored = false;
function restoreEnvironment() {
    if (restored) return;
    restored = true;
    try {
        restoreAuthBindings();
    } finally {
        if (previousEnv.dataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
        else process.env.MIXDOG_DATA_DIR = previousEnv.dataDir;
        if (previousEnv.credentialsPath === undefined) delete process.env.OPENAI_OAUTH_CREDENTIALS_PATH;
        else process.env.OPENAI_OAUTH_CREDENTIALS_PATH = previousEnv.credentialsPath;
        rmSync(sandbox, { recursive: true, force: true });
    }
}

/** Hard stop before any write/delete that escaped the sandbox. */
function sandboxPath(candidate) {
    const full = resolve(candidate);
    if (!full.startsWith(sandbox + sep)) {
        restoreEnvironment();
        throw new Error(`refusing to touch a credential path outside the test sandbox: ${full}`);
    }
    return full;
}

let modules;
try {
    modules = {
        tokens: await import('./openai-oauth-tokens.mjs'),
        provider: await import('./openai-oauth.mjs'),
    };
    sandboxPath(modules.tokens.getOwnTokenPath());
} catch (err) {
    restoreEnvironment();
    throw err;
}
const {
    describeOpenAIOAuthCredentials,
    forgetOpenAIOAuthCredentials,
    getOwnTokenPath,
    hasOpenAIOAuthCredentials,
    refreshStoredTokens,
} = modules.tokens;
const { OpenAIOAuthProvider } = modules.provider;

test.after(restoreEnvironment);

function writeStoredTokens(tokens) {
    const target = sandboxPath(getOwnTokenPath());
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(tokens), 'utf-8');
}

function clearStoredTokens() {
    rmSync(sandboxPath(getOwnTokenPath()), { force: true });
}

/** Fails the test if the credential store reaches the network. */
function denyNetwork(t) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('token refresh must not reach the network here'); };
    t.after(() => { globalThis.fetch = realFetch; });
}

test('credential description reports store state without a refresh', (t) => {
    denyNetwork(t);
    clearStoredTokens();
    assert.equal(hasOpenAIOAuthCredentials(), false);
    assert.deepEqual(describeOpenAIOAuthCredentials(), {
        authenticated: false, usable: false, refreshable: false, reauthRequired: false,
        status: 'Not Set', detail: 'Mixdog token store',
    });

    writeStoredTokens({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 60 * 60_000 });
    assert.equal(hasOpenAIOAuthCredentials(), true);
    assert.equal(describeOpenAIOAuthCredentials().status, 'Valid');

    // Seconds-based expiry is normalized to milliseconds, not read as 1970.
    writeStoredTokens({ access_token: 'a', refresh_token: 'r', expires_at: Math.floor((Date.now() + 60 * 60_000) / 1000) });
    assert.equal(describeOpenAIOAuthCredentials().status, 'Valid');

    writeStoredTokens({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 60_000 });
    assert.equal(describeOpenAIOAuthCredentials().status, 'Refresh Soon');

    writeStoredTokens({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() - 60_000 });
    const expired = describeOpenAIOAuthCredentials();
    assert.equal(expired.status, 'Refresh Required');
    assert.equal(expired.usable, false);
    assert.equal(expired.refreshable, true);

    assert.deepEqual(forgetOpenAIOAuthCredentials(), { removed: true });
    assert.equal(hasOpenAIOAuthCredentials(), false);
    assert.deepEqual(forgetOpenAIOAuthCredentials(), { removed: false });
});

test('a refresh adopts tokens another writer already stored instead of spending one', async (t) => {
    denyNetwork(t);
    writeStoredTokens({ access_token: 'fresh', refresh_token: 'r2', expires_at: Date.now() + 60 * 60_000 });
    const result = await refreshStoredTokens({
        current: { access_token: 'stale', refresh_token: 'r1', expires_at: Date.now() + 1_000 },
    });
    assert.equal(result.tokens.access_token, 'fresh');
    assert.equal(result.coastOnCurrent, false);
});

test('a refresh that cannot run coasts on a still-valid token', async (t) => {
    denyNetwork(t);
    clearStoredTokens();
    // No stored refresh token: the session keeps the access token it still
    // holds and reports the coast window instead of failing the turn.
    const current = { access_token: 'only-access', expires_at: Date.now() + 10 * 60_000 };
    const result = await refreshStoredTokens({ current });
    assert.equal(result.tokens, current);
    assert.equal(result.coastOnCurrent, true);
});

test('the coast window stays with the instance that attempted the refresh', async (t) => {
    denyNetwork(t);
    clearStoredTokens();
    const current = { access_token: 'only-access', expires_at: Date.now() + 10 * 60_000 };
    // Two provider instances sharing this process's credential store. The
    // second joins the first one's in-flight refresh; adopting its tokens must
    // not arm a coast window it never attempted, which would silently skip the
    // waiter's own next-turn refresh.
    const instances = [0, 1].map(() => {
        const provider = Object.create(OpenAIOAuthProvider.prototype);
        provider.tokens = current;
        provider._refreshFallbackUntil = 0;
        return provider;
    });
    const [attempting, waiting] = instances;
    await Promise.all(instances.map(provider => provider._refreshTokens({})));

    assert.ok(attempting._refreshFallbackUntil > Date.now(), 'the attempting instance coasts until the expiry skew');
    assert.equal(waiting._refreshFallbackUntil, 0, 'a waiter keeps its own refresh schedule');
    assert.equal(attempting.tokens, current);
    assert.equal(waiting.tokens, current);
});

test('a forced refresh without credentials asks for re-authentication', async (t) => {
    denyNetwork(t);
    clearStoredTokens();
    await assert.rejects(
        () => refreshStoredTokens({ current: null, force: true }),
        /refresh token not available/,
    );
});
