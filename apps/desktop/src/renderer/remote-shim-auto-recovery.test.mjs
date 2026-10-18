// The connection recovers on its own in every transient state: the real
// socket state machine and the real reconnect loop, driven over a fake
// WebSocket, with no user input (no tap, no wake event the user would cause).
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  relayE2EEPairingMaterial,
} from '../shared/remote-e2ee.ts';
import { createRelayClientLifecycle } from '../main/remote-relay-client-lifecycle.ts';
import { createRelayClientRegistry } from '../main/remote-relay-clients.ts';
import { isInvalidRemotePairingClose } from './remote-pairing-recovery.ts';
import { FakeSocket, publishedCeilings, settle, until, withShim } from './remote-shim-test-harness.mjs';

/** The REAL desktop side of a browser leg (registry + lifecycle) for the
 *  replacement PC leg, wired to a phone socket by hand like the relay would. */
function replacementPc(identity, ws) {
  const envelopes = [];
  const clients = createRelayClientRegistry({
    host: { setVisibleSessionsForSource: async () => true },
    sendEnvelope: (payload) => envelopes.push(payload),
    frameBudgetBytes: 1 << 20,
    onClientCountChanged: () => {},
    onEmpty: () => {},
  });
  const lifecycle = createRelayClientLifecycle({
    clients,
    e2eeIdentity: identity,
    pairing: relayE2EEPairingMaterial(identity),
    relayBinaryFrames: () => true,
    viewSyncSupported: () => false,
    relayRoutingCapsPayload: () => ({}),
    sendEnvelope: (payload) => envelopes.push(payload),
    // The phone receives the ready on its socket, encrypted for this leg.
    sendEncryptedFrame: async (clientId, payload) => {
      ws.onmessage({ data: await clients.get(clientId).channel.encryptJson(payload) });
    },
    dispatchClientCall: async () => ({}),
    resyncClient: () => {},
  });
  return {
    envelopes,
    open: () => lifecycle.open('route-1', 'c'.repeat(32)),
    receive: (frame) => lifecycle.receive('route-1', clients.get('route-1'), frame),
    challenge: () => envelopes.find((entry) => entry.type === 'frame')?.data,
    closes: () => envelopes.filter((entry) => entry.type === 'close-client'),
  };
}

for (const binaryFrames of [false, true]) {
  test(`ciphertext in flight across a PC redial (${binaryFrames ? 'binary' : 'text'}) never costs the pairing`, async (t) => {
    // The page origin: the real PC's ready names the PC and offers the media
    // lane, and the shim keys both by the origin it was served from.
    globalThis.location = new URL('https://relay.test/');
    t.after(() => {
      delete globalThis.location;
    });
    await withShim({}, async ({ ctx, dial, identity }) => {
      let pairingResets = 0;
      ctx.resetApprovalAndAsk = () => {
        pairingResets += 1;
      };
      const leg = await dial({ binaryFrames, ready: publishedCeilings(4096, 4096) });
      const ws = leg.ws;
      // An RPC leaves the phone on the old leg's channel...
      const call = ctx.invoke('abortSession', ['s1']).catch((error) => error);
      await until(() => ws.sent.length >= 2, 'the in-flight call');
      const inFlight = ws.sent.at(-1);
      assert.equal(typeof inFlight === 'string', !binaryFrames, 'the wire form under test');
      // ...and the PC redials before it lands: the relay keeps the phone's
      // socket, the replacement leg opens the client, and the stale frame
      // reaches it ahead of the phone's new hello.
      const pc = replacementPc(identity, ws);
      pc.open();
      pc.receive(inFlight);
      await settle();
      assert.deepEqual(pc.closes(), [], 'pre-handshake ciphertext is dropped, not answered with a close');

      // The new challenge reaches the phone; its hello completes the leg.
      const sentBefore = ws.sent.length;
      ws.onmessage({ data: pc.challenge() });
      await until(() => ws.sent.length === sentBefore + 1, 'the hello for the replacement leg');
      pc.receive(ws.sent.at(-1));
      await until(() => ctx.connectionReady, 'the rekeyed connection');
      assert.equal((await call).code, 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED', 'the stale call fails as transient');
      assert.deepEqual(pc.closes(), []);
      assert.equal(ws.closeCalls, 0, 'the phone kept its socket');
      assert.equal(pairingResets, 0, 'the pairing is never wiped');
      // An older PC still answers such frames with "handshake required": the
      // phone treats that as transient, never as an invalid pairing.
      assert.equal(isInvalidRemotePairingClose({ code: 4004, reason: 'relay encryption handshake required' }), false);
    });
  });
}

test('every transient state keeps reconnecting by itself, with bounded backoff, and never asks the user', async () => {
  await withShim({}, async ({ ctx, timers, identity }) => {
    const listeners = new Map();
    const listen = (scope) => (type, listener) => {
      const key = `${scope}:${type}`;
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key).push(listener);
    };
    window.addEventListener = listen('window');
    window.setInterval = () => 0;
    document.addEventListener = listen('document');
    // The shim state's own initial values for the liveness fields.
    Object.assign(ctx, { reconnectTimer: null, wakePongTimer: null, backgroundGraceTimer: null, heartbeatSentAt: 0 });
    const { installRemoteLiveness } = await import('./remote-shim-liveness.ts');
    installRemoteLiveness(ctx);
    let pairingResets = 0;
    ctx.resetApprovalAndAsk = () => {
      pairingResets += 1;
    };

    const attempts = () => FakeSocket.instances.length;
    const nextSocket = async (before) => {
      await until(() => attempts() === before + 1, 'a new socket attempt');
      return FakeSocket.instances[before];
    };
    /** The retry the loop armed on its own: bounded, then fired by the clock. */
    const delays = [];
    const runArmedRetry = async ({ fleet = false } = {}) => {
      const id = ctx.reconnectTimer;
      assert.notEqual(id, null, 'a retry is armed without any user input');
      const timer = timers.live.get(id);
      // The first retry of an outage leaves at once — spread over 1.5 s when
      // the relay closed a live leg — and every later one is inside the
      // jittered [500 ms, 10 s] backoff.
      assert.ok(timer.ms >= 0 && timer.ms <= 10_000, `retry delay ${timer.ms} within bounds`);
      if (fleet) assert.ok(timer.ms <= 1_500, `first retry ${timer.ms} after a relay close is only spread`);
      else if (timer.ms !== 0) assert.ok(timer.ms >= 500, `retry delay ${timer.ms} keeps the floor`);
      delays.push(timer.ms);
      const before = attempts();
      timers.live.delete(id);
      timer.fn();
      return nextSocket(before);
    };
    const open = (ws) => {
      ws.readyState = FakeSocket.OPEN;
      ws.onopen();
    };
    const close = (ws, code) => {
      ws.readyState = FakeSocket.CLOSED;
      ws.onclose({ code, reason: '' });
    };

    // Boot: the first attempt.
    let before = attempts();
    ctx.connect().catch(() => {});
    let ws = await nextSocket(before);

    // 1. PC offline or asleep: the relay answers with its own close, again and
    //    again; the loop keeps dialing with a growing but capped delay.
    for (let round = 0; round < 8; round++) {
      open(ws);
      close(ws, 4002);
      ws = await runArmedRetry();
    }
    assert.ok(
      delays.slice(-3).every((delay) => delay >= 5_000 && delay <= 10_000),
      `the backoff caps: ${delays}`
    );

    // 2. No internet: attempts fail before they ever open.
    for (let round = 0; round < 3; round++) {
      ws.onerror();
      close(ws, 1006);
      ws = await runArmedRetry();
    }

    // 3. A half-dead PC: the socket opens and no challenge ever comes. The
    //    phone's own handshake timer ends the attempt and the loop redials.
    open(ws);
    const handshakeTimer = [...timers.live.entries()].filter(([, timer]) => timer.ms === 10_000).at(-1);
    assert.ok(handshakeTimer, 'the handshake is bounded');
    timers.live.delete(handshakeTimer[0]);
    handshakeTimer[1].fn();
    ws = await runArmedRetry();

    // 4. A relay restart: a working connection drops; the next retry starts
    //    from the bottom of the backoff again.
    open(ws);
    const challenge = createRelayE2EEChallenge();
    ws.onmessage({ data: JSON.stringify(challenge) });
    await until(() => ws.sent.length === 1, 'the hello');
    const server = await acceptRelayE2EEClientHello(identity, challenge, JSON.parse(ws.sent[0]));
    ws.onmessage({ data: await server.encryptJson({ type: 'e2ee-ready', version: 1 }) });
    await until(() => ctx.connectionReady, 'a ready connection');
    close(ws, 1012);
    ws = await runArmedRetry({ fleet: true });
    assert.ok(delays.at(-1) <= 1_500, 'a connection that worked resets the backoff');

    // 5. The phone sleeps and its network drops while hidden: nothing dials
    //    in the background, and the network coming back resumes on its own.
    document.visibilityState = 'hidden';
    close(ws, 1006);
    assert.equal(ctx.reconnectTimer, null, 'a hidden page does not dial');
    document.visibilityState = 'visible';
    before = attempts();
    for (const listener of listeners.get('window:online') ?? []) listener(new Event('online'));
    ws = await nextSocket(before);
    assert.ok(ws, 'the returning network redials with no tap');

    assert.equal(pairingResets, 0, 'no transient state ever falls back to the pairing screen');
  });
});
