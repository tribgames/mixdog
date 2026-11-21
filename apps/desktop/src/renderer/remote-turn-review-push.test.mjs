import assert from 'node:assert/strict';
import test from 'node:test';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

test('a review-changed listener is called while subscribed and not after it unsubscribes (delivery to it is not covered)', async () => {
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
