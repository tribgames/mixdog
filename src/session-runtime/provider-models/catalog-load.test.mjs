import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { noEnabledProvidersError } from '../../runtime/agent/orchestrator/providers/registry-errors.mjs';
import { OpenAICompatProvider } from '../../runtime/agent/orchestrator/providers/openai-compat.mjs';
import { sharedProviderCatalog } from '../provider-catalog-cache.mjs';
import { createCatalogLoader } from './catalog-load.mjs';

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}
import { createModelMetaIndex } from './model-meta.mjs';
import { providerModelCacheRow } from '../model-recency.mjs';

function loader(ensureProvidersReady) {
  return createCatalogLoader({
    caches: { providerModelsLoadSeq: 0 },
    config: () => ({ providers: { openai: { enabled: false } } }),
    reg: () => {
      throw new Error('the catalog must not be read without an enabled provider');
    },
    meta: {},
    rows: {},
    profile: () => {},
    ensureFullConfig: () => {},
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady,
  });
}

test('no enabled provider loads an empty, uncached catalog instead of failing', async () => {
  const load = loader(async () => {
    throw noEnabledProvidersError('[provider] all providers disabled in config — refusing to clear registry');
  });
  const request = { seq: 0 };
  assert.deepEqual(await load({ request }), []);
  assert.notEqual(request.complete, true);
});

test('a hidden custom model leaves the full catalog while its metadata keeps resolving', async () => {
  const provider = 'custom-hidden-catalog';
  const models = [
    { id: 'shown', provider, hidden: false, manual: false, reasoningLevels: [] },
    { id: 'secret', provider, hidden: true, manual: true, reasoningLevels: ['low'] },
  ];
  const registry = {
    providerCatalogRevision: () => 424242,
    getAllProviders: () => [[provider, { listModels: async () => models }]],
    getProvider: () => null,
  };
  const caches = { providerModelsLoadSeq: 0 };
  const modelMetaByRoute = new Map();
  const meta = createModelMetaIndex({
    caches,
    modelMetaByRoute,
    reg: () => registry,
    scheduleProviderModelWarmup: () => {},
  });
  const load = createCatalogLoader({
    caches,
    config: () => ({ providers: {} }),
    reg: () => registry,
    meta,
    rows: { providerModelCacheRow: (name, m) => providerModelCacheRow(name, m, () => false) },
    profile: () => {},
    ensureFullConfig: () => {},
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
  });
  const rows = await load({ loadSecrets: false, request: { seq: 0 } });
  assert.deepEqual(
    rows.map((row) => row.id),
    ['shown']
  );
  assert.deepEqual(rows[0].reasoningLevels, []);
  assert.equal(rows[0].hidden, false);
  const secret = await meta.lookupModelMeta(provider, 'secret');
  assert.equal(secret.hidden, true);
  assert.deepEqual(secret.reasoningLevels, ['low']);
});

test("model metadata keeps a provider row's explicit [] and false", async () => {
  const registry = {
    providerCatalogRevision: () => 1,
    getProvider: () => ({
      listModels: async () => [],
      getCachedModelInfo: (id) => ({ id, hidden: true, supportsReasoning: false, reasoningLevels: [] }),
    }),
  };
  const meta = createModelMetaIndex({
    caches: { providerModelsLoadSeq: 0 },
    modelMetaByRoute: new Map(),
    reg: () => registry,
    scheduleProviderModelWarmup: () => {},
  });
  const row = await meta.lookupModelMeta('custom-1', 'm');
  assert.equal(row.hidden, true);
  assert.equal(row.supportsReasoning, false);
  assert.deepEqual(row.reasoningLevels, []);
  assert.equal(row.provider, 'custom-1');
});

test('a compat provider whose models request fails leaves the load incomplete and uncached', async () => {
  const provider = new OpenAICompatProvider('xai', { apiKey: 'k', preconnect: false });
  const registry = {
    providerCatalogRevision: () => 515151,
    getAllProviders: () => [['xai', provider]],
    getProvider: () => provider,
  };
  const entries = await withFetch(
    async () => new Response('forbidden', { status: 403 }),
    () => sharedProviderCatalog(registry)
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].error.status, 403);
  assert.deepEqual(entries[0].models, []);

  const load = createCatalogLoader({
    caches: { providerModelsLoadSeq: 0 },
    config: () => ({ providers: {} }),
    reg: () => registry,
    meta: { syncCatalogRevision: () => 515151, snapshotIsCurrent: () => true, remember: () => {} },
    rows: { providerModelCacheRow: (name, m) => ({ provider: name, ...m }) },
    profile: () => {},
    ensureFullConfig: () => {},
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
  });
  const request = { seq: 0 };
  const rows = await withFetch(
    async () => new Response('forbidden', { status: 403 }),
    () => load({ loadSecrets: false, request })
  );
  assert.deepEqual(rows, []);
  assert.equal(request.complete, false);

  // The failed load was not cached: a later success is picked up.
  const recovered = await withFetch(
    async () => Response.json({ data: [{ id: 'grok-test-model' }] }),
    () => sharedProviderCatalog(registry)
  );
  assert.equal(Object.hasOwn(recovered[0], 'error'), false);
  assert.deepEqual(
    recovered[0].models.map((m) => m.id),
    ['grok-test-model']
  );
});

test('any other provider init failure still surfaces', async () => {
  const load = loader(async () => {
    throw new Error('[provider] Failed to init "openai": boom');
  });
  await assert.rejects(load({ request: { seq: 0 } }), /Failed to init "openai"/);
});
