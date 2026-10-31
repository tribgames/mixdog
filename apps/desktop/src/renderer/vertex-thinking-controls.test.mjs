import assert from 'node:assert/strict';
import test from 'node:test';

import { VertexAIProvider } from '../../../../src/runtime/agent/orchestrator/providers/vertex-ai.mjs';
import { buildGeminiRequest } from '../../../../src/runtime/agent/orchestrator/providers/gemini-request-body.mjs';
import { providerModelCacheRow } from '../../../../src/session-runtime/model-recency.mjs';
import { hydrateProviderModelRow } from '../../../../src/session-runtime/provider-models/row-hydration.mjs';
import { routeSheetRows } from './route-editor-logic.ts';
import { effortForModelChoice, routeOption } from './model-route-utils.ts';

test('native Vertex Argon picker exposes the three Gemini thinking levels and sends each unchanged', async () => {
  const model = (await new VertexAIProvider({}).listModels()).find((row) => row.id === 'gemini-4-argon');
  const catalogRow = providerModelCacheRow('vertex-ai', model, () => false);
  const hydrated = hydrateProviderModelRow({}, catalogRow);
  const choice = routeOption(hydrated);
  const levels = ['low', 'medium', 'high'];
  assert.equal(hydrated.supportsReasoning, true);
  assert.deepEqual(choice.effortOptions.map((entry) => entry.value), levels);
  assert.ok(routeSheetRows({ hasModel: true, effortCount: choice.effortOptions.length, contextVisible: true, fastVisible: false }).includes('effort'));
  for (const effort of levels) {
    assert.equal(effortForModelChoice({ values: levels, sameModel: true, current: effort }), effort);
    assert.deepEqual(
      buildGeminiRequest([{ role: 'user', content: 'fixture' }], model.id, [], { effort }).generationConfig.thinkingConfig,
      { includeThoughts: true, thinkingLevel: effort }
    );
  }
});

test('Vertex does not invent thinking controls for unverified Gemini variants', async () => {
  const models = await new VertexAIProvider({}).listModels();
  for (const id of ['gemini-4-argon-cyber-permissive', 'gemini-3.7-flash']) {
    const model = models.find((row) => row.id === id);
    const hydrated = hydrateProviderModelRow({}, providerModelCacheRow('vertex-ai', model, () => false));
    assert.deepEqual(routeOption(hydrated).effortOptions, []);
  }
});
