import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { routeFastKey } from './model-capabilities.mjs';
import { createProviderModels } from './provider-models.mjs';

// The catalog paths provider-cache-lifecycle.test.mjs leaves alone: row
// hydration from saved model settings, the web-search catalog (quick rows →
// cached provider rows → forced provider scan), and the quick read that seeds
// the authoritative load.

const DEFAULT_ROW = { id: 'default', provider: 'default', display: 'Default' };

function fixture({
  config = {},
  models = [{ id: 'chat-model', supportsWebSearch: true }, { id: 'plain-model' }],
} = {}) {
  const calls = { listModels: 0, refresh: 0, ready: 0 };
  const provider = {
    async listModels() {
      calls.listModels += 1;
      return models;
    },
    async _refreshModelCache() {
      calls.refresh += 1;
      return models;
    },
  };
  const registry = {
    providerCatalogRevision: () => 7,
    getAllProviders: () => new Map([['fixture', provider]]),
    getProvider: () => provider,
  };
  const caches = {
    providerModelsLoadSeq: 0,
    providerModelsCache: { models: null, at: 0 },
    providerModelsPromise: null,
    webSearchProviderModelsCache: { models: null, at: 0 },
  };
  const api = createProviderModels({
    caches,
    modelMetaByRoute: new Map(),
    getRoute: () => ({ provider: 'fixture' }),
    getConfig: () => ({ providers: { fixture: { enabled: true }, off: { enabled: false } }, ...config }),
    getReg: () => registry,
    webSearchCapableFor: () => false,
    sortProviderModelsRaw: (rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id)),
    providerModelCacheRowRaw: (name, model) => ({ ...model, provider: name }),
    normalizeWebSearchProviderId: (name) => name,
    isWebSearchCapableProvider: (name) => name === 'fixture',
    ensureFullConfig: () => ({}),
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {
      calls.ready += 1;
    },
    bootProfile() {},
    scheduleProviderModelWarmup() {},
    quickHelpers: {
      quickProviderModelRows: () => [{ id: 'quick-model', provider: 'fixture', quick: true }],
      quickWebSearchProviderModelRows: () => [{ id: 'quick-search', provider: 'fixture', supportsWebSearch: true }],
      webSearchModelsFromRows: (rows) => rows.filter((row) => row.supportsWebSearch === true),
      webSearchRowsWithDefault: (rows) => [DEFAULT_ROW, ...rows],
      addDefaultWebSearchModel: (results, seen) => {
        results.push(DEFAULT_ROW);
        seen.add('default:default');
      },
    },
  });
  return { api, caches, calls };
}

test('hydration applies the saved alias and model settings and sorts through the route provider', () => {
  const { api } = fixture({
    config: {
      modelSettings: {
        [routeFastKey('fixture', 'chat-model')]: {
          alias: ' My Chat ',
          effort: 'high',
          fast: true,
          modelParameters: { temperature: 0.2 },
          contextPercent: '80',
        },
      },
    },
  });
  const [chat, plain] = api.providerModelsFromCacheRows([
    { id: 'plain-model', provider: 'fixture', display: 'Plain' },
    { id: 'chat-model', provider: 'fixture', display: 'Chat' },
  ]);
  assert.equal(chat.display, 'My Chat');
  assert.equal(chat.displayAlias, 'My Chat');
  assert.equal(chat.savedEffort, 'high');
  assert.equal(chat.savedFast, true);
  assert.equal(chat.fastPreferred, true);
  assert.deepEqual(chat.savedModelParameters, { temperature: 0.2 });
  assert.equal(chat.savedContextPercent, 80);
  assert.ok(Array.isArray(chat.effortOptions));
  assert.equal(typeof chat.fastCapable, 'boolean');
  assert.equal(plain.display, 'Plain');
  assert.equal(plain.displayAlias, undefined);
  assert.equal(plain.savedEffort, null);
  assert.equal(plain.savedFast, undefined);
  assert.deepEqual(plain.savedModelParameters, {});
  assert.equal(plain.savedContextPercent, undefined);
  assert.equal(api.modelMetaKey(' fixture ', 'chat-model'), 'fixture\nchat-model');
});

test('web-search models come from quick rows, then the cached provider rows, and a forced read rescans providers', async () => {
  const { api, caches, calls } = fixture();
  assert.deepEqual(
    (await api.collectWebSearchProviderModels()).map((row) => row.id),
    ['default', 'quick-search']
  );
  assert.equal(calls.listModels, 0);
  assert.equal(caches.webSearchProviderModelsCache.revision, 7);

  caches.webSearchProviderModelsCache = { models: null, at: 0 };
  caches.providerModelsCache = {
    models: [
      { id: 'chat-model', provider: 'fixture', supportsWebSearch: true },
      { id: 'plain-model', provider: 'fixture' },
    ],
    at: Date.now(),
    revision: 7,
  };
  assert.deepEqual(
    (await api.collectWebSearchProviderModels()).map((row) => row.id),
    ['chat-model', 'default']
  );
  assert.deepEqual(
    caches.webSearchProviderModelsCache.models.map((row) => row.id),
    ['default', 'chat-model']
  );

  const forced = await api.collectWebSearchProviderModels({ force: true });
  assert.equal(calls.refresh, 1, 'a forced read refreshes the provider cache first');
  assert.equal(calls.ready, 1);
  assert.deepEqual(
    forced.map((row) => [row.id, row.webSearchCapable, row.webSearchToolType]),
    [
      ['chat-model', true, 'web_search'],
      ['default', undefined, undefined],
    ]
  );
  assert.deepEqual(await api.enabledWebSearchProviderConfig(), { fixture: { enabled: true } });
});

test('a quick read answers with quick rows and seeds the secrets-aware load the next full read joins', async () => {
  const { api, caches, calls } = fixture();
  const quick = await api.collectProviderModels({ quick: true });
  assert.deepEqual(
    quick.map((row) => row.id),
    ['quick-model']
  );
  assert.ok(caches.providerModelsPromise, 'the quick read started the authoritative warm');
  const full = await api.collectProviderModels();
  assert.deepEqual(
    full.map((row) => row.id),
    ['chat-model', 'plain-model']
  );
  assert.equal(calls.listModels, 1);
  assert.equal(caches.providerModelsCache.revision, 7);
  await setImmediate();
  assert.equal(caches.providerModelsPromise, null);
  assert.equal(api.warmProviderModelCache(), null, 'a warm cache is not reloaded');
});

test('only a quick read answered from the loaded catalog says it is complete', async () => {
  const { api } = fixture();
  const cold = await api.collectProviderModels({ quick: true });
  assert.equal(
    cold.some((row) => 'catalogComplete' in row),
    false,
    'provisional quick rows ask for the full follow-up'
  );
  const full = await api.collectProviderModels();
  assert.equal(
    full.some((row) => 'catalogComplete' in row),
    false
  );
  const warm = await api.collectProviderModels({ quick: true });
  assert.deepEqual(
    warm.map((row) => [row.id, row.catalogComplete]),
    full.map((row) => [row.id, true])
  );
});
