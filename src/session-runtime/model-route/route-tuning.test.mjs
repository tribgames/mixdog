import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouteTuning } from './route-tuning.mjs';

function tuningFor(route) {
  const state = { route, session: { provider: route.provider, model: route.model }, persisted: [] };
  const tuning = createRouteTuning(
    {
      getConfig: () => ({}),
      getRoute: () => state.route,
      setRouteState: (next) => {
        state.route = next;
      },
      resolveRoute: (_config, next) => next,
      lookupModelMeta: async (provider, id) => ({ provider, id }),
      refreshRouteEffort: async () => {
        state.route = { ...state.route, effectiveEffort: state.route.effort };
      },
    },
    {
      saveRouteModelSettings: () => state.persisted.push('modelSettings'),
      persistAdoptedModelSettings: () => {
        state.persisted.push('config');
        return null;
      },
      // route-persist.mjs applySessionTuning: the session follows the route.
      applySessionTuning() {
        if (state.route.autoEffort === false) state.session.autoEffort = false;
        else delete state.session.autoEffort;
        state.session.effort = state.route.effectiveEffort || null;
      },
    }
  );
  return { state, tuning };
}

test('an explicit effort pick turns the route Auto effort off, so the pick reaches the request', async () => {
  const { state, tuning } = tuningFor({ provider: 'custom-x', model: 'fake-r', effort: 'high' });
  await tuning.setEffort('low');
  assert.equal(state.route.effort, 'low');
  assert.equal(state.route.autoEffort, false);
  assert.equal(state.session.effort, 'low');
  assert.equal(state.session.autoEffort, false);
});

test("a session-only effort changes the session but never the user's saved model settings or config", async () => {
  const { state, tuning } = tuningFor({ provider: 'custom-x', model: 'fake-r', effort: 'high' });
  await tuning.setEffort('max', { sessionOnly: true });
  assert.equal(state.session.effort, 'max');
  assert.equal(state.session.autoEffort, false);
  assert.deepEqual(state.persisted, []);
  // The user's own menu pick still saves them.
  await tuning.setEffort('low');
  assert.deepEqual(state.persisted, ['modelSettings', 'config']);
});

test('clearing the effort (auto) leaves the route Auto flag as it was', async () => {
  const { state, tuning } = tuningFor({ provider: 'custom-x', model: 'fake-r', effort: 'high' });
  await tuning.setEffort('auto');
  assert.equal(state.route.effort, null);
  assert.equal(Object.hasOwn(state.route, 'autoEffort'), false);
});
