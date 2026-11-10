import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateProviderModelRow } from './row-hydration.mjs';

const sortOption = (row) => row.modelParameterOptions?.find((o) => o.id === 'providerSort');

test('OpenRouter rows offer the routing picker row; other providers do not', () => {
  const row = hydrateProviderModelRow({}, { provider: 'openrouter', id: 'deepseek/deepseek-v4' });
  assert.deepEqual(sortOption(row), {
    id: 'providerSort',
    label: 'Routing',
    kind: 'enum',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'price', label: 'Price first' },
      { value: 'throughput', label: 'Speed first' },
      { value: 'latency', label: 'Latency first' },
    ],
  });
  assert.equal(sortOption(hydrateProviderModelRow({}, { provider: 'deepseek', id: 'deepseek-chat' })), undefined);
});

test('a saved routing choice comes back on the row', () => {
  const cfg = { modelSettings: { 'openrouter/a/b': { modelParameters: { providerSort: 'price' } } } };
  const row = hydrateProviderModelRow(cfg, { provider: 'openrouter', id: 'a/b' });
  assert.equal(row.savedModelParameters.providerSort, 'price');
});
