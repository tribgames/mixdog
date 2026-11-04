// Sign-in and sign-out landing while a refresh holds a provider's token-store
// lock must wait for it: a synchronous writer against the asynchronous holder
// fails with ELOCKCONTENDED instead of saving the new login.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'oauth-interleave-')));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
delete process.env.OPENAI_OAUTH_CREDENTIALS_PATH;
delete process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH;
process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH = join(dir, 'anthropic-oauth-credentials.json');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const { withFileLock } = await import('../../../shared/atomic-file.mjs');
const openai = await import('./openai-oauth-tokens.mjs');
const antigravity = await import('./antigravity-oauth-tokens.mjs');
const anthropic = await import('./anthropic-oauth-credentials.mjs');

// The writer is started while another (async) holder owns the store lock.
async function whileLockHeld(storePath, start) {
  let writer;
  await withFileLock(`${storePath}.lock`, async () => {
    writer = Promise.resolve().then(start);
    writer.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  return writer;
}

test('openai sign-in waits for a refresh holding the token lock', async () => {
  const path = openai.getOwnTokenPath();
  await whileLockHeld(path, () => openai.saveTokens({ access_token: 'at-new', refresh_token: 'rt-new' }));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).access_token, 'at-new');
});

test('antigravity sign-in and sign-out wait for a refresh holding the token lock', async () => {
  const path = antigravity.getOwnTokenPath();
  await whileLockHeld(path, () => antigravity.saveTokens({ access_token: 'at-new', refresh_token: 'rt-new' }));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).access_token, 'at-new');
  assert.equal(await whileLockHeld(path, () => antigravity.forgetAntigravityOAuthCredentials()), true);
});

// A token endpoint whose reply is held until `release()`; `started` settles
// once the exchange is in flight.
function heldExchange(reply) {
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  return {
    started: started.promise,
    release: () => gate.resolve(),
    fetch: async () => {
      started.resolve();
      await gate.promise;
      return new Response(JSON.stringify(reply), { status: 200 });
    },
  };
}

const grant = { access_token: 'at-refreshed', refresh_token: 'rt-refreshed', expires_in: 3600 };

test('openai sign-out after an in-flight save leaves the credentials gone', async () => {
  const path = openai.getOwnTokenPath();
  await openai.saveTokens({ access_token: 'at-old', refresh_token: 'rt-old' });
  const saving = openai.saveTokens({ access_token: 'at-late', refresh_token: 'rt-late' });
  const forgotten = openai.forgetOpenAIOAuthCredentials();
  await saving;
  assert.deepEqual(await forgotten, { removed: true });
  assert.equal(existsSync(path), false);
});

test('openai sign-out during a refresh exchange is not undone by the refresh', async (t) => {
  const path = openai.getOwnTokenPath();
  await openai.saveTokens({ access_token: 'at-old', refresh_token: 'rt-old', expires_at: Date.now() - 1000 });
  const exchange = heldExchange(grant);
  const realFetch = globalThis.fetch;
  globalThis.fetch = exchange.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const refreshing = openai.refreshStoredTokens({ current: openai.loadTokens(), force: true });
  refreshing.catch(() => {});
  await exchange.started;
  await openai.forgetOpenAIOAuthCredentials();
  exchange.release();
  await assert.rejects(refreshing, (err) => err.reauthRequired === true);
  assert.equal(existsSync(path), false);
});

test('openai sign-in during a refresh exchange is not overwritten by the refresh', async (t) => {
  const path = openai.getOwnTokenPath();
  await openai.saveTokens({ access_token: 'at-old', refresh_token: 'rt-old', expires_at: Date.now() - 1000 });
  const exchange = heldExchange(grant);
  const realFetch = globalThis.fetch;
  globalThis.fetch = exchange.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const refreshing = openai.refreshStoredTokens({ current: openai.loadTokens(), force: true });
  await exchange.started;
  await openai.saveTokens({ access_token: 'at-login', refresh_token: 'rt-login', expires_at: Date.now() + 3_600_000 });
  exchange.release();
  assert.equal((await refreshing).tokens.access_token, 'at-login');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).access_token, 'at-login');
  await openai.forgetOpenAIOAuthCredentials();
});

test('antigravity sign-out after an in-flight first sign-in leaves the credentials gone', async () => {
  rmSync(antigravity.getOwnTokenPath(), { force: true });
  const saving = antigravity.saveTokens({ access_token: 'at-late', refresh_token: 'rt-late' });
  const forgotten = antigravity.forgetAntigravityOAuthCredentials();
  await saving;
  assert.equal(await forgotten, true);
  assert.equal(antigravity.loadTokens(), null);
});

test('antigravity sign-out during a refresh exchange is not undone by the refresh', async () => {
  await antigravity.saveTokens({ access_token: 'at-old', refresh_token: 'rt-old', expires_at: 1 });
  const exchange = heldExchange(grant);
  const refreshing = antigravity.refreshTokens({ fetchFn: exchange.fetch });
  refreshing.catch(() => {});
  await exchange.started;
  assert.equal(await antigravity.forgetAntigravityOAuthCredentials(), true);
  exchange.release();
  await assert.rejects(refreshing, (err) => err.reauthRequired === true);
  assert.equal(antigravity.loadTokens(), null);
});

test('anthropic sign-out during a refresh exchange is not undone by the refresh', async (t) => {
  const path = process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH;
  writeFileSync(
    path,
    JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1, scopes: ['user:inference'] } })
  );
  const exchange = heldExchange(grant);
  const realFetch = globalThis.fetch;
  globalThis.fetch = exchange.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const refreshing = anthropic.refreshOAuthCredentials(anthropic.loadCredentials());
  refreshing.catch(() => {});
  await exchange.started;
  assert.deepEqual(await anthropic.forgetAnthropicOAuthCredentials(), { removed: true });
  exchange.release();
  await assert.rejects(refreshing, (err) => err.reauthRequired === true);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).claudeAiOauth, undefined);
});

test('anthropic sign-out waits for a refresh holding the credentials lock', async () => {
  const path = process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }));
  const result = await whileLockHeld(path, () => anthropic.forgetAnthropicOAuthCredentials());
  assert.deepEqual(result, { removed: true });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).claudeAiOauth, undefined);
});
