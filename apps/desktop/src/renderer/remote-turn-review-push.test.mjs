// Node's version of this test (b6f10295a) delivered the desktop's `turn-review-changed` push over a fake relay socket to the shim's dispatch,
// which fanned it out to `ctx.turnReviewChangedListeners` (remote-shim-dispatch.ts:288-290) -- the set `subscribeTurnReviewChanged` adds to
// (remote-shim-api.ts:488, today :467). What is held here is the subscription only: a listener added through the product's API is in that set
// and leaves it on unsubscribe (the test's `ctx.fanOut` stands where a delivery would be). The delivery Node's test held is NOT held: no phone
// adapter and no core notification carries this push today, so against the Rust core a phone's review does not refresh when the PC's changes.
// Node's other check there (`if (!authenticated) return`, "clear relay data is ignored") has no counterpart: the phone's relay connector opens
// every frame that is not one of the relay's own words as a sealed one (apps/mobile/src/relay-connector.ts `handle`).
import assert from 'node:assert/strict';
import test from 'node:test';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

test("a review-changed listener is called while subscribed and not after it unsubscribes (delivery to it is not covered)", async () => {
  await withPhoneApi({}, async ({ ctx, api }) => {
    let rereads = 0;
    const off = api.subscribeTurnReviewChanged(() => (rereads += 1));

    ctx.fanOut(ctx.turnReviewChangedListeners, undefined);
    assert.equal(rereads, 1);

    off();
    ctx.fanOut(ctx.turnReviewChangedListeners, undefined);
    assert.equal(rereads, 1);
  });
});
