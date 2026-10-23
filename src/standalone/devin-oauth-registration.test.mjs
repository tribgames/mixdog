import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-devin-reg-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(dir, 'backups');
const CREDENTIALS = join(dir, 'devin-oauth-test.json');
process.env.DEVIN_OAUTH_CREDENTIALS_PATH = CREDENTIALS;

const { readSection, updateSection } = await import('../runtime/shared/config.mjs');
const { developerOptionForProvider, developerSettingsView } = await import('../runtime/shared/developer-options.mjs');
const { isOAuthProviderAvailable, oauthCredentialProbeState } = await import(
  '../runtime/agent/orchestrator/providers/oauth-credential-probes.mjs'
);
const {
  OAUTH_PROVIDER_NAMES,
  _withRegisteredProviderForTest,
  _withRegisteredProviderForTestAsync,
  getAllProviders,
  getProvider,
  initProviders,
} = await import('../runtime/agent/orchestrator/providers/registry.mjs');
const { buildDefaultConfig, loadConfig, saveConfig } = await import('../runtime/agent/orchestrator/config.mjs');
const { providerSetup, providerStatus, isKnownProvider, forgetProviderAuth } = await import(
  '../session-runtime/services/provider-admin.mjs'
);
const devinAuth = await import('../runtime/agent/orchestrator/providers/devin-auth.mjs');
const { formatScheduleModelRef, parseScheduleModelRef } = await import('../runtime/shared/schedule-model-ref.mjs');
const { providerCatalogEntry } = await import('../runtime/shared/llm/provider-catalog-registry.mjs');

const setDeveloper = (developer) => updateSection('agent', (current) => ({ ...current, developer }));
const oauthIds = async () =>
  (await providerSetup({}, { checkSecrets: false, detectLocal: false })).oauth.map((row) => row.id);

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('devin-oauth is a gated, default-off developer option with the OAuth risk warning', () => {
  const option = developerOptionForProvider('devin-oauth');
  assert.equal(option.id, 'devinOAuth');
  assert.match(option.warning, /risk of penalties/);
  const view = developerSettingsView({}).sections.find((s) => s.id === 'providers').options;
  assert.equal(view.find((o) => o.id === 'devinOAuth').enabled, false);
  assert.ok([...OAUTH_PROVIDER_NAMES].includes('devin-oauth'));
  assert.equal(providerCatalogEntry('devin-oauth').relay, true);
});

test('devin-oauth is hidden and unroutable while the option is off, listed once it is on', async () => {
  setDeveloper({});
  assert.equal(isOAuthProviderAvailable('devin-oauth'), false);
  assert.equal(oauthCredentialProbeState('devin-oauth'), 'absent');
  assert.equal(isKnownProvider('devin-oauth'), false);
  assert.equal((await oauthIds()).includes('devin-oauth'), false);
  if (buildDefaultConfig) assert.equal(buildDefaultConfig().providers['devin-oauth'], undefined);

  setDeveloper({ devinOAuth: true });
  assert.equal(isOAuthProviderAvailable('devin-oauth'), true);
  assert.equal(isKnownProvider('devin-oauth'), true);
  const row = (await providerSetup({}, { checkSecrets: false, detectLocal: false })).oauth.find(
    (r) => r.id === 'devin-oauth'
  );
  assert.equal(row.name, 'Devin');
  if (buildDefaultConfig) assert.ok(buildDefaultConfig().providers['devin-oauth']);
});

test('provider-admin dispatches Devin status and logout to devin-auth', async () => {
  setDeveloper({ devinOAuth: true });
  writeFileSync(CREDENTIALS, JSON.stringify({ access_token: 'devin-test-token', expires_at: Date.now() + 3_600_000 }));
  const status = providerStatus({}).find((r) => r.id === 'devin-oauth');
  assert.equal(status.authenticated, true);
  assert.equal(status.authenticated, devinAuth.describeDevinOAuthCredentials().authenticated);
  assert.equal(oauthCredentialProbeState('devin-oauth'), 'present');

  const result = await forgetProviderAuth('devin-oauth');
  assert.equal(result.removed, true);
  assert.equal(existsSync(CREDENTIALS), false, 'logout removes the credential file');
  assert.equal(devinAuth.hasDevinOAuthCredentials(), false);
  assert.equal(providerStatus({}).find((r) => r.id === 'devin-oauth').authenticated, false);

  setDeveloper({});
  await assert.rejects(async () => forgetProviderAuth('devin-oauth'));
});

test('registry dispatch: an initialized Devin instance is routable only while the option is on', () => {
  const instance = { name: 'devin-oauth' };
  _withRegisteredProviderForTest('devin-oauth', instance, () => {
    setDeveloper({});
    assert.equal(getProvider('devin-oauth'), undefined);
    assert.equal(getAllProviders().has('devin-oauth'), false);

    setDeveloper({ devinOAuth: true });
    assert.equal(getProvider('devin-oauth'), instance);
    assert.equal(getAllProviders().get('devin-oauth'), instance);

    // Disabled after it was initialized and used: unroutable at once...
    setDeveloper({ devinOAuth: false });
    assert.equal(getProvider('devin-oauth'), undefined);
    assert.equal(getAllProviders().has('devin-oauth'), false);

    // ...but never evicted: switching it back on restores the same instance without a re-init.
    setDeveloper({ devinOAuth: true });
    assert.equal(getProvider('devin-oauth'), instance);
    assert.equal(getAllProviders().get('devin-oauth'), instance);
  });
});

test('a saved enabled:true gated provider stays in config but is not admitted or routable while the option is off', async () => {
  const gated = ['devin-oauth', 'cursor-oauth', 'mimo-oauth', 'antigravity-oauth'];
  updateSection('agent', (current) => ({
    ...current,
    developer: {},
    providers: Object.fromEntries(gated.map((id) => [id, { enabled: true }])),
  }));
  const loaded = loadConfig({ secrets: false }).providers;
  for (const id of gated) assert.equal(loaded[id].enabled, true, `${id}: stored entry is left as stored`);

  // The registry refuses to admit them, and a live instance is not routable.
  const instance = { name: 'devin-oauth' };
  await _withRegisteredProviderForTestAsync('devin-oauth', instance, async () => {
    await assert.rejects(initProviders({ 'devin-oauth': { enabled: true } }), /all providers disabled/);
    assert.equal(getProvider('devin-oauth'), undefined);
    for (const id of gated) assert.equal(getAllProviders().has(id), false, id);
  });
});

test('option off → load → full save → option on keeps a gated provider’s stored settings unchanged', () => {
  const stored = { enabled: false, baseURL: 'https://devin.example.test/v1', customField: { keep: 'me' } };
  updateSection('agent', (current) => ({ ...current, developer: {}, providers: { 'devin-oauth': stored } }));

  const loaded = loadConfig({ secrets: false });
  assert.deepEqual(
    { enabled: loaded.providers['devin-oauth'].enabled, baseURL: loaded.providers['devin-oauth'].baseURL },
    { enabled: false, baseURL: stored.baseURL }
  );
  saveConfig({ ...loaded, profile: { ...loaded.profile, title: 'whole-section save' } });
  assert.deepEqual(readSection('agent').providers['devin-oauth'], stored);

  setDeveloper({ devinOAuth: true });
  assert.deepEqual(readSection('agent').providers['devin-oauth'], stored);
  const reloaded = loadConfig({ secrets: false }).providers['devin-oauth'];
  assert.equal(reloaded.enabled, false);
  assert.equal(reloaded.baseURL, stored.baseURL);
  assert.deepEqual(reloaded.customField, stored.customField);
});

test('a devin-oauth/<model> route ref round-trips', () => {
  const route = { provider: 'devin-oauth', model: 'swe-1.5', effort: 'high', fast: true };
  const ref = formatScheduleModelRef(route);
  assert.equal(ref, 'devin-oauth/swe-1.5@high+fast');
  assert.deepEqual(parseScheduleModelRef(ref), route);
});
