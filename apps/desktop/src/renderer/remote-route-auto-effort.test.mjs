// Per-route Auto reasoning is negotiated: only a host that advertised
// `routeAutoEffort` in its challenge receives the `autoEffort` selection field.
// An older host's selection validator rejects unknown keys, so the shim omits it.
//
// Node's version of this test (b6f10295a) set the flag from the relay challenge and read the four calls off a fake relay socket. Here the
// table (remote-shim-api.ts hostSelection, Node :101-107) and the router are the product's, the flag is the context's `peerRouteAutoEffort`
// (the phone sets it from the core's capabilities each time a connection is ready, apps/mobile/src/phone-boot.ts applyFlags), and what Node
// read off the socket is
// what reached the adapter that owns each name.
import assert from 'node:assert/strict';
import test from 'node:test';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

const selection = { provider: 'anthropic', model: 'opus', effort: 'high', autoEffort: false };

async function sentSelections(routeAutoEffort) {
  const answer = () => null;
  const handlers = { setModelRoute: answer, inheritSession: answer, continueSessionInModel: answer, submitNewTask: answer };
  return withPhoneApi(handlers, async ({ ctx, api, calls }) => {
    ctx.peerRouteAutoEffort = routeAutoEffort;
    const sent = async (pending) => {
      await pending;
      return calls.at(-1);
    };
    const route = await sent(api.setModelRoute(selection, 's1'));
    const inherit = await sent(api.inheritSession('s1', selection, null));
    const resume = await sent(api.continueSessionInModel('s1', selection));
    const draft = await sent(api.submitNewTask('hello', {}, { projectPath: '/p', route: selection }));
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
