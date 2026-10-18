import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ModelProxyChannel,
  MODEL_PROXY_OPERATIONS,
  encodeModelProxyWire,
  installModelProxyChannel,
} from '../../runtime/agent/orchestrator/providers/model-proxy-channel.mjs';
import { _resetModelProxyProviderConfigForTest } from '../../runtime/agent/orchestrator/providers/model-proxy-provider.mjs';
import { providerSetup } from '../services/provider-admin.mjs';
import { createProviderUsage } from '../provider-usage.mjs';
import { createSetupApi } from './setup.mjs';

test('SSH setup uses PC availability through the session API and follows refresh, disconnect and reconnect', async (t) => {
  // The real daemon owns sockets; isolated CI tests need a handle while the
  // channel's intentionally unref'ed disconnect timeout is pending.
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  const prior = process.env.MIXDOG_MODEL_PROXY;
  process.env.MIXDOG_MODEL_PROXY = 'client';
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_MODEL_PROXY;
    else process.env.MIXDOG_MODEL_PROXY = prior;
    _resetModelProxyProviderConfigForTest();
  });
  const channel = new ModelProxyChannel();
  t.after(installModelProxyChannel(channel));
  _resetModelProxyProviderConfigForTest();
  let providers = {
    'openai-oauth': { enabled: true, access_token: 'must-not-leak', accountId: 'private-account' },
    'cursor-oauth': { enabled: true },
    'anthropic-oauth': { enabled: false },
    openai: { enabled: false },
  };
  let requests = 0;
  const attach = () =>
    channel.attachPublisher((snapshot) => {
      for (const { id } of snapshot.requests) {
        const claim = channel.handleOperation(MODEL_PROXY_OPERATIONS.claim, [id]);
        if (!claim) continue;
        requests++;
        const payload = JSON.parse(claim.payload);
        assert.equal(payload.method, 'providerConfig');
        queueMicrotask(() =>
          channel.handleOperation(MODEL_PROXY_OPERATIONS.resolve, [
            id,
            true,
            encodeModelProxyWire({ providers, ready: true }),
            null,
          ])
        );
      }
    });
  let detach = attach();
  t.after(() => detach());
  const forbidden = () => assert.fail('SSH setup must not probe the server keychain or warm local credentials');
  const usage = createProviderUsage({
    caches: { providerSetupCache: { setup: { staleLocalSnapshot: true } } },
    displayConfig: () => ({ providers: { openai: { enabled: true } } }),
    providerSetup,
  });
  const api = createSetupApi({
    cachedProviderSetup: usage.cachedProviderSetup,
    awaitKeychainPrewarm: forbidden,
    isKeychainPrewarmReady: forbidden,
    hasProviderSetupCached: forbidden,
    reloadFullConfig: forbidden,
  });
  const first = await api.getProviderSetup();
  assert.equal(first.managedByClient, true);
  assert.equal(first.keychain, undefined);
  assert.equal(first.pendingSecrets, undefined);
  assert.deepEqual(
    first.oauth.map(({ id, authenticated, usable, status }) => ({ id, authenticated, usable, status })),
    [
      { id: 'openai-oauth', authenticated: true, usable: true, status: 'Connected' },
      { id: 'anthropic-oauth', authenticated: false, usable: false, status: 'Not connected' },
      { id: 'cursor-oauth', authenticated: true, usable: true, status: 'Connected' },
    ]
  );
  assert.equal(first.api[0].authenticated, false, 'server configuration cannot enable a PC provider');
  assert.doesNotMatch(JSON.stringify(first), /must-not-leak|private-account|access_token|accountId/);
  await api.getProviderSetup();
  assert.equal(requests, 1, 'reuse the bounded proxy cache instead of probing every UI read');

  providers['openai-oauth'] = { enabled: false };
  const refreshed = await api.getProviderSetup({ force: true, unlockKeychain: true });
  assert.equal(refreshed.oauth.find((row) => row.id === 'openai-oauth').authenticated, false);
  assert.equal(requests, 2);
  providers['openai-oauth'] = { enabled: true };
  assert.equal((await api.getProviderSetup({ recheckKeychain: true })).oauth[0].authenticated, true);

  providers['openai-oauth'] = { enabled: true, authState: 'unreadable' };
  const uncertain = (await api.getProviderSetup({ force: true })).oauth[0];
  assert.equal(uncertain.authenticated, false);
  assert.equal(uncertain.usable, true, 'a preserved adapter is not removed on a transient probe');
  assert.equal(uncertain.status, 'Checking…');
  providers['openai-oauth'] = { enabled: true, authState: 'absent' };
  const missing = (await api.getProviderSetup({ force: true })).oauth[0];
  assert.equal(missing.authenticated, false);
  assert.equal(missing.usable, false, 'enabled alone cannot authenticate a missing credential');
  assert.equal(missing.status, 'Not connected');

  detach();
  assert.deepEqual(await api.getProviderSetup(), {
    managedByClient: true,
    unavailable: true,
    api: [],
    oauth: [],
    local: [],
  });
  providers = { 'cursor-oauth': { enabled: true } };
  detach = attach();
  const reconnected = await api.getProviderSetup();
  assert.deepEqual(
    reconnected.oauth.map((row) => row.id),
    ['cursor-oauth'],
    'respect the new PC/host allow-list'
  );
  assert.equal(reconnected.unavailable, undefined);
});

test('SSH setup covers every built-in API, OAuth, local and custom provider, enabled and disabled', async (t) => {
  const prior = process.env.MIXDOG_MODEL_PROXY;
  process.env.MIXDOG_MODEL_PROXY = 'client';
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_MODEL_PROXY;
    else process.env.MIXDOG_MODEL_PROXY = prior;
    _resetModelProxyProviderConfigForTest();
  });
  const channel = new ModelProxyChannel();
  t.after(installModelProxyChannel(channel));
  _resetModelProxyProviderConfigForTest();
  const customProviders = ['openai-chat', 'openai-responses', 'anthropic'].flatMap((protocol, i) =>
    ['key', 'none'].map((auth, j) => ({
      id: `custom-00000000-0000-4000-8000-0000000000${i}${j}`,
      type: 'custom',
      name: `${protocol} ${auth} gateway`,
      protocol,
      auth,
    }))
  );
  const groups = {
    api: ['openrouter', 'openai', 'anthropic', 'gemini', 'deepseek', 'xai', ...customProviders.map(({ id }) => id)],
    oauth: [
      'openai-oauth',
      'anthropic-oauth',
      'grok-oauth',
      'muse-code-oauth',
      'command-code-oauth',
      'mimo-oauth',
      'cursor-oauth',
      'antigravity-oauth',
    ],
    local: ['mixdog-local'],
  };
  let enabled = true;
  const detach = channel.attachPublisher((snapshot) => {
    for (const { id } of snapshot.requests) {
      if (!channel.handleOperation(MODEL_PROXY_OPERATIONS.claim, [id])) continue;
      const providers = Object.fromEntries(
        Object.values(groups)
          .flat()
          .map((name) => [
            name,
            {
              enabled,
              ...(customProviders.find(({ id }) => id === name) || {}),
              apiKey: 'secret-must-stay-on-desktop',
              accountId: 'private-identity',
            },
          ])
      );
      queueMicrotask(() =>
        channel.handleOperation(MODEL_PROXY_OPERATIONS.resolve, [
          id,
          true,
          encodeModelProxyWire({ providers, ready: true }),
          null,
        ])
      );
    }
  });
  t.after(detach);
  for (const state of [true, false]) {
    enabled = state;
    const setup = await providerSetup({}, { force: true });
    assert.equal(setup.managedByClient, true);
    for (const [group, ids] of Object.entries(groups)) {
      assert.deepEqual(
        setup[group].map((row) => row.id),
        ids
      );
      for (const row of setup[group]) {
        assert.equal(row.enabled, state, row.id);
        assert.equal(row.authenticated, state, row.id);
        assert.equal(row.usable, state, row.id);
        assert.equal(row.status, state ? 'Connected' : 'Not connected', row.id);
      }
    }
    for (const custom of customProviders) {
      const row = setup.api.find(({ id }) => id === custom.id);
      assert.equal(row.name, custom.id);
      assert.equal(row.custom, true);
    }
    assert.equal(setup.local[0].detected, state);
    assert.doesNotMatch(JSON.stringify(setup), /secret-must-stay|private-identity|apiKey|accountId/);
  }
});

test('SSH setup reads a desktop-disabled sign-in as Off and carries only hidden custom model ids', async (t) => {
  const prior = process.env.MIXDOG_MODEL_PROXY;
  process.env.MIXDOG_MODEL_PROXY = 'client';
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_MODEL_PROXY;
    else process.env.MIXDOG_MODEL_PROXY = prior;
    _resetModelProxyProviderConfigForTest();
  });
  const channel = new ModelProxyChannel();
  t.after(installModelProxyChannel(channel));
  _resetModelProxyProviderConfigForTest();
  const custom = 'custom-00000000-0000-4000-8000-000000000077';
  const providers = {
    'openai-oauth': { enabled: false, authState: 'present' },
    'anthropic-oauth': { enabled: false, authState: 'absent' },
    [custom]: { enabled: true, type: 'custom', authState: 'present', hiddenModels: ['secret-model'] },
  };
  const detach = channel.attachPublisher((snapshot) => {
    for (const { id } of snapshot.requests) {
      if (!channel.handleOperation(MODEL_PROXY_OPERATIONS.claim, [id])) continue;
      queueMicrotask(() =>
        channel.handleOperation(MODEL_PROXY_OPERATIONS.resolve, [
          id,
          true,
          encodeModelProxyWire({ providers, ready: true }),
          null,
        ])
      );
    }
  });
  t.after(detach);
  const setup = await providerSetup({}, { force: true });
  const row = (id) => [...setup.api, ...setup.oauth].find((entry) => entry.id === id);
  assert.equal(row('openai-oauth').status, 'Off');
  assert.equal(row('openai-oauth').usable, false);
  assert.equal(row('anthropic-oauth').status, 'Not connected');
  assert.deepEqual(row(custom).modelOverrides, { 'secret-model': { hidden: true } });
});

test('client mode reads an empty server account roster and rejects mutations before touching credentials', async (t) => {
  const prior = process.env.MIXDOG_MODEL_PROXY;
  process.env.MIXDOG_MODEL_PROXY = 'client';
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_MODEL_PROXY;
    else process.env.MIXDOG_MODEL_PROXY = prior;
  });
  const admin = await import('../services/provider-admin.mjs');
  // Read-only callers (setup status, the quota card, usage account emails) keep working.
  assert.deepEqual(admin.listProviderAccounts('openai-oauth'), {
    provider: 'openai-oauth',
    auto: true,
    useCredits: false,
    selectedId: null,
    accounts: [],
  });
  // A provider this server's own settings keep off is still the desktop's to list.
  assert.deepEqual(admin.listProviderAccounts('mimo-oauth').accounts, []);
  assert.throws(() => admin.listProviderAccounts('not-a-provider'), TypeError);
  for (const name of [
    'authenticateProvider',
    'loginOAuthProvider',
    'beginOAuthProviderLogin',
    'materializeProviderAccounts',
    'updateProviderAccounts',
    'saveProviderApiKey',
    'saveCustomProvider',
    'updateCustomProviderModel',
    'removeCustomProvider',
    'testCustomProvider',
    'discoverCustomProviderModels',
    'saveOpenAIUsageSessionKey',
    'forgetProviderAuth',
  ]) {
    await assert.rejects(admin[name](), { code: 'MODEL_CREDENTIALS_DISABLED' }, name);
  }
});

test('a forced remote model catalog refresh replaces cached PC configuration before rebuilding the registry', async (t) => {
  const prior = process.env.MIXDOG_MODEL_PROXY;
  process.env.MIXDOG_MODEL_PROXY = 'client';
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_MODEL_PROXY;
    else process.env.MIXDOG_MODEL_PROXY = prior;
    _resetModelProxyProviderConfigForTest();
  });
  const channel = new ModelProxyChannel();
  t.after(installModelProxyChannel(channel));
  _resetModelProxyProviderConfigForTest();
  let providers = {};
  t.after(
    channel.attachPublisher((snapshot) => {
      for (const { id } of snapshot.requests) {
        if (!channel.handleOperation(MODEL_PROXY_OPERATIONS.claim, [id])) continue;
        queueMicrotask(() =>
          channel.handleOperation(MODEL_PROXY_OPERATIONS.resolve, [
            id,
            true,
            encodeModelProxyWire({ providers, ready: true }),
            null,
          ])
        );
      }
    })
  );
  const { loadModelProxyProviderConfig } = await import(
    '../../runtime/agent/orchestrator/providers/model-proxy-provider.mjs'
  );
  assert.deepEqual(await loadModelProxyProviderConfig(), {});
  providers = { gemini: { enabled: true } };
  const live = new Map();
  const registry = {
    providerCatalogRevision: () => 999,
    initProviders: async () => {
      const fresh = await loadModelProxyProviderConfig();
      assert.equal(fresh.gemini?.enabled, true, 'rebuild must use post-invalidation PC availability');
      live.set('gemini', { listModels: async () => [{ id: 'gemini-test' }] });
    },
    getAllProviders: () => live,
  };
  const { createCatalogLoader } = await import('../provider-models/catalog-load.mjs');
  const load = createCatalogLoader({
    caches: { providerModelsLoadSeq: 0 },
    config: () => ({ providers: {} }),
    reg: () => registry,
    meta: { syncCatalogRevision: () => 999, snapshotIsCurrent: () => false },
    rows: { providerModelCacheRow: (provider, row) => ({ ...row, provider }) },
    profile() {},
    ensureFullConfig() {},
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
  });
  assert.deepEqual(await load({ forceRefresh: true }), [{ id: 'gemini-test', provider: 'gemini' }]);
});
