import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The config path is fixed at module load: point it at a scratch dir first.
const dir = mkdtempSync(join(tmpdir(), 'mixdog-dev-gated-rows-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(dir, 'backups');

const { updateSection } = await import('../../runtime/shared/config.mjs');
const { createQuickProviderRows } = await import('./provider-rows.mjs');
const { createProviderModels } = await import('../provider-models.mjs');
const { providerModelCacheRow } = await import('../model-recency.mjs');

const ROUTE = { provider: 'devin-oauth', model: 'swe-1-6-slow', modelDisplay: 'SWE 1.6 Slow' };
const setDevin = (enabled) => updateSection('agent', (current) => ({ ...current, developer: { devinOAuth: enabled } }));

const OTHER_ROUTE = { provider: 'openai-oauth', model: 'gpt-fixture' };
const CATALOG = {
  'devin-oauth': [{ id: 'swe-1-6-slow', display: 'SWE 1.6 Slow' }],
  'openai-oauth': [{ id: 'gpt-fixture', display: 'GPT Fixture' }],
};

let nextRevision = 7000;
// `cold` starts with no cached catalog, so reads go through a real load of the
// registry's providers (the fake registry serves Devin even while its option is
// off; only the read-time availability filter may hide it).
function harness({ route = OTHER_ROUTE, cold = false } = {}) {
  const modelMetaByRoute = new Map();
  const revision = nextRevision++;
  const config = {
    providers: { 'devin-oauth': { enabled: true }, 'openai-oauth': { enabled: true } },
    presets: [{ provider: 'openai-oauth', model: 'gpt-fixture' }],
  };
  const caches = {
    providerModelsLoadSeq: 0,
    providerModelsCache: cold
      ? { models: null, at: 0 }
      : {
          models: Object.entries(CATALOG).flatMap(([provider, models]) =>
            models.map((model) => ({ ...model, provider }))
          ),
          at: Date.now(),
          revision,
        },
    providerModelsPromise: null,
    webSearchProviderModelsCache: { models: null, at: 0 },
  };
  const providerMap = new Map(
    Object.entries(CATALOG).map(([name, models]) => [name, { listModels: async () => models }])
  );
  const api = createProviderModels({
    caches,
    modelMetaByRoute,
    getRoute: () => route,
    getConfig: () => config,
    getReg: () => ({
      providerCatalogRevision: () => revision,
      getAllProviders: () => providerMap,
      getProvider: () => undefined,
    }),
    webSearchCapableFor: () => false,
    sortProviderModelsRaw: (models) => models,
    providerModelCacheRowRaw: (name, model) => ({ ...model, provider: name }),
    ensureFullConfig: () => ({}),
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
    bootProfile() {},
    scheduleProviderModelWarmup() {},
    quickHelpers: {},
  });
  const quick = createQuickProviderRows({
    getRoute: () => route,
    displayConfig: () => config,
    providerModelCacheRow: (provider, model) => providerModelCacheRow(provider, model, () => false),
    providerModelsFromCacheRows: api.providerModelsFromCacheRows,
    modelMetaByRoute,
    modelMetaKey: api.modelMetaKey,
  });
  return { api, quick, modelMetaByRoute };
}

const providers = (rows) => [...new Set(rows.map((row) => row.provider))].sort();

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('a developer-gated provider is absent from the quick picker and cached model list while its option is off, even for a pinned route', async () => {
  setDevin(false);
  for (const route of [OTHER_ROUTE, ROUTE]) {
    const { api, quick } = harness({ route });
    assert.deepEqual(providers(quick()), ['openai-oauth']);
    assert.deepEqual(providers(await api.collectProviderModels({ quick: true })), ['openai-oauth']);
    assert.deepEqual(providers(await api.collectProviderModels()), ['openai-oauth']);
  }
});

test('a cold, a forced and a first full load drop the gated provider while its option is off', async () => {
  setDevin(false);
  assert.deepEqual(providers(await harness({ cold: true }).api.collectProviderModels()), ['openai-oauth']);
  assert.deepEqual(providers(await harness({ cold: true }).api.collectProviderModels({ force: true })), [
    'openai-oauth',
  ]);
  const { api } = harness({ cold: true, route: ROUTE });
  assert.deepEqual(providers(await api.collectProviderModels()), ['openai-oauth']);
  // The answer is cached; the cached read stays filtered too.
  assert.deepEqual(providers(await api.collectProviderModels({ quick: true })), ['openai-oauth']);
});

test('the rows return when the developer option is switched back on', async () => {
  setDevin(true);
  const { api } = harness();
  assert.deepEqual(providers(await api.collectProviderModels({ quick: true })), ['devin-oauth', 'openai-oauth']);
  assert.deepEqual(providers(await api.collectProviderModels()), ['devin-oauth', 'openai-oauth']);
  assert.deepEqual(providers(await harness({ cold: true }).api.collectProviderModels()), [
    'devin-oauth',
    'openai-oauth',
  ]);
  // The quick picker lists Devin through the route that names it.
  const pinned = harness({ route: ROUTE }).quick();
  assert.ok(pinned.some((row) => row.provider === 'devin-oauth' && row.id === 'swe-1-6-slow'));
});

test('a session pinned to a now-hidden provider still resolves its route metadata', async () => {
  setDevin(false);
  const { api, quick, modelMetaByRoute } = harness({ route: ROUTE });
  assert.equal(
    quick().some((row) => row.provider === 'devin-oauth'),
    false
  );
  const meta = await api.lookupModelMeta(ROUTE.provider, ROUTE.model);
  assert.equal(meta.id, ROUTE.model);
  assert.equal(meta.provider, ROUTE.provider);
  assert.equal(meta.display, 'SWE 1.6 Slow');
  assert.ok(modelMetaByRoute.has(api.modelMetaKey(ROUTE.provider, ROUTE.model)));
});
