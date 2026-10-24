import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, withShim } from './remote-shim-test-harness.mjs';

const nextCall = async (leg, method) => {
  let frame = await leg.nextPayload();
  while (frame.method !== method) frame = await leg.nextPayload();
  return frame;
};

test('a remote page reports the sessions it paints apart from its delivery subscription', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    ctx.updaterListeners = new Set();
    ctx.settingsChangedListeners = new Set();
    const api = createRemoteApi(ctx);
    const leg = await dial({ remoteParity: true, ready: publishedCeilings(4096, 4096) });
    api.reportScreenSessions(['a']);
    assert.deepEqual((await nextCall(leg, 'setScreenSessions')).params, [['a']]);
    assert.deepEqual(ctx.lastScreenSessionIds, ['a'], 'kept for the next leg');
  });
});
