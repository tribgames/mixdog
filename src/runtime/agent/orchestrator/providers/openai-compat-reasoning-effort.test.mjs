import '../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { extractCompatReasoningEffort, listCompatModels } from './openai-compat-models.mjs';
import { customEffortLevels } from './custom-reasoning.mjs';
import { effectiveCustomModelRows } from './custom-provider-config.mjs';

const gatewayLevels = ['low', 'medium', 'high', 'xhigh', 'max'];

test('endpoint-declared effort levels preserve the full gateway ladder', () => {
  assert.deepEqual(extractCompatReasoningEffort({ reasoning_efforts: gatewayLevels }), {
    supportsReasoning: true,
    reasoningLevels: gatewayLevels,
    reasoningOptions: [{ type: 'effort', values: gatewayLevels }],
  });
});

test('OpenCodeX value/label option objects preserve the declared ladder', () => {
  assert.deepEqual(
    extractCompatReasoningEffort({
      reasoning_efforts: [
        { value: 'low', label: 'Low Effort' },
        { value: 'medium', label: 'Medium Effort', default: true },
        { value: 'high', label: 'High Effort' },
        { value: 'xhigh', label: 'Xhigh Effort' },
        { value: 'max', label: 'Max Effort' },
        null,
        { label: 'Not a level' },
        { value: 123 },
      ],
    })?.reasoningLevels,
    gatewayLevels
  );
});

test('declared effort levels use the shared vocabulary, deduplicate, and rank', () => {
  assert.deepEqual(
    extractCompatReasoningEffort({
      reasoning_efforts: [' HIGH ', 'low', 'ultra', 'BOGUS', 123, null, 'low', 'medium'],
    })?.reasoningLevels,
    ['low', 'medium', 'high', 'max']
  );
  assert.deepEqual(extractCompatReasoningEffort({ reasoning_efforts: ['none'] }), {
    supportsReasoning: false,
    reasoningLevels: ['none'],
    reasoningOptions: [{ type: 'effort', values: ['none'] }],
  });
});

test('alternative explicit array fields and their precedence are preserved', () => {
  for (const model of [
    { reasoning_levels: ['minimal', 'high'] },
    { reasoningLevels: ['minimal', 'high'] },
    { capabilities: { reasoning_efforts: ['minimal', 'high'] } },
    { capabilities: { reasoning_effort: ['minimal', 'high'] } },
  ]) {
    assert.deepEqual(extractCompatReasoningEffort(model)?.reasoningLevels, ['minimal', 'high']);
  }
  assert.deepEqual(
    extractCompatReasoningEffort({
      reasoning_efforts: ['low'],
      reasoning_levels: ['high'],
      capabilities: { reasoning_efforts: ['max'] },
    })?.reasoningLevels,
    ['low']
  );
});

test('boolean-only reasoning support never invents selectable effort levels', () => {
  for (const model of [
    { supports_reasoning_effort: true },
    { capabilities: { reasoning_effort: true } },
    { capabilities: { reasoning_efforts: true } },
  ]) {
    assert.deepEqual(extractCompatReasoningEffort(model), { supportsReasoning: true });
  }
});

test('invalid or empty declarations cannot become an inferred default ladder', () => {
  for (const model of [
    null,
    {},
    { reasoning_efforts: [] },
    { reasoning_efforts: ['bogus', 'unknown'] },
    { reasoning_efforts: [], supports_reasoning_effort: true },
    { reasoning_efforts: ['bogus'], supports_reasoning_effort: true },
    { reasoning_efforts: [], reasoning_levels: ['high'] },
    { supports_reasoning_effort: false },
    { capabilities: { reasoning_effort: false } },
    { reasoning_efforts: 'high' },
  ]) {
    assert.equal(extractCompatReasoningEffort(model), null);
  }
});

test('discovery through effective custom rows preserves gateway levels and user override priority', async () => {
  const id = 'command-code/z-ai/glm-5.3-flash';
  const provider = {
    name: 'custom-gateway-effort-test',
    _fetchModelItems: async () => [
      {
        id,
        context_window: 450000,
        supports_reasoning_effort: true,
        reasoning_effort: 'medium',
        reasoning_efforts: [
          { value: 'low', label: 'Low Effort' },
          { value: 'medium', label: 'Medium Effort', default: true },
          { value: 'high', label: 'High Effort' },
          { value: 'xhigh', label: 'Xhigh Effort' },
          { value: 'max', label: 'Max Effort' },
        ],
      },
      {
        id: 'gateway-served-unknown-model-12345',
        reasoning_efforts: gatewayLevels,
      },
    ],
  };
  const discovered = await listCompatModels(provider, { throwOnError: true });
  assert.equal(discovered.length, 2);
  const config = {
    schemaVersion: 2,
    name: 'Gateway Provider',
    protocol: 'openai-chat',
    baseURL: 'http://127.0.0.1:10100/v1',
    auth: 'none',
    modelOverrides: {},
  };
  const rows = effectiveCustomModelRows(config, discovered, { providerId: provider.name });
  for (const row of rows) {
    assert.deepEqual(row.reasoningLevels, gatewayLevels);
    assert.deepEqual(row.reasoningOptions, [{ type: 'effort', values: gatewayLevels }]);
    assert.deepEqual(customEffortLevels(row), gatewayLevels);
  }
  assert.equal(rows.find((row) => row.id === id).contextWindow, 450000);

  for (const levels of [[], ['low', 'high']]) {
    const overridden = effectiveCustomModelRows(
      { ...config, modelOverrides: { [id]: { reasoning: { levels } } } },
      discovered,
      { providerId: provider.name }
    );
    assert.deepEqual(customEffortLevels(overridden.find((row) => row.id === id)), levels);
  }
});
