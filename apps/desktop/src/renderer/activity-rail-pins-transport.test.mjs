// The phone's activity-rail pins: reads and saves reach the host as requests, and a pushed state reaches the page's listeners until it
// unsubscribes. Ported from the Node-socket test onto the phone API rig.
// Not ported: "a clear relay hint cannot change pin preferences" and the unknown-pin frame -- there are no clear relay hints on a protocol
// connection; what a phone hears of the pins is the one global push the core sends after the lane registration, recorded from Node in
// apps/mobile/fixtures/phone-lifecycle/lane-pushes.json ("activity rail pins" -> activity-rail-pins-changed) and replayed by
// remote-shim-lifecycle.slow.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { settle, withPhoneApi } from './test-support/phone-api-rig.mjs';

test('paired web pins use the request path and reach listeners until they unsubscribe', async () => {
  const initial = { pins: ['projects', 'sessions'], revision: 1 };
  const saved = { pins: ['search', 'projects'], revision: 2 };
  const handlers = { readActivityRailPins: () => initial, updateActivityRailPins: () => saved };
  await withPhoneApi(handlers, async ({ ctx, api, calls }) => {
    const received = [];
    const unsubscribe = api.subscribeActivityRailPins((state) => received.push(state));
    assert.deepEqual(await api.readActivityRailPins(), initial);
    assert.deepEqual(await api.updateActivityRailPins(['search', 'projects']), saved);
    await settle();
    assert.deepEqual(calls, [
      { method: 'readActivityRailPins', params: [] },
      { method: 'updateActivityRailPins', params: [['search', 'projects']] },
    ]);
    ctx.fanOut(ctx.activityRailPinsListeners, saved);
    assert.deepEqual(received, [saved]);
    unsubscribe();
    ctx.fanOut(ctx.activityRailPinsListeners, { pins: [], revision: 3 });
    assert.deepEqual(received, [saved]);
  });
});
