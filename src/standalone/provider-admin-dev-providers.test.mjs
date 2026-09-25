import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The config path is fixed at module load: point it at a scratch dir first.
const dir = mkdtempSync(join(tmpdir(), 'mixdog-provider-admin-dev-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(dir, 'backups');
delete process.env.MIXDOG_DEV_PROVIDERS;

const { updateSection } = await import('../runtime/shared/config.mjs');
const { providerSetup, providerStatus, isKnownProvider, listProviderAccounts } = await import('./provider-admin.mjs');

const DEV = ['cursor-oauth', 'antigravity-oauth'];
const setDevProviders = (enabled) =>
  updateSection('agent', (current) => ({ ...current, developer: { devProviders: enabled } }));
const oauthIds = async () =>
  (await providerSetup({}, { checkSecrets: false, detectLocal: false })).oauth.map((row) => row.id);

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('the Dev providers toggle exposes and hides the dev-only OAuth providers without a reload', async () => {
  assert.deepEqual(await oauthIds(), ['openai-oauth', 'anthropic-oauth', 'grok-oauth']);
  for (const id of DEV) {
    assert.equal(isKnownProvider(id), false, id);
    assert.throws(() => listProviderAccounts(id), /Unknown OAuth provider/);
  }
  assert.equal(isKnownProvider('openai-oauth'), true);
  assert.equal(isKnownProvider('openai'), true);
  assert.equal(isKnownProvider('mixdog-local'), true);

  setDevProviders(true);
  assert.deepEqual(await oauthIds(), ['openai-oauth', 'anthropic-oauth', 'grok-oauth', ...DEV]);
  for (const id of DEV) assert.equal(isKnownProvider(id), true, id);
  assert.deepEqual(
    providerStatus({})
      .filter((row) => row.type === 'oauth')
      .map((row) => row.id)
      .filter((id) => DEV.includes(id)),
    DEV
  );

  setDevProviders(false);
  assert.deepEqual(await oauthIds(), ['openai-oauth', 'anthropic-oauth', 'grok-oauth']);
  for (const id of DEV) assert.equal(isKnownProvider(id), false, id);
});
