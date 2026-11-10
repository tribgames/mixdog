import assert from 'node:assert/strict';
import test from 'node:test';
import { DESKTOP_NOTICE_EVENT, readDesktopNotice } from '../shared/desktop-notice.ts';
import { createRelayPushLanes } from '../main/remote-relay-push-lanes.ts';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

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

// Node's version of this test (b6f10295a) delivered the notice over a fake relay socket to the shim's dispatch, which read it with
// readDesktopNotice and fanned out only what that reader accepted (remote-shim-dispatch.ts:280-283) to `ctx.desktopNoticeListeners`, the set
// `subscribeDesktopNotices` adds to (remote-shim-api.ts:481, today :460). What is held here is two separate things: the shared reader's
// verdicts (a notice is read whole, a malformed one is null), and the subscription (a listener added through the product's API is in that set;
// the test's `ctx.fanOut` stands where a delivery would be). The delivery Node's test held, a pushed notice read by that reader and only then
// fanned out, is NOT held: no phone adapter and no core notification carries the notice today, so against the Rust core these notices never
// reach a phone. Node's other check there (`if (!authenticated) return`, "clear relay hints are ignored") has no counterpart: the phone's relay
// connector opens every frame that is not one of the relay's own words as a sealed one (apps/mobile/src/relay-connector.ts `handle`).
test('the notice reader accepts a notice and refuses a malformed one, and a notice listener is called while subscribed (delivery is not covered)', async () => {
  await withPhoneApi({}, async ({ ctx, api }) => {
    const received = [];
    const unsubscribe = api.subscribeDesktopNotices((notice) => received.push(notice));
    assert.deepEqual(readDesktopNotice(NOTICE), NOTICE);
    assert.equal(readDesktopNotice({ key: 'x', code: 'unknown-code' }), null);
    ctx.fanOut(ctx.desktopNoticeListeners, NOTICE);
    assert.deepEqual(received, [NOTICE]);
    unsubscribe();
  });
});
