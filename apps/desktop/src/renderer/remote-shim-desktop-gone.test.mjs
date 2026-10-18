import assert from 'node:assert/strict';
import test from 'node:test';

import { acceptRelayE2EEClientHello, createRelayE2EEChallenge } from '../shared/remote-e2ee.ts';
import { publishedCeilings, settle, until, withShim } from './remote-shim-test-harness.mjs';

const notice = (ws, value) => ws.onmessage({ data: JSON.stringify({ resync: value }) });

test('desktop-gone fails the calls in flight, returns their credits and waits on the same socket', async () => {
  await withShim({}, async ({ ctx, dial, identity, resyncs }) => {
    const leg = await dial({ ready: publishedCeilings(4096, 4096) });
    const retired = [];
    const retire = ctx.retireCallCredits;
    ctx.retireCallCredits = (ws) => {
      retired.push(ws);
      retire(ws);
    };
    const call = ctx.invoke('getSnapshot').catch((error) => error);
    await leg.nextPayload();

    notice(leg.ws, 'desktop-gone');
    const failure = await call;
    assert.equal(failure.code, 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED');
    assert.deepEqual(retired, [leg.ws], 'the credits of this leg come back');
    assert.equal(ctx.pending.size, 0);
    assert.equal(ctx.connectionReady, false);
    assert.equal(leg.ws.closeCalls, 0, 'the socket stays parked for the PC');
    assert.equal(document.documentElement.dataset.mixdogRemoteConnection, 'reconnecting');
    assert.equal(document.documentElement.dataset.mixdogRemoteError, undefined, 'no error is recorded');
    assert.equal(resyncs(), 0, 'it is not a resync hint');

    // The relay repeats the notice while the PC stays away: nothing changes.
    notice(leg.ws, 'desktop-gone');
    await settle();
    assert.equal(leg.ws.closeCalls, 0);

    // The PC's next handshake re-keys the parked socket in place.
    const sentBefore = leg.ws.sent.length;
    const challenge = createRelayE2EEChallenge();
    leg.ws.onmessage({ data: JSON.stringify(challenge) });
    await until(() => leg.ws.sent.length === sentBefore + 1, 'the hello for the returning PC');
    const server = await acceptRelayE2EEClientHello(identity, challenge, JSON.parse(leg.ws.sent[sentBefore]));
    leg.ws.onmessage({
      data: await server.encryptJson({ type: 'e2ee-ready', version: 1, ...publishedCeilings(4096, 4096) }),
    });
    await until(() => ctx.connectionReady, 'the re-keyed channel');
    // A new call goes out on the returned PC (after the lanes the reconnect
    // replays), decrypted in wire order.
    const next = ctx.invoke('getSnapshot').catch(() => undefined);
    let cursor = sentBefore + 1;
    let payload = null;
    while (payload?.method !== 'getSnapshot') {
      await until(() => leg.ws.sent.length > cursor, 'a call on the returned PC');
      payload = await server.decryptJson(leg.ws.sent[cursor++]);
    }
    ctx.pending.get(payload.id)?.resolve(null);
    await next;
  });
});

test('an older relay resync hint keeps its meaning', async () => {
  await withShim({}, async ({ ctx, dial, resyncs }) => {
    const leg = await dial();
    notice(leg.ws, 1);
    await settle();
    assert.equal(resyncs(), 1);
    assert.equal(ctx.connectionReady, true);
  });
});
