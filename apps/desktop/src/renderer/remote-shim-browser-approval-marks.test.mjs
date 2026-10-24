// A paired device learns which sessions have a Browser Use approval waiting on
// the PC — marks only, over the authenticated channel — and still has no way
// to see or answer the approval.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_APPROVAL_SESSIONS_EVENT } from '../shared/browser-approval-sessions.ts';
import { acceptRelayE2EEClientHello, createRelayE2EEChallenge } from '../shared/remote-e2ee.ts';
import { createRemoteApi } from './remote-shim-api.ts';
import { settle, until, withShim } from './remote-shim-test-harness.mjs';

const marks = (sessionIds) => ({ event: BROWSER_APPROVAL_SESSIONS_EVENT, payload: sessionIds });

test('the PC list reaches the phone: a late subscriber gets the baseline, then changes and the clearing', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    const api = createRemoteApi(ctx);
    const leg = await dial();
    // The handshake baseline arrives before the app subscribes.
    await leg.deliver(marks(['sess_home_marketer', 'sess_sub']));
    const seen = [];
    const stop = api.onBrowserApprovalSessions((ids) => seen.push(ids));
    assert.deepEqual(seen, [['sess_home_marketer', 'sess_sub']]);
    await leg.deliver(marks(['sess_home_marketer']));
    await leg.deliver(marks([]));
    assert.deepEqual(seen.slice(1), [['sess_home_marketer'], []]);
    // A malformed list changes nothing.
    await leg.deliver(marks('sess_x'));
    await leg.deliver(marks([42]));
    assert.equal(seen.length, 3);
    stop();
    await leg.deliver(marks(['sess_after']));
    assert.equal(seen.length, 3, 'unsubscribed');
    // Still nothing that shows or answers the approval.
    assert.equal(api.onBrowserApproval, undefined);
    assert.equal(api.browserApprovalDecide, undefined);
  });
});

test('a reconnect baseline replaces marks that ended while the phone was away', async () => {
  await withShim({}, async ({ ctx, dial, identity }) => {
    const api = createRemoteApi(ctx);
    const seen = [];
    api.onBrowserApprovalSessions((ids) => seen.push(ids));
    const leg = await dial();
    await leg.deliver(marks(['sess_a', 'sess_b']));
    // The PC leaves and comes back: its new handshake is followed by its list as it is now.
    leg.ws.onmessage({ data: JSON.stringify({ resync: 'desktop-gone' }) });
    await settle();
    const sentBefore = leg.ws.sent.length;
    const challenge = createRelayE2EEChallenge();
    leg.ws.onmessage({ data: JSON.stringify(challenge) });
    await until(() => leg.ws.sent.length === sentBefore + 1, 'the hello for the returning PC');
    const server = await acceptRelayE2EEClientHello(identity, challenge, JSON.parse(leg.ws.sent[sentBefore]));
    leg.ws.onmessage({ data: await server.encryptJson({ type: 'e2ee-ready', version: 1 }) });
    await until(() => ctx.connectionReady, 'the re-keyed channel');
    leg.ws.onmessage({ data: await server.encryptJson(marks(['sess_b'])) });
    await settle();
    assert.deepEqual(seen.at(-1), ['sess_b']);
  });
});

test('a cleartext (unauthenticated) frame never sets marks', async () => {
  await withShim({ secure: false }, async ({ ctx, dial }) => {
    const api = createRemoteApi(ctx);
    const seen = [];
    api.onBrowserApprovalSessions((ids) => seen.push(ids));
    const leg = await dial();
    await leg.deliver(marks(['sess_spoofed']));
    assert.deepEqual(seen, [[]]);
  });
});
