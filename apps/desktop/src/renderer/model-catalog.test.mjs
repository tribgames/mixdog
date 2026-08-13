import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizedProviderModels } from '../main/desktop-support.ts';
import { modelOptionDescription } from './provider-display.tsx';

test('desktop model catalog preserves complete picker metadata', () => {
  const [model] = normalizedProviderModels([{
    provider: 'grok-oauth',
    id: 'grok-4.6',
    display: 'Grok 4.6',
    contextWindow: 500_000,
    description: 'Frontier reasoning model.',
    effortOptions: [],
  }]);

  assert.equal(model.contextWindow, 500_000);
  assert.equal(model.description, 'Frontier reasoning model.');
  assert.equal(modelOptionDescription(model), '500k Context');
});

test('model picker uses provider descriptions without a dash placeholder', () => {
  const base = {
    provider: 'test',
    model: 'test-model',
    display: 'Test model',
    effortOptions: [],
    fastCapable: false,
    fastPreferred: false,
  };

  assert.equal(modelOptionDescription({ ...base, description: 'Provider description.' }), 'Provider description.');
  assert.equal(modelOptionDescription(base), '');
});
