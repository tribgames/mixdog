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

const { updateSection } = await import('../runtime/shared/config.mjs');
const { providerSetup, providerStatus, isKnownProvider, listProviderAccounts } = await import(
  '../session-runtime/services/provider-admin.mjs'
);

const DEV = ['mimo-oauth', 'cursor-oauth', 'antigravity-oauth'];
const BASE = [
  'openai-oauth',
  'anthropic-oauth',
  'grok-oauth',
  'muse-code-oauth',
  'command-code-oauth',
  'opencode-go-oauth',
];
const setDeveloper = (developer) => updateSection('agent', (current) => ({ ...current, developer }));
const oauthIds = async () =>
  (await providerSetup({}, { checkSecrets: false, detectLocal: false })).oauth.map((row) => row.id);

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('each provider option exposes and hides only its own dev-only OAuth provider without a reload', async () => {
  assert.deepEqual(await oauthIds(), BASE);
  for (const id of DEV) {
    assert.equal(isKnownProvider(id), false, id);
    assert.throws(() => listProviderAccounts(id), /Unknown OAuth provider/);
  }
  assert.equal(isKnownProvider('openai-oauth'), true);
  assert.equal(isKnownProvider('muse-code-oauth'), true);
  assert.equal(isKnownProvider('command-code-oauth'), true);
  assert.equal(isKnownProvider('openai'), true);
  assert.equal(isKnownProvider('mixdog-local'), true);

  setDeveloper({ cursorOAuth: true });
  assert.deepEqual(await oauthIds(), [...BASE, 'cursor-oauth']);
  assert.equal(isKnownProvider('cursor-oauth'), true);
  assert.equal(isKnownProvider('antigravity-oauth'), false);
  assert.equal(isKnownProvider('mimo-oauth'), false);

  setDeveloper({ mimoOAuth: true });
  assert.deepEqual(await oauthIds(), [...BASE, 'mimo-oauth']);
  assert.equal(isKnownProvider('mimo-oauth'), true);
  assert.equal(isKnownProvider('cursor-oauth'), false);

  setDeveloper({ mimoOAuth: true, cursorOAuth: true, antigravityOAuth: true });
  assert.deepEqual(await oauthIds(), [...BASE, ...DEV]);
  for (const id of DEV) assert.equal(isKnownProvider(id), true, id);
  assert.deepEqual(
    providerStatus({})
      .filter((row) => row.type === 'oauth')
      .map((row) => row.id)
      .filter((id) => DEV.includes(id)),
    DEV
  );

  setDeveloper({ mimoOAuth: false, cursorOAuth: false, antigravityOAuth: true });
  assert.deepEqual(await oauthIds(), [...BASE, 'antigravity-oauth']);
  assert.equal(isKnownProvider('cursor-oauth'), false);
  assert.equal(isKnownProvider('mimo-oauth'), false);

  setDeveloper({ mimoOAuth: false, cursorOAuth: false, antigravityOAuth: false });
  assert.deepEqual(await oauthIds(), BASE);
  for (const id of DEV) assert.equal(isKnownProvider(id), false, id);
});
