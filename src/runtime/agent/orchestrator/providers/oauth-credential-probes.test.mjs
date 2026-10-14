import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-oauth-probes-'));
process.env.MIXDOG_DATA_DIR = dataDir;
delete process.env.GROK_OAUTH_CREDENTIALS_PATH;
writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { developer: { cursorOAuth: true } } }));

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { hasGrokOAuthCredentials, oauthCredentialProbeState } = await import('./oauth-credential-probes.mjs');
const { withProviderAccount } = await import('../../../shared/provider-auth-binding.mjs');

test('a Grok login stored in an account pool file counts as signed in', (t) => {
  const accountId = 'cab7f9f6-5de5-44ef-a036-42a18f7da27f';
  const accountDir = join(dataDir, 'provider-accounts', 'grok-oauth');
  mkdirSync(accountDir, { recursive: true });
  // No legacy root file: only the account's own file carries the login.
  assert.equal(
    withProviderAccount('grok-oauth', accountId, () => hasGrokOAuthCredentials()),
    false
  );
  writeFileSync(
    join(accountDir, `${accountId}.json`),
    JSON.stringify({ access_token: 'access', refresh_token: 'refresh' })
  );
  assert.equal(
    withProviderAccount('grok-oauth', accountId, () => hasGrokOAuthCredentials()),
    true
  );
});


for (const provider of ['cursor-oauth', 'anthropic-oauth']) {
  test(`${provider} probes the selected account exclusively, matching its model adapter`, async (t) => {
    if (provider === 'cursor-oauth') {
      const prior = process.env.CURSOR_ACCESS_TOKEN;
      process.env.CURSOR_ACCESS_TOKEN = 'another-account-env-token';
      t.after(() => {
        if (prior === undefined) delete process.env.CURSOR_ACCESS_TOKEN;
        else process.env.CURSOR_ACCESS_TOKEN = prior;
      });
    }
    const accountId = 'cab7f9f6-5de5-44ef-a036-42a18f7da280';
    const accountDir = join(dataDir, 'provider-accounts', provider);
    mkdirSync(accountDir, { recursive: true });
    const path = join(accountDir, `${accountId}.json`);
    const document = provider === 'cursor-oauth'
      ? { access_token: 'selected-account-token', refresh_token: 'refresh' }
      : { claudeAiOauth: { accessToken: 'selected-account-token', refreshToken: 'refresh', scopes: ['user:inference'] } };
    const fallback = join(dataDir, provider === 'cursor-oauth' ? 'cursor-oauth.json' : 'anthropic-oauth-credentials.json');
    writeFileSync(fallback, JSON.stringify(document));
    const probe = () => withProviderAccount(provider, accountId, () => oauthCredentialProbeState(provider));
    assert.equal(probe(), 'absent', 'another account cannot authenticate a missing selected account');
    writeFileSync(path, JSON.stringify(document));
    assert.equal(probe(), 'present');
    writeFileSync(path, '{partial');
    assert.equal(probe(), 'unreadable', 'a torn write does not mean logout or fall back to another account');
    rmSync(path);
    assert.equal(probe(), 'absent');
  });
}
