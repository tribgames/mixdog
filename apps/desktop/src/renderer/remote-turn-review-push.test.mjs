// Node's version of this test (b6f10295a) delivered the desktop's `turn-review-changed` push over a fake relay socket to the shim's dispatch,
// which fanned it out to `ctx.turnReviewChangedListeners` (remote-shim-dispatch.ts:288-290) -- the set `subscribeTurnReviewChanged` adds to
// (remote-shim-api.ts:488, today :467). The table and the set are the product's; the push reaches the set through the adapter that carries
// the event, so the test hands it to the set as that adapter does (ctx.fanOut). Node's other check there (`if (!authenticated) return`, "clear
// relay data is ignored") has no counterpart: the phone's relay connector opens every frame that is not one of the relay's own words as a
// sealed one (apps/mobile/src/relay-connector.ts `handle`), so no cleartext event reaches the page.
import assert from 'node:assert/strict';
import test from 'node:test';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

test("a review-changed push reaches the phone's review until it unsubscribes", async () => {
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
