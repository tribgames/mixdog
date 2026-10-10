import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

mock.module('../../../runtime/agent/orchestrator/agent-runtime/session-builder.mjs', {
  namedExports: {
    prepareAgentSession: (spec) => ({ session: { id: 'local', spec }, effectiveCwd: null }),
  },
});
mock.module('../../route-state.mjs', {
  namedExports: {
    resolveRouteContextState: (route) => ({
      contextPercent: route.contextPercent,
      selectedContextWindow: route.contextPercent * 1000,
    }),
  },
});

const { createSpawnPreparer } = await import('./spawn-flow/spawn-prep.mjs');

function preparer(sessionSurface) {
  return createSpawnPreparer({
    cfgMod: {},
    ensureProvider: async () => {},
    sessionSurface,
  });
}

test('spawned agent session receives contextPercent, selectedContextWindow and modelParameters', async () => {
  const preset = { provider: 'p', model: 'm', modelParameters: { context: '1m' }, contextPercent: 40 };
  const plan = { config: {}, preset, prompt: 'x', tag: 't' };
  const spec = { preset };
  const expected = { preset, contextPercent: 40, selectedContextWindow: 40000 };

  // createSpawnedSession is internal; reach it through the exported preparer's
  // sessionSurface/local branches.
  const created = [];
  const surface = { canonical: true, createChild: async (args) => (created.push(args), { session: {} }) };
  await preparer(surface).createSpawnedSession(plan, spec, null);
  assert.deepEqual(created[0].spec, expected);

  const local = await preparer(null).createSpawnedSession(plan, spec, null);
  assert.deepEqual(local.session.spec, expected);
  assert.deepEqual(local.session.spec.preset.modelParameters, { context: '1m' });

  const plain = await preparer(null).createSpawnedSession({ ...plan, preset: { provider: 'p', model: 'm' } }, { preset: {} }, null);
  assert.equal(Object.hasOwn(plain.session.spec, 'contextPercent'), false);
});
