import { test } from 'node:test';
import assert from 'node:assert/strict';

import { providerModelCacheRow } from './model-recency.mjs';

const windows = (provider, model) => {
  const row = providerModelCacheRow(provider, { id: 'm', ...model }, () => false);
  return { contextWindow: row.contextWindow, maxContextWindow: row.maxContextWindow };
};

test('a picker row states the default window of its range and the whole window as its maximum', () => {
  assert.deepEqual(windows('anthropic-oauth', { contextWindow: 1_000_000 }), {
    contextWindow: 500_000,
    maxContextWindow: 1_000_000,
  });
  assert.deepEqual(windows('gemini', { contextWindow: 1_048_576 }), {
    contextWindow: 500_000,
    maxContextWindow: 1_048_576,
  });
});

test('a row at or under the ceiling, a provider default and a local window are left as stated', () => {
  assert.deepEqual(windows('grok-oauth', { contextWindow: 256_000 }), {
    contextWindow: 256_000,
    maxContextWindow: null,
  });
  assert.deepEqual(windows('openai-oauth', { contextWindow: 272_000, maxContextWindow: 872_000 }), {
    contextWindow: 272_000,
    maxContextWindow: 872_000,
  });
  assert.deepEqual(windows('mixdog-local', { contextWindow: 1_000_000 }), {
    contextWindow: 1_000_000,
    maxContextWindow: null,
  });
  assert.deepEqual(windows('fixture', {}), { contextWindow: undefined, maxContextWindow: null });
});

test('a custom cache row carries the effective-row fields, explicit [] and false included', () => {
  const customReasoning = { wireFormat: 'deepseek', wireValues: { high: 'max' }, replay: true };
  const row = providerModelCacheRow(
    'custom-1',
    {
      id: 'm',
      name: 'Model',
      hidden: false,
      manual: true,
      supportsReasoning: false,
      reasoningLevels: [],
      customReasoning,
      reasoningContentField: 'reasoning_content',
    },
    () => false
  );
  assert.equal(row.name, 'Model');
  assert.equal(row.hidden, false);
  assert.equal(row.manual, true);
  assert.equal(row.supportsReasoning, false);
  assert.deepEqual(row.reasoningLevels, []);
  assert.deepEqual(row.customReasoning, customReasoning);
  assert.equal(row.reasoningContentField, 'reasoning_content');
  assert.equal(providerModelCacheRow('custom-1', { id: 'm', hidden: true }, () => false).hidden, true);
});

test('a first-party cache row is unchanged by the custom fields', () => {
  const row = providerModelCacheRow('openai', { id: 'm', name: 'M', hidden: true, manual: true }, () => false);
  for (const key of ['name', 'manual', 'customReasoning']) assert.equal(Object.hasOwn(row, key), false);
  // A provider catalog's own hidden mark (visibility) does carry over.
  assert.equal(row.hidden, true);
  assert.equal(Object.hasOwn(providerModelCacheRow('openai', { id: 'm' }, () => false), 'hidden'), false);
});
