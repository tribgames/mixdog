// A paired device learns which sessions have a Browser Use approval waiting on the PC -- marks only -- and still has no way to see or answer
// the approval. Node's version (b6f10295a) also replayed the marks' delivery over the encrypted socket: the baseline after a re-key and the
// refusal of a cleartext frame. Both belong to the connection, which the phone no longer builds from frames; the cleartext/authenticated rule
// is replayed by apps/mobile/src/phone-client.test.ts and the reconnect by remote-shim-lifecycle.slow.test.mjs. What the page keeps is the
// subscription: the current list at once, then each change until the listener leaves.
import assert from 'node:assert/strict';
import test from 'node:test';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

test('a late subscriber gets the PC list at once, then changes and the clearing', async () => {
  await withPhoneApi({}, async ({ ctx, api }) => {
    ctx.browserApprovalSessionIds = ['sess_home_marketer', 'sess_sub'];
    const seen = [];
    const stop = api.onBrowserApprovalSessions((ids) => seen.push(ids));
    assert.deepEqual(seen, [['sess_home_marketer', 'sess_sub']]);
    ctx.fanOut(ctx.browserApprovalSessionListeners, ['sess_home_marketer']);
    ctx.fanOut(ctx.browserApprovalSessionListeners, []);
    assert.deepEqual(seen.slice(1), [['sess_home_marketer'], []]);
    stop();
    ctx.fanOut(ctx.browserApprovalSessionListeners, ['sess_after']);
    assert.equal(seen.length, 3, 'unsubscribed');
    // Still nothing that shows or answers the approval.
    assert.equal(api.onBrowserApproval, undefined);
    assert.equal(api.browserApprovalDecide, undefined);
  });
});

test('a page with no list yet starts from none', async () => {
  await withPhoneApi({}, async ({ api }) => {
    const seen = [];
    api.onBrowserApprovalSessions((ids) => seen.push(ids));
    assert.deepEqual(seen, [[]]);
  });
});
