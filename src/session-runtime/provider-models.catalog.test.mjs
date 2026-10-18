import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { routeFastKey } from '../runtime/agent/orchestrator/runtime-core/model-capabilities.mjs';
import { pendingProviderCatalogOps } from '../runtime/agent/orchestrator/providers/catalog-deadline.mjs';
import { createProviderModels, PARTIAL_CATALOG_RETRY_MS } from './provider-models.mjs';

// The catalog paths provider-cache-lifecycle.test.mjs leaves alone: row
// hydration from saved model settings, the web-search catalog (quick rows →
// cached provider rows → forced provider scan), and the quick read that seeds
// the authoritative load.

const DEFAULT_ROW = { id: 'default', provider: 'default', display: 'Default' };

function fixture({
  config = {},
  models = [{ id: 'chat-model', supportsWebSearch: true }, { id: 'plain-model' }],
  extraProviders = [],
  revision = 7,
  providerCatalogTimeoutMs,
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
    providerCatalogRevision: () => revision,
    getAllProviders: () => new Map([['fixture', provider], ...extraProviders]),
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
    providerCatalogTimeoutMs,
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

/** A provider whose model list stays pending until the test settles it. */
function hangingProvider(models = [{ id: 'slow-model' }]) {
  const slow = {
    calls: 0,
    signals: [],
    pending: [],
    hang: true,
    listModels({ signal } = {}) {
      slow.calls += 1;
      slow.signals.push(signal);
      if (!slow.hang) return Promise.resolve(models);
      const request = Promise.withResolvers();
      slow.pending.push(request);
      return request.promise;
    },
    answer: () => {
      for (const request of slow.pending.splice(0)) request.resolve(models);
    },
  };
  return slow;
}

test('a hanging provider yields a timely partial catalog that is reused, then filled in by a later retry', async (t) => {
  const slow = hangingProvider();
  const { api, caches, calls } = fixture({
    extraProviders: [['slow', slow]],
    revision: 8101,
    providerCatalogTimeoutMs: 50,
  });
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });

  const startedAt = performance.now();
  const partial = await api.collectProviderModels();
  assert.ok(performance.now() - startedAt < 2_000, 'the hanging provider is bounded by its timeout');
  assert.deepEqual(
    partial.map((row) => row.id),
    ['chat-model', 'plain-model']
  );
  // The full answer says it is partial, which providers are missing and when
  // to ask again.
  assert.deepEqual(
    partial.map((row) => [row.catalogPartial, row.catalogMissing, row.catalogRetryAt]),
    partial.map(() => [true, ['slow'], 1_000_000 + PARTIAL_CATALOG_RETRY_MS])
  );
  assert.equal(caches.providerModelsCache.partial, true);
  assert.deepEqual(caches.providerModelsCache.missing, ['slow']);
  assert.equal(caches.providerModelsCache.retryAt, 1_000_000 + PARTIAL_CATALOG_RETRY_MS);

  // Inside the retry window the partial catalog is served without a reload,
  // and a quick read from it does not claim to be complete.
  await api.collectProviderModels();
  const quick = await api.collectProviderModels({ quick: true });
  assert.equal(
    quick.some((row) => row.catalogComplete),
    false
  );
  assert.equal(
    quick.every((row) => row.catalogPartial === true),
    true
  );
  assert.equal(slow.calls, 1);
  assert.equal(calls.listModels, 1);
  assert.equal(caches.providerModelsPromise, null);

  // After the window a read still answers from the partial rows at once and
  // retries only the missing provider in the background. While its first,
  // timed-out list is still pending the retry fails fast instead of starting
  // a second list or waiting out another deadline.
  t.mock.timers.tick(PARTIAL_CATALOG_RETRY_MS);
  const stale = await api.collectProviderModels();
  assert.deepEqual(
    stale.map((row) => row.id),
    ['chat-model', 'plain-model']
  );
  assert.ok(caches.providerModelsPromise, 'the retry runs in the background');
  await caches.providerModelsPromise;
  assert.equal(slow.calls, 1);
  assert.equal(caches.providerModelsCache.partial, true);

  // Once that list settles and the provider is back, the next retry fills it in.
  slow.hang = false;
  slow.answer();
  await setImmediate();
  t.mock.timers.tick(PARTIAL_CATALOG_RETRY_MS);
  await api.collectProviderModels();
  await caches.providerModelsPromise;
  assert.equal(slow.calls, 2);
  assert.equal(calls.listModels, 1, 'providers that answered are not asked again');
  assert.equal(caches.providerModelsCache.partial, undefined);
  const filled = await api.collectProviderModels();
  assert.deepEqual(
    filled.map((row) => row.id),
    ['chat-model', 'plain-model', 'slow-model']
  );
  assert.equal(
    filled.some((row) => 'catalogPartial' in row),
    false
  );
});

test('a forced read asks every healthy provider while a partial catalog is cached', async (t) => {
  const slow = hangingProvider();
  const { api, caches, calls } = fixture({
    extraProviders: [['slow', slow]],
    revision: 8102,
    providerCatalogTimeoutMs: 50,
  });
  t.mock.timers.enable({ apis: ['Date'], now: 2_000_000 });
  await api.collectProviderModels();
  assert.equal(caches.providerModelsCache.partial, true);
  const forced = await api.collectProviderModels({ force: true });
  assert.deepEqual(
    forced.map((row) => row.id),
    ['chat-model', 'plain-model']
  );
  assert.equal(calls.listModels, 2);
  assert.equal(caches.providerModelsCache.partial, true);
  slow.answer();
});

test('repeated timed-out reads leave at most one pending list per provider, and the timeout aborts it', async () => {
  const slow = hangingProvider();
  const { api } = fixture({ extraProviders: [['slow', slow]], revision: 8103, providerCatalogTimeoutMs: 200 });
  for (let i = 0; i < 4; i += 1) await api.collectProviderModels({ force: true });
  assert.equal(slow.calls, 1, 'no second list starts while the first is pending');
  // Later reads fail fast on the overdue list instead of each waiting it out.
  const startedAt = performance.now();
  await api.collectProviderModels({ force: true });
  assert.ok(performance.now() - startedAt < 100, 'well under the 200ms deadline');
  assert.equal(pendingProviderCatalogOps().filter((name) => name === 'slow').length, 1);
  assert.equal(slow.signals[0]?.aborted, true, 'the deadline cancels a list that honors its signal');
  slow.answer();
  await setImmediate();
  assert.equal(pendingProviderCatalogOps().includes('slow'), false);
  await api.collectProviderModels({ force: true });
  assert.equal(slow.calls, 2, 'a settled list frees the provider for the next read');
});
