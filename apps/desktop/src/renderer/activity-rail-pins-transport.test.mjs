import assert from 'node:assert/strict';
import test from 'node:test';
import { readActivityRailPinsState } from '../shared/activity-rail-pins.ts';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

test("paired web pins: the two calls go out under Node's names and parameters; a pins listener is called while subscribed (delivery is not covered)", async () => {
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
