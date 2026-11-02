import assert from 'node:assert/strict';
import test from 'node:test';
import { DESKTOP_NOTICE_EVENT } from '../shared/desktop-notice.ts';
import { createRelayPushLanes } from '../main/remote-relay-push-lanes.ts';
import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, withShim } from './remote-shim-test-harness.mjs';

const NOTICE = { key: 'provider-sign-in:anthropic', code: 'provider-sign-in-expired', params: { name: 'Anthropic' } };

test('a service notice is pushed to every paired phone, never droppable', () => {
  const frames = [];
  let publish = () => {};
  const push = createRelayPushLanes({
    clients: new Map([['phone', { lanes: new Set(['state']) }]]),
    subscribeDesktopEvents: (listener) => {
      publish = listener;
      return () => {};
    },
    broadcastEncrypted: (payload, droppable) => frames.push([payload, droppable]),
  });
  try {
    publish({ name: DESKTOP_NOTICE_EVENT, value: NOTICE });
    assert.deepEqual(frames, [[{ event: DESKTOP_NOTICE_EVENT, payload: NOTICE }, false]]);
  } finally {
    push.dispose();
  }
});

test('the phone hands an authenticated notice to the toast region, and ignores a malformed one', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    const api = createRemoteApi(ctx);
    const leg = await dial({ ready: publishedCeilings(4096, 4096) });
    const received = [];
    const unsubscribe = api.subscribeDesktopNotices((notice) => received.push(notice));
    ctx.handleMessage({ event: DESKTOP_NOTICE_EVENT, payload: NOTICE }, false);
    assert.deepEqual(received, [], 'clear relay hints are ignored');
    await leg.deliver({ event: DESKTOP_NOTICE_EVENT, payload: NOTICE });
    await leg.deliver({ event: DESKTOP_NOTICE_EVENT, payload: { key: 'x', code: 'unknown-code' } });
    assert.deepEqual(received, [NOTICE]);
    unsubscribe();
  });
});
