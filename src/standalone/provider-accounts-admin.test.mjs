import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-account-admin-'));
process.env.MIXDOG_DATA_DIR = dir;
const { providerAccountPath, newProviderAccountId, registerProviderAccount, readProviderAccountPool, changeProviderAccounts } =
  await import('../runtime/shared/provider-accounts.mjs');
const { writeJsonAtomicSync } = await import('../runtime/shared/atomic-file.mjs');
const { forgetProviderAuth, beginOAuthProviderLogin, listProviderAccounts } = await import('./provider-admin.mjs');
after(() => rmSync(dir, { recursive: true, force: true }));

test('disconnect removes only the requested account, without selecting it or disabling remaining accounts', () => {
  const provider = 'openai-oauth';
  const ids = [newProviderAccountId(), newProviderAccountId()];
  for (const id of ids) {
    writeJsonAtomicSync(providerAccountPath(provider, id),
      { access_token: `access-${id}`, refresh_token: `refresh-${id}`, expires_at: Date.now() + 3600_000 },
      { mode: 0o600, secret: true });
    registerProviderAccount(provider, id);
  }
  let config = { providers: { [provider]: { enabled: true } } };
  const cfg = { loadConfig: () => config, saveConfig: (next) => { config = next; } };
  const original = readFileSync(providerAccountPath(provider, ids[0]), 'utf8');
  forgetProviderAuth(cfg, provider, ids[1]);
  assert.equal(existsSync(providerAccountPath(provider, ids[1])), false);
  assert.equal(readFileSync(providerAccountPath(provider, ids[0]), 'utf8'), original);
  assert.equal(readProviderAccountPool(provider).selectedId, ids[0]);
  assert.equal(config.providers[provider].enabled, true);
  assert.deepEqual(listProviderAccounts(provider).accounts.map((account) => account.id), [ids[0]]);
  assert.throws(() => forgetProviderAuth(cfg, provider, '../outside'), /no longer connected/);
  changeProviderAccounts(provider, { rename: { id: ids[0], label: 'Personal' } });
  assert.equal(listProviderAccounts(provider).accounts[0].label, 'Personal');
  assert.throws(() => changeProviderAccounts(provider, { rename: { id: ids[0], label: '  ' } }), /Invalid account name/);
});

test('adding a second Anthropic account writes its own credential file and leaves the first untouched', async (t) => {
  const provider = 'anthropic-oauth';
  const firstPath = join(dir, 'anthropic-oauth-credentials.json');
  const first = { claudeAiOauth: { accessToken: 'access-first', refreshToken: 'refresh-first',
    expiresAt: Date.now() + 3600_000, scopes: ['user:inference', 'user:profile'] } };
  writeJsonAtomicSync(firstPath, first, { mode: 0o600, secret: true });
  // Token endpoint stub: the login must never reach the network here.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: 'access-second', refresh_token: 'refresh-second', expires_in: 3600,
    scope: 'user:inference user:profile',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  t.after(() => { globalThis.fetch = realFetch; });
  // Both the loopback listener and the browser opener are side effects the
  // test must not trigger; the manual-code path exercises the same exchange.
  process.env.ANTHROPIC_OAUTH_MANUAL_REDIRECT_URI ||= 'https://platform.claude.com/oauth/code/callback';
  const cfg = { loadConfig: () => ({ providers: {} }), saveConfig() {} };
  const login = await beginOAuthProviderLogin(cfg, provider, { addAccount: true });
  t.after(() => login.cancel?.());
  const state = new URL(login.url).searchParams.get('state');
  const result = await login.completeCode(`code-second#${state}`);
  assert.equal(result.authenticated, true);
  const pool = readProviderAccountPool(provider);
  assert.deepEqual(pool.accounts.map((row) => row.label), ['Account 1', 'Account 2']);
  const secondPath = providerAccountPath(provider, pool.accounts[1].id);
  assert.equal(existsSync(secondPath), true, 'the new account owns its own credential file');
  assert.equal(JSON.parse(readFileSync(secondPath, 'utf8')).claudeAiOauth.accessToken, 'access-second');
  assert.equal(JSON.parse(readFileSync(firstPath, 'utf8')).claudeAiOauth.accessToken, 'access-first',
    'the first account keeps its tokens');
  const listed = listProviderAccounts(provider).accounts;
  assert.deepEqual(listed.map((row) => row.authenticated), [true, true]);
});

test('login refuses a removed or arbitrary account before starting OAuth', async () => {
  const cfg = { loadConfig: () => ({}), saveConfig() {} };
  await assert.rejects(beginOAuthProviderLogin(cfg, 'openai-oauth', { accountId: newProviderAccountId() }), /no longer connected/);
  await assert.rejects(beginOAuthProviderLogin(cfg, 'openai-oauth', { accountId: '../outside' }), /no longer connected/);
});
