import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-proxy-default-lifecycle-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.OPENAI_OAUTH_CREDENTIALS_PATH = join(dir, 'fixture-credentials.json');
delete process.env.MIXDOG_MODEL_PROXY;
after(() => rmSync(dir, { recursive: true, force: true }));

const tokens = await import('./openai-oauth-tokens.mjs');
const provider = 'openai-oauth';
const identity = { id: 'same-login-A' };
const credential = (session) => ({
  access_token: `fixture-access-${session}`,
  refresh_token: `fixture-refresh-${session}`,
  identity,
  account_id: 'fixture-workspace',
  expires_at: Date.now() + 3_600_000,
});
let starts = 0;
// Only the interactive OAuth boundary is mocked. Completion writes through
// the real credential store, while admin settles/registers the real account.
mock.module(new URL('./openai-oauth-tokens.mjs', import.meta.url).href, {
  namedExports: {
    ...tokens,
    async beginOAuthLogin() {
      starts += 1;
      return {
        url: 'https://fixture.invalid/oauth',
        async completeCode(code) {
          assert.equal(code, 'offline-redirect-code');
          tokens.saveTokens(credential('signed-in-again'));
          return { success: true };
        },
      };
    },
  },
});
const {
  beginOAuthProviderLogin,
  forgetProviderAuth,
  listProviderAccounts,
  materializeProviderAccounts,
  providerUsageAccounts,
} = await import('../../../../session-runtime/services/provider-admin.mjs');
const { readProviderAccountPool } = await import('../../../shared/provider-accounts.mjs');
const { createModelProxyUsage } = await import('./model-proxy-usage-host.mjs');
const reading = () => ({ cachedAt: Date.now(), quotaWindows: [{ label: '5H', usedPct: 9 }] });
const adapter = () => ({ tokens: tokens.loadTokens() });
const makeUsage = () => createModelProxyUsage({ owner: () => 'lifecycle-owner', fetchUsage: async () => reading() });
let config = { providers: { [provider]: { enabled: true } } };
const cfg = { loadConfig: () => config, saveConfig: (next) => { config = next; } };

test('full offline forget/login lifecycle splits the default scope, but materialization and refresh do not', async () => {
  tokens.saveTokens(credential('implicit'));
  assert.equal(readProviderAccountPool(provider).accounts.length, 0);
  const usage = makeUsage();
  const initial = await usage.snapshot(provider, adapter());
  assert.equal(initial.status, 'ready');
  const materialized = await materializeProviderAccounts(provider);
  assert.equal(materialized.selectedId, 'default');
  assert.equal((await usage.snapshot(provider, adapter(), { force: true })).account, initial.account);
  tokens.saveTokens(credential('refreshed'));
  assert.equal((await usage.snapshot(provider, adapter(), { force: true })).account, initial.account);

  const forgotten = await forgetProviderAuth(cfg, provider, 'default');
  assert.equal(forgotten.removed, true);
  assert.equal(readProviderAccountPool(provider).accounts.length, 0);
  assert.equal(listProviderAccounts(provider).accounts.length, 0);
  assert.equal(config.providers[provider].enabled, false);
  const epoch = JSON.parse(readFileSync(join(dir, 'provider-accounts.json'), 'utf8')).defaultAccountEpochs[provider];
  assert.match(epoch, /^[a-f0-9-]{36}$/);
  // No usage read occurs between removal and completion of the same login.
  const login = await beginOAuthProviderLogin(cfg, provider, { openBrowser: false });
  const completed = await login.completeCode('offline-redirect-code');
  assert.equal(starts, 1);
  assert.equal(completed.accountId, 'default');
  assert.equal(completed.authenticated, true);
  assert.equal(config.providers[provider].enabled, true);
  assert.equal(readProviderAccountPool(provider).selectedId, 'default');
  assert.deepEqual(providerUsageAccounts(provider).accounts[0].identity, identity);
  assert.equal('defaultAccountEpochs' in listProviderAccounts(provider), false);
  const expected = `proxy-${createHash('sha256')
    .update(JSON.stringify(['lifecycle-owner', provider, 'default', identity, epoch]))
    .digest('hex')}`;
  const renewed = await usage.snapshot(provider, adapter(), { force: true });
  assert.equal(renewed.account, expected);
  assert.notEqual(renewed.account, initial.account);
  assert.equal((await makeUsage().snapshot(provider, adapter())).account, expected);

  // A genuinely fresh Node process must derive the same new lifetime from
  // disk, not from a preceding metering observation or module-local memory.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { createModelProxyUsage } = await import(${JSON.stringify(new URL('./model-proxy-usage-host.mjs', import.meta.url).href)});
    const { loadTokens } = await import(${JSON.stringify(new URL('./openai-oauth-tokens.mjs', import.meta.url).href)});
    const usage = createModelProxyUsage({
      owner: () => 'lifecycle-owner',
      fetchUsage: async () => ({ cachedAt: Date.now(), quotaWindows: [{ label: '5H', usedPct: 9 }] }),
    });
    const reply = await usage.snapshot('openai-oauth', { tokens: loadTokens() });
    assert.equal(reply.status, 'ready');
    assert.equal(reply.account, ${JSON.stringify(expected)});
    assert.notEqual(reply.account, ${JSON.stringify(initial.account)});
  `], { env: process.env, encoding: 'utf8', timeout: 30_000 });
});

test('forgetting an implicit default also separates a same-identity reconnect without intermediate metering', async () => {
  // Start another implicit lifetime, with no default row to remove.
  await forgetProviderAuth(cfg, provider, 'default');
  tokens.saveTokens(credential('implicit-again'));
  const before = await makeUsage().snapshot(provider, adapter());
  await forgetProviderAuth(cfg, provider, 'default');
  const login = await beginOAuthProviderLogin(cfg, provider, { openBrowser: false });
  await login.completeCode('offline-redirect-code');
  const afterReconnect = await makeUsage().snapshot(provider, adapter());
  assert.equal(afterReconnect.status, 'ready');
  assert.notEqual(afterReconnect.account, before.account);
});
