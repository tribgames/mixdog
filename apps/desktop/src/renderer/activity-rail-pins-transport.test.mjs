import assert from 'node:assert/strict';
import test from 'node:test';
import { readActivityRailPinsState } from '../shared/activity-rail-pins.ts';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

// Node's version of this test (b6f10295a) read the two calls off a fake relay socket and delivered the pushes to the shim's dispatch, which read
// each with readActivityRailPinsState and fanned out only what it accepted (remote-shim-dispatch.ts:272-275) to `ctx.activityRailPinsListeners`,
// the set `subscribeActivityRailPins` adds to (remote-shim-api.ts:476-478, today :455-457). The table, the router, the set and the reader are
// the product's: the calls reach the adapter that owns their Node names with the parameters Node put in its frames, and the pushes are handed to
// the set as the adapter carrying the event does, with the reader's verdicts asserted on the shared reader. Node's other check there
// (`if (!authenticated) return`, "clear relay hints cannot change pin preferences") has no counterpart: the phone's relay connector opens every
// frame that is not one of the relay's own words as a sealed one (apps/mobile/src/relay-connector.ts `handle`).
test('paired web pins use the request and notification paths', async () => {
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
