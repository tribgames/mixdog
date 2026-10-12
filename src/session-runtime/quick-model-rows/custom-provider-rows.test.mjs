import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuickProviderRows } from './provider-rows.mjs';
import { hydratedModel } from './model-meta.mjs';
import { providerModelCacheRow } from '../model-recency.mjs';
import { customEffortLevels } from '../../runtime/agent/orchestrator/providers/custom-reasoning.mjs';

const BASE = {
  type: 'custom',
  name: 'Gateway',
  protocol: 'openai-chat',
  baseURL: 'https://gw.example.com/v1',
  enabled: true,
};

function quickRows(config, route = {}) {
  const modelMetaByRoute = new Map();
  const rows = createQuickProviderRows({
    getRoute: () => route,
    displayConfig: () => config,
    providerModelCacheRow: (provider, model) => providerModelCacheRow(provider, model, () => false),
    providerModelsFromCacheRows: (models) => models,
    modelMetaByRoute,
    modelMetaKey: (provider, model) => `${provider}:${model}`,
  })();
  return { rows, modelMetaByRoute };
}

test('configured custom models are available offline and deleted routes do not reappear', () => {
  const id = 'custom-84a2a4a1-30f6-43de-8813-c215de6046b6';
  const deleted = 'custom-6493c911-7c93-43af-8a44-c692ebd0f184';
  const config = {
    providers: {
      [id]: {
        ...BASE,
        models: [{ id: 'vendor/model', name: 'Manual model', contextWindow: 8000, maxOutputTokens: 1000 }],
      },
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
  assert.deepEqual(
    rows.map((row) => [row.provider, row.id]),
    [[id, 'vendor/model']]
  );
  assert.equal(rows[0].contextWindow, 8000);
  assert.equal(rows[0].outputTokens, 1000);
});

const V2_ID = 'custom-0d6f3d4e-8c55-4a43-9b3e-6a8f6c3f1b10';
const v2Config = (overrides = {}) => ({
  providers: {
    [V2_ID]: {
      ...BASE,
      schemaVersion: 2,
      auth: 'none',
      discovery: { newModelsHidden: false },
      modelOverrides: {
        'vendor/visible': {
          manual: true,
          name: 'Visible',
          contextWindow: 8000,
          maxOutputTokens: 1000,
          reasoning: { levels: ['low', 'high'], wireFormat: 'standard', wireValues: { high: 'max' }, replay: false },
        },
        'vendor/plain': { manual: true, reasoning: { levels: [] } },
        'vendor/secret': { manual: true, hidden: true },
        ...overrides,
      },
    },
  },
});

test('v2 custom rows come from effective rows and carry the contract fields, explicit [] and false included', () => {
  const { rows } = quickRows(v2Config());
  assert.deepEqual(rows.map((row) => row.id).sort(), ['vendor/plain', 'vendor/visible']);
  const visible = rows.find((row) => row.id === 'vendor/visible');
  assert.equal(visible.provider, V2_ID);
  assert.equal(visible.name, 'Visible');
  assert.equal(visible.contextWindow, 8000);
  assert.equal(visible.outputTokens, 1000);
  assert.equal(visible.hidden, false);
  assert.equal(visible.manual, true);
  assert.deepEqual(customEffortLevels(visible), ['low', 'high']);
  assert.equal(visible.customReasoning.wireFormat, 'standard');
  assert.equal(visible.customReasoning.replay, false);
  assert.deepEqual(visible.customReasoning.wireValues, { high: 'max' });
  const plain = rows.find((row) => row.id === 'vendor/plain');
  assert.deepEqual(customEffortLevels(plain), []);
});

test('a hidden custom model leaves the quick picker, a saved route on it included, but its metadata resolves', () => {
  const { rows, modelMetaByRoute } = quickRows(v2Config(), { provider: V2_ID, model: 'vendor/secret' });
  assert.equal(
    rows.some((row) => row.id === 'vendor/secret'),
    false
  );
  const meta = modelMetaByRoute.get(`${V2_ID}:vendor/secret`);
  assert.equal(meta.id, 'vendor/secret');
  assert.equal(meta.hidden, true);
});

test('saved routes on uncached custom models get the effective overrides (hidden excluded, declarations kept)', () => {
  // Overrides on discovered (non-manual) ids that are not in the catalog cache:
  // only the saved routes name them. Real normalizer, no mocks.
  const config = {
    ...v2Config({
      'vendor/discovered-hidden': { hidden: true, reasoning: { levels: [] } },
      'vendor/discovered-tuned': { name: 'Tuned', maxOutputTokens: 4321, reasoning: { levels: ['low'], replay: true } },
    }),
    presets: [{ provider: V2_ID, model: 'vendor/discovered-tuned' }],
  };
  const { rows, modelMetaByRoute } = quickRows(config, { provider: V2_ID, model: 'vendor/discovered-hidden' });
  assert.equal(
    rows.some((row) => row.id === 'vendor/discovered-hidden'),
    false
  );
  const hidden = modelMetaByRoute.get(`${V2_ID}:vendor/discovered-hidden`);
  assert.equal(hidden.hidden, true);
  assert.deepEqual(customEffortLevels(hidden), []);
  assert.equal(hidden.supportsReasoning, false);
  const tuned = rows.find((row) => row.id === 'vendor/discovered-tuned');
  assert.equal(tuned.name, 'Tuned');
  assert.equal(tuned.outputTokens, 4321);
  assert.deepEqual(customEffortLevels(tuned), ['low']);
  assert.equal(tuned.customReasoning.replay, true);
  assert.equal(tuned.reasoningContentField, 'reasoning_content');
});

test('a custom provider whose stored config is invalid lists nothing, saved routes on it included', () => {
  const config = v2Config({ broken: { contextWindow: '4096' } });
  const { rows } = quickRows(config, { provider: V2_ID, model: 'vendor/visible' });
  assert.deepEqual(rows, []);
});

test("hydratedModel keeps a custom row's declared fields over catalog metadata", () => {
  const customReasoning = { wireFormat: 'deepseek', wireValues: {}, replay: false };
  const row = hydratedModel('custom-x', {
    id: 'deepseek-chat',
    supportsReasoning: false,
    reasoningLevels: [],
    hidden: true,
    manual: false,
    customReasoning,
  });
  assert.equal(row.supportsReasoning, false);
  assert.deepEqual(row.reasoningLevels, []);
  assert.deepEqual(row.reasoningOptions, []);
  assert.equal(row.hidden, true);
  assert.equal(row.manual, false);
  assert.deepEqual(row.customReasoning, customReasoning);
});
