// A hidden role (the Maintainer's title/memory agents) dispatches on its own
// saved route: model parameters and context choice size the session it creates.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDispatchPreset } from './agent-dispatch/preset.mjs';
import { prepareDispatchSession } from './agent-dispatch/session-prep.mjs';
import { resolveSessionContextMeta } from '../session/manager/context-meta.mjs';

const PROVIDER = 'acme-test';
const MODEL = 'acme-test-1m';
const SERVED = 1_000_000;
const provider = { name: PROVIDER, getCachedModelInfo: () => ({ contextWindow: SERVED }) };

function dispatchSession(route) {
  const config = {
    default: 'none',
    presets: [],
    agents: { maintainer: { provider: PROVIDER, model: MODEL, ...route } },
  };
  const { preset, presetName, runtimeSpec } = resolveDispatchPreset({ agent: 'title-agent', config });
  let prepared;
  prepareDispatchSession({
    agent: 'title-agent',
    opts: {},
    callCwd: null,
    preset,
    presetName,
    runtimeSpec,
    prepare: (args) => {
      prepared = args;
      return { session: { tools: [] } };
    },
  });
  return {
    preset,
    meta: resolveSessionContextMeta(provider, MODEL, {
      selectedContextWindow: prepared.selectedContextWindow,
      contextPercent: prepared.contextPercent,
      contextTokens: prepared.contextTokens,
    }),
  };
}

test('the maintainer dispatches with its saved whole-window context choice', () => {
  const { meta } = dispatchSession({ contextPercent: 100 });
  assert.equal(meta.contextWindow, SERVED);
  assert.equal(meta.compactBoundaryTokens, SERVED);
});

test('the maintainer dispatches with its saved exact context window', () => {
  const { meta } = dispatchSession({ contextTokens: SERVED });
  assert.equal(meta.contextWindow, SERVED);
});

test('the maintainer dispatches with its saved model parameters', () => {
  const { preset } = dispatchSession({ modelParameters: { daybreak: 'off' } });
  assert.deepEqual(preset.modelParameters, { daybreak: 'off' });
});

test('a maintainer with no context choice keeps the model default window', () => {
  assert.equal(dispatchSession({}).meta.contextWindow, 500_000);
});
