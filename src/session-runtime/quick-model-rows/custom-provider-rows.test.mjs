import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuickProviderRows } from './provider-rows.mjs';

test('configured custom models are available offline and deleted routes do not reappear', () => {
  const id = 'custom-84a2a4a1-30f6-43de-8813-c215de6046b6';
  const deleted = 'custom-6493c911-7c93-43af-8a44-c692ebd0f184';
  const config = {
    providers: {
      [id]: { type: 'custom', enabled: true, models: [{ id: 'vendor/model', name: 'Manual model', contextWindow: 8000, maxOutputTokens: 1000 }] },
    },
    presets: [{ provider: deleted, model: 'old-preset' }],
    agents: { worker: { provider: deleted, model: 'old-agent' } },
  };
  const rows = createQuickProviderRows({
    getRoute: () => ({ provider: deleted, model: 'old-main' }),
    displayConfig: () => config,
    providerModelCacheRow: (provider, model) => ({ ...model, provider }),
    providerModelsFromCacheRows: (models) => models,
    modelMetaByRoute: new Map(),
    modelMetaKey: (provider, model) => `${provider}:${model}`,
  })();
  assert.deepEqual(rows.map((row) => [row.provider, row.id]), [[id, 'vendor/model']]);
  assert.equal(rows[0].contextWindow, 8000);
  assert.equal(rows[0].outputTokens, 1000);
});
