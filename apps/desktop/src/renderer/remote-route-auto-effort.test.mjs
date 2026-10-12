// Per-route Auto reasoning is negotiated: only a host that advertised
// `routeAutoEffort` in its challenge receives the `autoEffort` selection field.
// An older host's selection validator rejects unknown keys, so the shim omits it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, withShim } from './remote-shim-test-harness.mjs';

const selection = { provider: 'anthropic', model: 'opus', effort: 'high', autoEffort: false };

async function sentSelections(routeAutoEffort) {
  return withShim({}, async ({ ctx, dial }) => {
    const api = createRemoteApi(ctx);
    const leg = await dial({ routeAutoEffort, ready: publishedCeilings(4096, 4096) });
    const answer = async (pending) => {
      const frame = await leg.nextPayload();
      await leg.deliver({ id: frame.id, ok: true, value: null });
      await pending;
      return frame;
    };
    const route = await answer(api.setModelRoute(selection, 's1'));
    const inherit = await answer(api.inheritSession('s1', selection, null));
    const resume = await answer(api.continueSessionInModel('s1', selection));
    const draft = await answer(api.submitNewTask('hello', {}, { projectPath: '/p', route: selection }));
    return {
      advertised: api.routeAutoEffort,
      selections: [route.params[0], inherit.params[1], resume.params[1], draft.params[2].route],
      draft: draft.params[2],
    };
  });
}

test('a host without routeAutoEffort never receives the autoEffort field', async () => {
  const { advertised, selections, draft } = await sentSelections(false);
  assert.equal(advertised, false);
  for (const sent of selections) {
    assert.equal(Object.hasOwn(sent, 'autoEffort'), false);
    assert.deepEqual({ ...sent }, { provider: 'anthropic', model: 'opus', effort: 'high' });
  }
  assert.equal(draft.projectPath, '/p', 'the rest of the draft is untouched');
});

test('a host advertising routeAutoEffort receives the route flag as given', async () => {
  const { advertised, selections } = await sentSelections(true);
  assert.equal(advertised, true);
  for (const sent of selections) assert.equal(sent.autoEffort, false);
});
