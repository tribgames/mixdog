// Per-route Auto reasoning is negotiated: only a host that advertised
// `routeAutoEffort` in its challenge receives the `autoEffort` selection field.
// An older host's selection validator rejects unknown keys, so the shim omits it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

const selection = { provider: 'anthropic', model: 'opus', effort: 'high', effortAuto: false };

async function sentSelections(routeAutoEffort, routeEffortAuto = false) {
  const answer = () => null;
  const handlers = {
    setModelRoute: answer,
    inheritSession: answer,
    continueSessionInModel: answer,
    submitNewTask: answer,
  };
  return withPhoneApi(handlers, async ({ ctx, api, calls }) => {
    ctx.peerRouteAutoEffort = routeAutoEffort;
    ctx.peerRouteEffortAuto = routeEffortAuto;
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

test('a host without routeAutoEffort never receives effortAuto or autoEffort', async () => {
  const { advertised, selections, draft } = await sentSelections(false);
  assert.equal(advertised, false);
  for (const sent of selections) {
    assert.equal(Object.hasOwn(sent, 'effortAuto'), false);
    assert.equal(Object.hasOwn(sent, 'autoEffort'), false);
    assert.deepEqual({ ...sent }, { provider: 'anthropic', model: 'opus', effort: 'high' });
  }
  assert.equal(draft.projectPath, '/p', 'the rest of the draft is untouched');
});

test('a host advertising only routeAutoEffort receives the choice under the older autoEffort key', async () => {
  const { selections } = await sentSelections(true);
  for (const sent of selections) {
    assert.deepEqual({ ...sent }, { provider: 'anthropic', model: 'opus', effort: 'high', autoEffort: false });
  }
});

test('fallback entries and capability requests get the older key too', async () => {
  const answer = () => null;
  await withPhoneApi({ setModelRoute: answer, invokeCapability: answer }, async ({ ctx, api, calls }) => {
    ctx.peerRouteAutoEffort = true;
    ctx.peerRouteEffortAuto = false;
    await api.setModelRoute({ ...selection, fallbacks: [{ provider: 'openai', model: 'gpt', effortAuto: true }] }, 's1');
    assert.deepEqual(calls.at(-1).params[0].fallbacks, [{ provider: 'openai', model: 'gpt', autoEffort: true }]);
    await api.invokeCapability({ capability: 'setRoute', route: selection });
    assert.deepEqual(calls.at(-1).params[0], {
      capability: 'setRoute',
      route: { provider: 'anthropic', model: 'opus', effort: 'high', autoEffort: false },
    });
  });
});

test('a host advertising routeEffortAuto receives the route flag as given', async () => {
  const { selections } = await sentSelections(true, true);
  for (const sent of selections) assert.equal(sent.effortAuto, false);
});
