import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-proxy-measurement-identity-'));
const path = join(dir, 'fixture-credentials.json');
process.env.MIXDOG_DATA_DIR = dir;
process.env.OPENAI_OAUTH_CREDENTIALS_PATH = path;
delete process.env.MIXDOG_MODEL_PROXY;
after(() => rmSync(dir, { recursive: true, force: true }));

const provider = 'openai-oauth';
const identity = { id: 'user-B' };
const account = `proxy-${createHash('sha256')
  .update(JSON.stringify(['review-owner', provider, 'default', identity]))
  .digest('hex')}`;
const payload = { rate_limit: { primary_window: { used_percent: 88 } } };

test('real OpenAI auth with an older-mtime replacement cannot publish A quota under confirmed B history', async (t) => {
  let owner = 'A';
  const originals = { statSync: fs.statSync, readFileSync: fs.readFileSync, existsSync: fs.existsSync };
  const metadata = {
    A: { mtimeMs: 2000, ctimeMs: 2000, size: 200, ino: 1 },
    B: { mtimeMs: 1000, ctimeMs: 3000, size: 200, ino: 2 },
  };
  fs.statSync = (file, ...args) => file === path ? metadata[owner] : originals.statSync(file, ...args);
  fs.existsSync = (file) => file === path || originals.existsSync(file);
  fs.readFileSync = (file, ...args) => file === path
    ? JSON.stringify({
        access_token: `fixture-${owner}`,
        refresh_token: 'fixture-refresh',
        identity: { id: `user-${owner}` },
        expires_at: Date.now() + 3_600_000,
        account_id: `workspace-${owner}`,
      })
    : originals.readFileSync(file, ...args);
  syncBuiltinESMExports();
  t.after(() => {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  });
  const { OpenAIOAuthProvider } = await import('./openai-oauth.mjs');
  const { loadTokens } = await import('./openai-oauth-tokens.mjs');
  const { providerUsageAccounts } = await import('../../../../session-runtime/services/provider-admin.mjs');
  const { createModelProxyUsage } = await import('./model-proxy-usage-host.mjs');
  // Skip the constructor's real socket preconnect, not the real token loader
  // or ensureAuth implementation that exhibits the mtime-only reload behavior.
  const adapter = Object.create(OpenAIOAuthProvider.prototype);
  adapter.tokens = loadTokens();
  assert.equal(adapter.tokens.identity.id, 'user-A');
  owner = 'B';
  assert.deepEqual(providerUsageAccounts(provider).accounts[0].identity, identity);
  assert.equal((await adapter.ensureAuth()).identity.id, 'user-A', 'the real adapter still holds A');
  const authorization = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    authorization.push(options.headers.Authorization);
    return { ok: true, json: async () => payload };
  });
  const usage = createModelProxyUsage({ owner: () => 'review-owner' });
  assert.deepEqual(await usage.snapshot(provider, adapter), {
    status: 'unavailable', accounts: [account], account,
  });
  assert.deepEqual(authorization, [], 'a known wrong adapter is not measured');

  const fresh = Object.create(OpenAIOAuthProvider.prototype);
  fresh.tokens = null;
  const ready = await usage.snapshot(provider, fresh, { force: true });
  assert.equal(ready.status, 'ready', 'fresh lazy auth is allowed to load B');
  assert.equal(ready.account, account);
  assert.equal(ready.snapshot.quotaWindows[0].usedPct, 88);
  assert.deepEqual(authorization, ['Bearer fixture-B', 'Bearer fixture-B']);
  assert.equal(fresh.tokens.identity.id, 'user-B');
});

for (const change of ['auth-return', 'after-measurement', 'lazy-mismatch']) {
  test(`${change}: adapter identity is checked at auth and measurement completion, independently of roster stability`, async (t) => {
    const { createModelProxyUsage } = await import('./model-proxy-usage-host.mjs');
    const adapter = {
      tokens: change === 'lazy-mismatch' ? null : { identity },
      async ensureAuth() {
        if (change === 'lazy-mismatch') this.tokens = { identity: { id: 'user-A' } };
        return change === 'auth-return' ? { access_token: 'fixture-A', identity: { id: 'user-A' } } : {
          ...this.tokens,
          access_token: 'fixture-B',
        };
      },
    };
    let fetched = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      fetched += 1;
      adapter.tokens = { identity: { id: 'user-A' } };
      return { ok: true, json: async () => payload };
    });
    const usage = createModelProxyUsage({
      owner: () => 'review-owner',
      accounts: () => ({
        selectedId: 'default',
        accounts: [{ id: 'default', authenticated: true, identity, version: 'unchanged-file-evidence' }],
      }),
    });
    assert.deepEqual(await usage.snapshot(provider, adapter), {
      status: 'unavailable', accounts: [account], account,
    });
    assert.equal(fetched, change === 'after-measurement' ? 2 : 0);
  });
}

for (const [name, tokens] of [
  ['grok-oauth', { user_id: 'user-A' }],
  ['antigravity-oauth', { user_id: 'user-A' }],
  ['muse-code-oauth', { accountId: 'user-A' }],
  ['command-code-oauth', { userId: 'user-A' }],
]) {
  test(`${name}: a known source-format adapter identity cannot be assigned another account's measurement`, async () => {
    const { createModelProxyUsage } = await import('./model-proxy-usage-host.mjs');
    let measured = false;
    const usage = createModelProxyUsage({
      owner: () => 'review-owner',
      accounts: () => ({
        selectedId: 'default',
        accounts: [{ id: 'default', authenticated: true, identity, version: 'stable-file-evidence' }],
      }),
      fetchUsage: async () => {
        measured = true;
        return { cachedAt: Date.now(), quotaWindows: [{ label: '5H', usedPct: 88 }] };
      },
    });
    const reply = await usage.snapshot(name, { tokens, getUsageSnapshot() {} });
    assert.equal(reply.status, 'unavailable');
    assert.equal(reply.accounts.length, 1, 'current independently confirmed history remains readable');
    assert.equal(reply.account, reply.accounts[0]);
    assert.equal(measured, false);
  });
}
