// Per-route Auto reasoning is negotiated: only a host that advertised `routeAutoEffort` receives the `autoEffort` selection field. An older
// host's selection validator rejects unknown keys, so the page omits it. Ported from the Node-socket test onto the phone API rig; the
// selections now reach the adapter instead of a socket frame, with the same shapes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { settle, withPhoneApi } from './test-support/phone-api-rig.mjs';

const selection = { provider: 'anthropic', model: 'opus', effort: 'high', autoEffort: false };

async function sentSelections(routeAutoEffort) {
  const handlers = { setModelRoute: () => null, inheritSession: () => null, continueSessionInModel: () => null, submitNewTask: () => null };
  return withPhoneApi(handlers, async ({ ctx, api, calls }) => {
    ctx.peerRouteAutoEffort = routeAutoEffort;
    await api.setModelRoute(selection, 's1');
    await api.inheritSession('s1', selection, null);
    await api.continueSessionInModel('s1', selection);
    await api.submitNewTask('hello', {}, { projectPath: '/p', route: selection });
    await settle();
    const [route, inherit, resume, draft] = calls;
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
