import assert from 'node:assert/strict';
import test from 'node:test';
import { TURN_REVIEW_CHANGED_EVENT } from '../shared/turn-review-changed.ts';
import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, withShim } from './remote-shim-test-harness.mjs';

test("a relayed review-changed push reaches the phone's review, authenticated only", async () => {
  await withShim({}, async ({ ctx, dial }) => {
    ctx.turnReviewChangedListeners = new Set();
    const api = createRemoteApi(ctx);
    const leg = await dial({ ready: publishedCeilings(4096, 4096) });
    let rereads = 0;
    const off = api.subscribeTurnReviewChanged(() => (rereads += 1));

    ctx.handleMessage({ event: TURN_REVIEW_CHANGED_EVENT, payload: null }, false);
    assert.equal(rereads, 0, 'clear relay data is ignored');

    await leg.deliver({ event: TURN_REVIEW_CHANGED_EVENT, payload: null });
    assert.equal(rereads, 1);

    off();
    await leg.deliver({ event: TURN_REVIEW_CHANGED_EVENT, payload: null });
    assert.equal(rereads, 1);
  });
});
