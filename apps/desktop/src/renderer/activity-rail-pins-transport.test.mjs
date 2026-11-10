import assert from 'node:assert/strict';
import test from 'node:test';
import { readActivityRailPinsState } from '../shared/activity-rail-pins.ts';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

// Node's version of this test (b6f10295a) read the two calls off a fake relay socket and delivered the pushes to the shim's dispatch, which read
// each with readActivityRailPinsState and fanned out only what it accepted (remote-shim-dispatch.ts:272-275) to `ctx.activityRailPinsListeners`,
// the set `subscribeActivityRailPins` adds to (remote-shim-api.ts:476-478, today :455-457). The table, the router, the set and the reader are
// the product's: the calls reach the adapter that owns their Node names with the parameters Node put in its frames (here the test's own
// handlers: no phone adapter claims the two names today, and the core has no method for them). For the pushes only the subscription and the
// shared reader's verdicts are held (the test's `ctx.fanOut` stands where a delivery would be); the delivery Node's test held, a pushed state
// read by that reader and only then fanned out, is NOT held: nothing carries the push today. Node's other check there
// (`if (!authenticated) return`, "clear relay hints cannot change pin preferences") has no counterpart: the phone's relay connector opens every
// frame that is not one of the relay's own words as a sealed one (apps/mobile/src/relay-connector.ts `handle`).
test('paired web pins: the two calls go out under Node\'s names and parameters; a pins listener is called while subscribed (delivery is not covered)', async () => {
  const initial = { pins: ['projects', 'sessions'], revision: 1 };
  const saved = { pins: ['search', 'projects'], revision: 2 };
  const handlers = { readActivityRailPins: () => initial, updateActivityRailPins: () => saved };
  await withPhoneApi(handlers, async ({ ctx, api, calls }) => {
    const received = [];
    const unsubscribe = api.subscribeActivityRailPins((state) => received.push(state));
    assert.deepEqual(await api.readActivityRailPins(), initial);
    assert.equal(calls.at(-1).method, 'readActivityRailPins');
    assert.deepEqual(await api.updateActivityRailPins(['search', 'projects']), saved);
    assert.equal(calls.at(-1).method, 'updateActivityRailPins');
    assert.deepEqual(calls.at(-1).params, [['search', 'projects']]);
    assert.deepEqual(readActivityRailPinsState(saved), saved);
    ctx.fanOut(ctx.activityRailPinsListeners, saved);
    assert.deepEqual(received, [saved]);
    assert.equal(readActivityRailPinsState({ pins: ['unknown'], revision: 3 }), null);
    unsubscribe();
    ctx.fanOut(ctx.activityRailPinsListeners, { pins: [], revision: 3 });
    assert.deepEqual(received, [saved]);
  });
});
