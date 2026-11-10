// Main's saved settings for a model (config.modelSettings) belong to the Main
// route alone: a sub-agent's route never takes its effort, Fast, Auto effort,
// model parameters or context share from them.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveInitialConfigState } from './config-lifecycle.mjs';
import { makeResolveRoute } from '../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';

const config = {
  default: 'none',
  presets: [],
  modelSettings: {
    'demo/model': {
      effort: 'low',
      fast: true,
      autoEffort: false,
      modelParameters: { daybreak: 'on' },
      contextPercent: 30,
    },
  },
};

function boot(options) {
  return resolveInitialConfigState({
    initialConfig: config,
    resolveRoute: makeResolveRoute(() => 'demo'),
    provider: 'demo',
    model: 'model',
    ...options,
  }).route;
}

test('Main keeps its saved settings for the model', () => {
  const route = boot({ agentOwned: false });
  assert.equal(route.effort, 'low');
  assert.equal(route.fast, true);
  assert.equal(route.autoEffort, false);
  assert.deepEqual(route.modelParameters, { daybreak: 'on' });
  assert.equal(route.contextPercent, 30);
});

test("an agent with no values of its own does not take Main's saved effort", () => {
  assert.equal(boot({ agentOwned: true }).effort ?? null, null);
});

test("an agent with no values of its own does not take Main's saved Fast", () => {
  assert.equal(boot({ agentOwned: true }).fast, false);
});

test("an agent with no values of its own does not take Main's saved model parameters", () => {
  assert.deepEqual(boot({ agentOwned: true }).modelParameters, {});
});

test("an agent's Auto effort stays Auto: Main's Auto-off does not turn it off", () => {
  assert.equal(boot({ agentOwned: true }).autoEffort, true);
  assert.equal(boot({ agentOwned: true, autoEffort: true }).autoEffort, true);
  assert.equal(boot({ agentOwned: true, autoEffort: false }).autoEffort, false);
});

test("an agent's own values win and Main's context share does not apply", () => {
  const route = boot({
    agentOwned: true,
    effort: 'high',
    fast: false,
    modelParameters: { daybreak: 'off' },
  });
  assert.equal(route.effort, 'high');
  assert.equal(route.fast, false);
  assert.deepEqual(route.modelParameters, { daybreak: 'off' });
  assert.equal(route.contextPercent, undefined);
});
