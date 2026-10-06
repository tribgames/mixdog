import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-oauth-probes-'));
process.env.MIXDOG_DATA_DIR = dataDir;
delete process.env.GROK_OAUTH_CREDENTIALS_PATH;

const { hasGrokOAuthCredentials } = await import('./oauth-credential-probes.mjs');
const { withProviderAccount } = await import('../../../shared/provider-auth-binding.mjs');

test('a Grok login stored in an account pool file counts as signed in', (t) => {
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
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
