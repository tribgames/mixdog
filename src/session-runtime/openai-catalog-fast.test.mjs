import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('OpenAI OAuth catalog Fast capability survives caching and agrees with request tiers', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-catalog-fast-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const [
    { _normalizeCodexModel },
    { makeModelCache },
    { OpenAIOAuthProvider, buildRequestBody },
    { createProviderModels },
    { providerModelCacheRow, sortProviderModels },
    { fastCapableFor },
  ] = await Promise.all([
    import('../runtime/agent/orchestrator/providers/openai-codex-model.mjs'),
    import('../runtime/agent/orchestrator/providers/model-cache.mjs'),
    import('../runtime/agent/orchestrator/providers/openai-oauth.mjs'),
    import('./provider-models.mjs'),
    import('./model-recency.mjs'),
    import('./model-capabilities.mjs'),
  ]);
  const advertised = {
    service_tiers: [{ id: 'priority', name: 'Fast', description: 'Increased usage' }],
    additional_speed_tiers: ['fast'],
  };
  const cases = [
    { slug: 'gpt-6-astra', ...advertised, expected: true },
    { slug: 'gpt-reserve', ...advertised, expected: true },
    { slug: 'codex-auto-review', ...advertised, expected: true },
    { slug: 'future-mini', ...advertised, expected: true },
    { slug: 'future-nano', ...advertised, expected: true },
    { slug: 'gpt-5.4-mini', service_tiers: [], additional_speed_tiers: [], expected: false },
    { slug: 'gpt-5.5', expected: false },
    { slug: 'gpt-daybreak-blue-latest', service_tiers: [], expected: false },
    { slug: 'future-speed-tier', additional_speed_tiers: ['priority'], expected: true },
    { slug: 'future-default-tier', default_service_tier: 'priority', expected: true },
    { slug: 'future-speed-label', additional_speed_tiers: ['fast'], expected: false },
    { slug: 'future-other-tier', service_tiers: [{ id: 'flex' }], expected: false },
  ];
  const modelCache = makeModelCache({
    fileName: 'openai-oauth-models.json',
    version: 3,
    ttlMs: 60_000,
  });
  modelCache.save(cases.map(_normalizeCodexModel));
  // Use the real cache reader without loading any user credentials or sending
  // inference requests. The production listModels populates the wire catalog.
  const provider = Object.create(OpenAIOAuthProvider.prototype);
  let revision = 1;
  const registry = {
    providerCatalogRevision: () => revision,
    getAllProviders: () => new Map([['openai-oauth', provider]]),
    getProvider: () => provider,
  };
  const config = {
    modelSettings: { 'openai-oauth/gpt-6-astra': { fast: true } },
  };
  const api = createProviderModels({
    caches: {
      providerModelsLoadSeq: 0,
      providerModelsCache: { models: null },
      webSearchProviderModelsCache: { models: null },
    },
    modelMetaByRoute: new Map(),
    getRoute: () => ({ provider: 'openai-oauth' }),
    getConfig: () => config,
    getReg: () => registry,
    webSearchCapableFor: () => false,
    sortProviderModelsRaw: sortProviderModels,
    providerModelCacheRowRaw: providerModelCacheRow,
    ensureFullConfig: () => config,
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
    bootProfile: () => {},
    scheduleProviderModelWarmup: () => {},
    quickHelpers: {},
  });
  const messages = [{ role: 'user', content: 'Catalog Fast regression' }];
  const rows = await api.collectProviderModels();
  assert.equal(rows.length, cases.length);
  for (const entry of cases) {
    const row = rows.find(model => model.id === entry.slug);
    assert.equal(row.fastCapable, entry.expected, `${entry.slug}: picker capability`);
    const routeMeta = await api.lookupModelMeta('openai-oauth', entry.slug);
    assert.equal(fastCapableFor('openai-oauth', routeMeta), entry.expected, `${entry.slug}: saved route capability`);
    assert.equal(
      buildRequestBody(messages, entry.slug, [], { fast: true }).service_tier,
      entry.expected ? 'priority' : undefined,
      `${entry.slug}: requested tier`,
    );
    assert.equal(buildRequestBody(messages, entry.slug, [], { fast: false }).service_tier, undefined);
  }
  assert.equal(rows.find(model => model.id === 'gpt-6-astra').fastPreferred, true);
  assert.equal(
    (await api.collectProviderModels()).find(model => model.id === 'gpt-6-astra').fastCapable,
    true,
    'cached picker retains server capability',
  );
  assert.equal(buildRequestBody(messages, 'unknown-model', [], { fast: true }).service_tier, undefined);

  // A server catalog revision can revoke or grant support for the same id.
  // Cached picker rows and route metadata must adopt it, not the model name
  // or a saved Fast preference.
  modelCache.save([
    _normalizeCodexModel({ slug: 'gpt-6-astra', service_tiers: [] }),
    _normalizeCodexModel({ slug: 'gpt-5.5', ...advertised }),
  ]);
  revision += 1;
  const refreshed = await api.collectProviderModels();
  assert.equal(refreshed.find(model => model.id === 'gpt-6-astra').fastCapable, false);
  assert.equal(refreshed.find(model => model.id === 'gpt-5.5').fastCapable, true);
  assert.equal(fastCapableFor('openai-oauth', await api.lookupModelMeta('openai-oauth', 'gpt-6-astra')), false);
  assert.equal(buildRequestBody(messages, 'gpt-6-astra', [], { fast: true }).service_tier, undefined);
  assert.equal(buildRequestBody(messages, 'gpt-5.5', [], { fast: true }).service_tier, 'priority');
});
