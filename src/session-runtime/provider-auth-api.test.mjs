import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test, { mock } from 'node:test';

const calls = [];
let pendingCallback = null;
const admin = {
  beginOAuthProviderLogin: async (_cfg, providerId, options) => {
    calls.push(['beginOAuth', providerId, options]);
    pendingCallback = Promise.withResolvers();
    return {
      url: 'https://login',
      waitForCallback: pendingCallback.promise,
      completeCode: async (code) => {
        calls.push(['completeCode', code]);
        return true;
      },
    };
  },
  forgetProviderAuth: (_cfg, providerId, accountId) => calls.push(['forget', providerId, accountId]) && 'forgot',
  loginOAuthProvider: async (_cfg, providerId) => calls.push(['loginOAuth', providerId]) && 'logged-in',
  renderProviderStatus: (config) => ['status', config],
  saveOpenAIUsageSessionKey: (_cfg, secret) => calls.push(['saveUsageKey', secret]) && 'saved-usage',
  saveOpenCodeGoUsageAuth: (_cfg, opts) => calls.push(['saveGoUsage', opts]) && 'saved-go',
  saveProviderApiKey: (_cfg, providerId, secret) => calls.push(['saveKey', providerId, secret]) && 'saved-key',
  listProviderAccounts: (providerId) => ({
    providerId,
    accounts: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }, { id: 'a4' }, { id: 'a5' }],
    selectedId: 'a1',
  }),
  updateProviderAccounts: (providerId, change) => {
    calls.push(['updateAccounts', providerId, change]);
    return { selectedId: change.selectedId ?? 'a1' };
  },
};
mock.module('../standalone/provider-admin.mjs', { namedExports: admin });
mock.module('../runtime/agent/orchestrator/providers/admission-scheduler.mjs', {
  namedExports: { resetProviderAdmissionCooldowns: () => calls.push(['resetCooldowns']) },
});
const providers = {
  oauth: { forAccount: (id) => ({ account: id }) },
  plain: {},
};
mock.module('../runtime/agent/orchestrator/providers/registry.mjs', {
  namedExports: { getProvider: (id) => providers[id] },
});
mock.module('../runtime/agent/orchestrator/providers/oauth-usage.mjs', {
  namedExports: {
    fetchOAuthUsageSnapshot: async (target, provider, _onUpdate, options) => {
      calls.push(['usage', target, provider, options]);
      return null;
    },
  },
});

const { createProviderAuthApi } = await import('./provider-auth-api.mjs');

function fixture(overrides = {}) {
  calls.length = 0;
  const api = createProviderAuthApi({
    cfgMod: { listPresets: (config) => ['presets', config] },
    getConfig: () => ({}),
    saveConfigAndAdopt: () => {},
    displayConfig: () => ({ display: true }),
    reloadFullConfig: () => calls.push(['reload']),
    awaitKeychainPrewarm: async () => calls.push(['keychain']),
    invalidateProviderCaches: () => calls.push(['invalidate']),
    warmProviderModelCache: () => calls.push(['warm']),
    refreshProviderCatalogs: async (options) => calls.push(['refreshCatalogs', options]),
    cachedProviderSetup: async (options) => {
      calls.push(['setup', options]);
      if (options.quick) return { providers: 'quick' };
      return { providers: options.force ? 'forced' : 'full' };
    },
    getUsageDashboard: async (options) => ['dashboard', options],
    consumeCodexRateLimitResetCredit: async (options) => ['reset', options],
    collectProviderModels: async (options) => ['models', options],
    ...overrides,
  });
  return api;
}

// The catalog refresh is started before the cache warm; its own invalidate +
// warm land once the refresh settles.
const CREDENTIAL_CHANGE = [
  ['reload'],
  ['invalidate'],
  ['resetCooldowns'],
  ['refreshCatalogs', { force: true }],
  ['warm'],
];
const AFTER_CATALOGS = [['invalidate'], ['warm']];

test('saving an API key reloads config, releases cooldowns and refreshes catalogs then caches', async () => {
  const api = fixture();
  assert.equal(api.saveProviderApiKey('oauth', 'sk-1'), 'saved-key');
  await setImmediate();
  assert.deepEqual(calls, [['saveKey', 'oauth', 'sk-1'], ...CREDENTIAL_CHANGE, ...AFTER_CATALOGS]);
});

test('authenticateProvider saves a secret when given one and otherwise runs the OAuth login', async () => {
  const api = fixture();
  assert.equal(await api.authenticateProvider('oauth', '  '), 'logged-in');
  assert.deepEqual(calls.slice(0, 2), [['keychain'], ['loginOAuth', 'oauth']]);
  assert.equal(await api.authenticateProvider('oauth', 'sk-2'), 'saved-key');
  assert.ok(calls.some(([name, , secret]) => name === 'saveKey' && secret === 'sk-2'));
  assert.equal(await api.forgetProviderAuth('oauth', 'a1'), 'forgot');
});

test('usage-only credentials reload and invalidate without touching admission cooldowns', async () => {
  const api = fixture();
  assert.equal(api.saveOpenAIUsageSessionKey('usage-1'), 'saved-usage');
  assert.equal(api.saveOpenCodeGoUsageAuth({ apiKey: 'oc_sk_test' }), 'saved-go');
  assert.deepEqual(calls, [
    ['saveUsageKey', 'usage-1'],
    ['reload'],
    ['invalidate'],
    ['saveGoUsage', { apiKey: 'oc_sk_test' }],
    ['reload'],
    ['invalidate'],
  ]);
});

test('beginOAuthProviderLogin wraps the callback wait and the code completion with the refresh chain', async () => {
  const api = fixture();
  const login = await api.beginOAuthProviderLogin('oauth', { openBrowser: false });
  assert.equal(login.url, 'https://login');
  assert.deepEqual(calls, [['keychain'], ['beginOAuth', 'oauth', { openBrowser: false }], ['reload']]);
  calls.length = 0;
  pendingCallback.resolve(true);
  assert.equal(await login.waitForCallback, true);
  await setImmediate();
  assert.deepEqual(calls, [['keychain'], ...CREDENTIAL_CHANGE, ...AFTER_CATALOGS]);
  calls.length = 0;
  assert.equal(await login.completeCode('1234'), true);
  await setImmediate();
  assert.deepEqual(calls, [['completeCode', '1234'], ['keychain'], ...CREDENTIAL_CHANGE, ...AFTER_CATALOGS]);
});

test('the account roster paints immediately and one bounded usage sweep runs per provider', async () => {
  const api = fixture();
  const pool = api.getProviderAccounts('oauth');
  assert.equal(pool.accounts.length, 5);
  assert.deepEqual(calls, [['keychain']], 'the roster returns before the sweep waits on the keychain');
  await setImmediate();
  await setImmediate();
  const usage = calls.filter(([name]) => name === 'usage');
  assert.equal(usage.length, 5);
  assert.deepEqual(usage[0], ['usage', { provider: 'oauth', accountId: 'a1' }, { account: 'a1' }, undefined]);
  calls.length = 0;
  api.getProviderAccounts('plain');
  await setImmediate();
  assert.deepEqual(calls, [], 'providers without per-account clients are not swept');
});

test('switching the selected account releases cooldowns and prefetches that account usage', async () => {
  const api = fixture();
  assert.deepEqual(await api.updateProviderAccounts('oauth', { selectedId: 'a2' }), { selectedId: 'a2' });
  assert.deepEqual(calls, [
    ['keychain'],
    ['updateAccounts', 'oauth', { selectedId: 'a2' }],
    ['reload'],
    ['invalidate'],
    ['warm'],
    ['resetCooldowns'],
    ['usage', { provider: 'oauth', model: '', accountId: 'a2' }, { account: 'a2' }, { force: true }],
  ]);
  calls.length = 0;
  await api.updateProviderAccounts('oauth', { remove: 'a3' });
  assert.ok(!calls.some(([name]) => name === 'resetCooldowns' || name === 'usage'));
});

test('getProviderSetup serves the no-secrets snapshot until the keychain is ready, and forces on request', async () => {
  const api = fixture({ isKeychainPrewarmReady: () => false });
  assert.deepEqual(await api.getProviderSetup(), { providers: 'quick', pendingSecrets: true });
  assert.deepEqual(calls[0], ['setup', { quick: true }]);
  await setImmediate();
  assert.deepEqual(calls.at(-1), ['setup', {}], 'the authoritative setup is published after the prewarm');
  calls.length = 0;
  assert.deepEqual(await api.getProviderSetup({ force: true }), { providers: 'forced' });
  assert.deepEqual(calls, [['keychain'], ['reload'], ['setup', { force: true }]]);
});

test('catalog, preset, dashboard and reset-credit surfaces delegate with normalized options', async () => {
  const api = fixture();
  assert.deepEqual(api.listProviders(), ['status', { display: true }]);
  assert.deepEqual(api.listPresets(), ['presets', { display: true }]);
  assert.deepEqual(await api.getUsageDashboard({ a: 1 }), ['dashboard', { a: 1 }]);
  assert.deepEqual(await api.listProviderModels({ refresh: true }), ['models', { force: true, quick: false }]);
  assert.deepEqual(await api.consumeCodexRateLimitResetCredit({ b: 2 }), ['reset', { b: 2 }]);
  const missing = fixture({ consumeCodexRateLimitResetCredit: undefined });
  await assert.rejects(() => missing.consumeCodexRateLimitResetCredit(), /Codex reset is unavailable/);
});
