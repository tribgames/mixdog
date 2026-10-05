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
