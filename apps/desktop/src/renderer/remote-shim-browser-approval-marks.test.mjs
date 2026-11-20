// A paired device learns which sessions have a Browser Use approval waiting on the PC -- marks only -- and still has no way to see or answer
// the approval. Node's version (b6f10295a) also replayed the marks' delivery over the encrypted socket: the baseline after a re-key and the
// refusal of a cleartext frame. Both belong to the connection, which the phone no longer builds from frames; the cleartext/authenticated rule
// is replayed by apps/mobile/src/phone-client.test.ts. What the page keeps is the
// subscription: the current list at once, then each change until the listener leaves.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter as browser } from './remote-protocol-browser.ts';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

test('a late subscriber gets the PC list at once, then changes and the clearing', async () => {
  await withPhoneApi({}, async ({ ctx, api }) => {
    const sections = new Map([['browserApprovalSessions', ['sess_sub', 'sess_home_marketer']]]);
    let fold;
    const client = {
      store: {
        appFeed: () => ({ id: 'app', epoch: 'e1', seq: 1 }),
        section: (_section, key) => (sections.has(key) ? { value: sections.get(key) } : undefined),
        subscribe: (listener) => ((fold = listener), () => {}),
      },
      on: () => () => {},
    };
    const detach = browser.install({ ctx, onClient: (wire) => (wire(client), () => {}) });
    const update = (key, ids) => {
      sections.set(key, ids);
      fold({ type: 'section', section: 'hostState', key });
    };
    const seen = [];
    const stop = api.onBrowserApprovalSessions((ids) => seen.push(ids));
    assert.deepEqual(seen, [['sess_home_marketer', 'sess_sub']]);
    // A long inline list still gets through; a stub for one source cannot hold the other source's clear.
    const desktop = Array.from({ length: 201 }, (_, i) => `desktop_${i}`);
    update('browserDialogApprovalSessions', desktop);
    update('browserDialogApprovalSessions', null);
    update('browserApprovalSessions', []);
    update('browserApprovalSessions', ['sess_sub']);
    update('browserApprovalSessions', null);
    update('browserDialogApprovalSessions', []);
    update('browserApprovalSessions', []);
    assert.deepEqual(seen.slice(1), [
      [...desktop, 'sess_home_marketer', 'sess_sub'].sort(),
      [...desktop].sort(),
      [...desktop, 'sess_sub'].sort(),
      ['sess_sub'],
      [],
    ]);
    stop();
    update('browserDialogApprovalSessions', ['sess_after']);
    assert.equal(seen.length, 6, 'unsubscribed');
    detach();
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
