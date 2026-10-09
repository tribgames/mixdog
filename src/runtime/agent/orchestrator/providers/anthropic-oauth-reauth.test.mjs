import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never let these tests resolve the real data dir: a dead-grant mark there
// would touch a live account.
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-anthropic-reauth-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const credentialsPath = join(dataDir, 'anthropic-oauth-credentials.json');
process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH = credentialsPath;
delete process.env.MIXDOG_ANTHROPIC_OAUTH_REFRESH_DISABLED;

const { isDefinitiveOAuthFailure } = await import('./lib/oauth-token-utils.mjs');
const { refreshOAuthCredentials, describeAnthropicOAuthCredentials, loadCredentials } = await import(
  './anthropic-oauth-credentials.mjs'
);

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const DEAD_BODY = '{"error": "invalid_grant", "error_description": "Refresh token expired"}';

function writeCredentials(oauth) {
  writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: oauth }), 'utf8');
}

function readOauth() {
  return JSON.parse(readFileSync(credentialsPath, 'utf8')).claudeAiOauth;
}

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return handler(calls.length);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const expiring = () => ({
  accessToken: 'access-old',
  refreshToken: 'refresh-old',
  expiresAt: Date.now() - 1_000,
  scopes: ['user:inference'],
});

test('definitive OAuth failures are dead grants, never transient refusals', () => {
  for (const [text, status] of [
    [DEAD_BODY, 400],
    ['{"error":"invalid_token"}', 400],
    ['unauthorized_client', 400],
    ['refresh token revoked', 400],
    ['Unauthorized', 401],
  ]) {
    assert.equal(isDefinitiveOAuthFailure(text, status), true, text);
  }
  for (const [text, status] of [
    ['Forbidden', 403],
    ['too many requests', 429],
    ['bad gateway', 502],
    ['fetch failed: ECONNRESET', 0],
    ['401 unauthorized — 429 too many requests', 401],
    ['{"error":"invalid_request"}', 400],
  ]) {
    assert.equal(isDefinitiveOAuthFailure(text, status), false, text);
  }
});

test('a dead grant marks the account without destroying its tokens', async (t) => {
  writeCredentials(expiring());
  const calls = stubFetch(t, () => new Response(DEAD_BODY, { status: 400 }));

  await assert.rejects(refreshOAuthCredentials(loadCredentials()), (err) => {
    assert.equal(err.reauthRequired, true);
    assert.match(err.message, /^Anthropic sign-in expired\. Sign in again from Providers\./);
    assert.match(err.message, /token refresh 400/);
    assert.doesNotMatch(err.message, /refresh-old/);
    return true;
  });
  assert.equal(calls.length, 1);

  const stored = readOauth();
  assert.equal(stored.refreshToken, 'refresh-old', 'the refresh token is kept');
  assert.equal(stored.accessToken, 'access-old');
  assert.equal(stored.reauthRequired, true);

  const status = describeAnthropicOAuthCredentials();
  assert.equal(status.reauthRequired, true);
  assert.equal(status.status, 'Reauth Required');
});

test('a transient refusal leaves the account unmarked', async (t) => {
  writeCredentials(expiring());
  stubFetch(t, () => new Response('Forbidden', { status: 403 }));

  await assert.rejects(refreshOAuthCredentials(loadCredentials()), (err) => err.reauthRequired !== true);
  assert.equal(readOauth().reauthRequired, undefined);
});

test('a rotation written by another process during the failed exchange is adopted', async (t) => {
  writeCredentials(expiring());
  stubFetch(t, () => {
    writeCredentials({
      accessToken: 'access-peer',
      refreshToken: 'refresh-peer',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:inference'],
    });
    return new Response(DEAD_BODY, { status: 400 });
  });

  const result = await refreshOAuthCredentials(loadCredentials());
  assert.equal(result.accessToken, 'access-peer');
  const stored = readOauth();
  assert.equal(stored.refreshToken, 'refresh-peer');
  assert.equal(stored.reauthRequired, undefined, 'the peer generation is not marked dead');
});

test('a successful refresh clears an earlier reauth mark', async (t) => {
  writeCredentials({ ...expiring(), reauthRequired: true });
  stubFetch(
    t,
    () =>
      new Response(JSON.stringify({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }), {
        status: 200,
      })
  );

  const result = await refreshOAuthCredentials(loadCredentials());
  assert.equal(result.accessToken, 'access-new');
  const stored = readOauth();
  assert.equal(stored.refreshToken, 'refresh-new');
  assert.equal('reauthRequired' in stored, false);
});
