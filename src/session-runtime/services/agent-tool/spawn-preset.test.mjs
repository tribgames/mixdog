import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAgentSpawnPreset } from './spawn-preset.mjs';

test('agent route preset carries modelParameters and contextPercent', () => {
  const config = {
    agents: {
      reviewer: {
        provider: 'anthropic-oauth',
        model: 'claude-sonnet-5-5',
        effort: 'low',
        modelParameters: { context: '1m' },
        contextPercent: 40,
      },
    },
  };
  const { preset } = resolveAgentSpawnPreset(config, { agent: 'reviewer' });
  assert.deepEqual(preset.modelParameters, { context: '1m' });
  assert.equal(preset.contextPercent, 40);
});

test('agent route preset omits unset modelParameters and contextPercent', () => {
  const config = { agents: { reviewer: { provider: 'p', model: 'm' } } };
  const { preset } = resolveAgentSpawnPreset(config, { agent: 'reviewer' });
  assert.equal(Object.hasOwn(preset, 'modelParameters'), false);
  assert.equal(Object.hasOwn(preset, 'contextPercent'), false);
});
