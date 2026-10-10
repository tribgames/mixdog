import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-account-identity-'));
process.env.MIXDOG_DATA_DIR = dir;
const { providerAccountPath, newProviderAccountId, registerProviderAccount, readProviderAccountPool } = await import(
  '../runtime/shared/provider-accounts.mjs'
);
const { writeJsonAtomicSync } = await import('../runtime/shared/atomic-file.mjs');
const { withProviderAccount } = await import('../runtime/shared/provider-auth-binding.mjs');
const { beginOAuthProviderLogin, listProviderAccounts } = await import(
  '../session-runtime/services/provider-admin.mjs'
);
const { identityFromTokens, describeOpenAIOAuthCredentials } = await import(
  '../runtime/agent/orchestrator/providers/openai-oauth-tokens.mjs'
);
const { describeAntigravityOAuthCredentials } = await import(
  '../runtime/agent/orchestrator/providers/antigravity-oauth-tokens.mjs'
);
const { describeGrokOAuthCredentials } = await import('../runtime/agent/orchestrator/providers/grok-oauth-tokens.mjs');
const { describeCursorOAuthCredentials } = await import('../runtime/agent/orchestrator/providers/cursor-auth.mjs');
after(() => rmSync(dir, { recursive: true, force: true }));

const jwt = (claims) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const future = () => Date.now() + 3600_000;

function writeAccount(provider, id, body) {
  writeJsonAtomicSync(providerAccountPath(provider, id), body, { mode: 0o600, secret: true });
  registerProviderAccount(provider, id);
}

test('OpenAI identity comes from the id_token and access token claims', () => {
  const idToken = jwt({ sub: 'user-1', email: 'name@example.com' });
  const accessToken = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } });
  assert.deepEqual(identityFromTokens(idToken, accessToken), { id: 'user-1:acct-1', email: 'name@example.com' });
  assert.deepEqual(identityFromTokens(jwt({ 'https://api.openai.com/profile': { email: 'p@example.com' } })), {
    email: 'p@example.com',
  });
  assert.equal(identityFromTokens('opaque'), null);
  const id = newProviderAccountId();
  writeAccount('openai-oauth', id, {
    access_token: accessToken,
    refresh_token: 'refresh',
    expires_at: future(),
    id_token: idToken,
  });
  const described = withProviderAccount('openai-oauth', id, () => describeOpenAIOAuthCredentials());
  assert.equal(described.email, 'name@example.com');
  assert.equal(described.identityId, 'user-1:acct-1');
  assert.equal(JSON.stringify(described).includes(accessToken), false);
});

test('Antigravity, Grok and Cursor report the identity their stored tokens carry', () => {
  const antigravity = newProviderAccountId();
  writeAccount('antigravity-oauth', antigravity, {
    access_token: 'a',
    refresh_token: 'r',
    expires_at: future(),
    email: 'dev@example.com',
    user_id: 'google-1',
  });
  const grokId = newProviderAccountId();
  writeAccount('grok-oauth', grokId, {
    access_token: jwt({ sub: 'xai-user', email: 'grok@example.com', exp: Math.floor(future() / 1000) }),
    refresh_token: 'r',
    expires_at: future(),
  });
  const cursorId = newProviderAccountId();
  writeAccount('cursor-oauth', cursorId, {
    access_token: jwt({ sub: 'auth0|user_1', exp: Math.floor(future() / 1000) }),
    refresh_token: 'r',
    expires_at: future(),
  });
  const pick = (provider, id, describe) => withProviderAccount(provider, id, () => describe());
  const a = pick('antigravity-oauth', antigravity, describeAntigravityOAuthCredentials);
  assert.deepEqual([a.email, a.identityId], ['dev@example.com', 'google-1']);
  const g = pick('grok-oauth', grokId, describeGrokOAuthCredentials);
  assert.deepEqual([g.email, g.identityId], ['grok@example.com', 'xai-user']);
  const c = pick('cursor-oauth', cursorId, describeCursorOAuthCredentials);
  assert.deepEqual([c.email, c.identityId], [undefined, 'auth0|user_1']);
});

function mockAnthropicExchange(t, { uuid, email, access }) {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          access_token: access,
          refresh_token: `refresh-${access}`,
          expires_in: 3600,
          scope: 'user:inference user:profile',
          account: { uuid, email_address: email },
          organization: { uuid: 'org-1' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  );
}

async function signIn(t, identity) {
  const cfg = { loadConfig: () => ({ providers: {} }), saveConfig() {} };
  mockAnthropicExchange(t, identity);
  process.env.ANTHROPIC_OAUTH_MANUAL_REDIRECT_URI ||= 'https://platform.claude.com/oauth/code/callback';
  const login = await beginOAuthProviderLogin(cfg, 'anthropic-oauth', { addAccount: true, label: 'Dev' });
  t.after(() => login.cancel?.());
  const state = new URL(login.url).searchParams.get('state');
  return login.completeCode(`code#${state}`);
}

test('signing the same Anthropic account in again reuses its roster id; another account gets a new one', async (t) => {
  const provider = 'anthropic-oauth';
  const first = await signIn(t, { uuid: 'acct-a', email: 'a@example.com', access: 'access-1' });
  assert.equal(first.authenticated, true);
  const [row] = readProviderAccountPool(provider).accounts;
  assert.equal(first.accountId, row.id);
  const stored = JSON.parse(readFileSync(providerAccountPath(provider, row.id), 'utf8')).claudeAiOauth;
  assert.deepEqual(stored.identity, { id: 'acct-a', email: 'a@example.com', organizationId: 'org-1' });
  assert.equal(listProviderAccounts(provider).accounts[0].email, 'a@example.com');

  const again = await signIn(t, { uuid: 'acct-a', email: 'a@example.com', access: 'access-2' });
  assert.equal(again.accountId, row.id);
  const pool = readProviderAccountPool(provider);
  assert.deepEqual(
    pool.accounts.map((entry) => [entry.id, entry.label]),
    [[row.id, row.label]]
  );
  assert.equal(
    JSON.parse(readFileSync(providerAccountPath(provider, row.id), 'utf8')).claudeAiOauth.accessToken,
    'access-2'
  );

  const other = await signIn(t, { uuid: 'acct-b', email: 'b@example.com', access: 'access-3' });
  assert.notEqual(other.accountId, row.id);
  const ids = readProviderAccountPool(provider).accounts.map((entry) => entry.id);
  assert.deepEqual(ids, [row.id, other.accountId]);
  assert.equal(existsSync(providerAccountPath(provider, other.accountId)), true);
  assert.deepEqual(
    listProviderAccounts(provider).accounts.map((entry) => entry.email),
    ['a@example.com', 'b@example.com']
  );

  // A removed account leaves nothing to restore: only roster matches count.
  const { removeProviderAccount } = await import('../runtime/shared/provider-accounts.mjs');
  removeProviderAccount(provider, other.accountId);
  const readded = await signIn(t, { uuid: 'acct-b', email: 'b@example.com', access: 'access-4' });
  assert.notEqual(readded.accountId, other.accountId);
});
