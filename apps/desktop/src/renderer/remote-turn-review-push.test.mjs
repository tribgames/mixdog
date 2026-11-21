import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter as settings } from './remote-protocol-settings.ts';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

test("the core's reviewDiff tell reaches a connected phone's review listeners live, never from a snapshot", async () => {
  await withPhoneApi({}, async ({ ctx, api }) => {
    const subscribers = new Set();
    const store = {
      owed: undefined,
      appFeed: () => undefined,
      section: () => undefined,
      subscribe: (listener) => {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      },
    };
    const client = { store, call: async () => ({}), on: () => () => {} };
    const push = (change) => {
      for (const subscriber of [...subscribers]) subscriber(change);
    };
    const stop = settings.install({
      ctx,
      client: () => client,
      onClient: (wire) => {
        wire(client);
        return () => {};
      },
    });
    let rereads = 0;
    const off = api.subscribeTurnReviewChanged(() => (rereads += 1));

    store.owed = ['reviewDiff'];
    push({ type: 'section', section: 'reviewDiff', key: null });
    store.owed = undefined;
    assert.equal(rereads, 0, 'a snapshot announcing the section is not a tell');

    push({ type: 'section', section: 'reviewDiff', key: null });
    push({ type: 'section', section: 'usage', key: 'day' });
    assert.equal(rereads, 1);

    off();
    push({ type: 'section', section: 'reviewDiff', key: null });
    assert.equal(rereads, 1);
    stop();
  });
});

test('a review-changed listener is called while subscribed and not after it unsubscribes', async () => {
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
