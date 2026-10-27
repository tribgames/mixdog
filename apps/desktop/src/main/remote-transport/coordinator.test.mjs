// Stage 1A (docs/remote-transport.md §9): the desktop coordinator against a
// real E2EE client channel, a fake relay carrier and a fake peer host.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

import {
  RELAY_E2EE_RELAY_LANE,
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  createRelayE2EEClientHandshake,
  generateRelayE2EEServerIdentity,
  relayE2EEPairingMaterial,
} from '../../shared/remote-e2ee.ts';
import {
  REMOTE_TRANSPORT_BUFFER_HIGH_BYTES,
  REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES,
  REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES,
  REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS,
  RemoteTransportAssemblyPool,
  RemoteTransportMessageAssembler,
  RemoteTransportReceiver,
  RemoteTransportSender,
  decodeRemoteTransportMessage,
  encodeRemoteTransportControl,
  encodeRemoteTransportRecord,
  readRemoteTransportControl,
  remoteTransportAck,
  remoteTransportPing,
  splitRemoteTransportPayload,
} from '../../shared/remote-transport.ts';
import {
  RemoteTransportEndedError,
  RemoteTransportOversizeError,
  createRemoteTransportCoordinator,
  createRemoteTransportPeerHost,
} from './coordinator.ts';
import { createRemoteTransportPeerEndpoint, createRemoteTransportPeerService } from './peer-link.ts';
import { createRelayEncryptedDelivery } from '../remote-relay-delivery.ts';
import { legShowsSession } from './foreground.ts';
import { decodeRelayBinaryFrame } from '../../../../relay/lib/relay-binary-frame.mjs';

const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(':');
const SDP = `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:sha-256 ${FINGERPRINT}\r\n`;
const FINGERPRINTS = [{ algorithm: 'sha-256', value: FINGERPRINT }];
const ICE = [{ urls: ['turn:turn.example.org:3478'], username: 'user-secret-name', credential: 'credential-secret' }];

/** One wait of a polling loop: event-loop turns first, then real time, so a
 *  loaded machine (WebCrypto on the thread pool) does not run it out. */
const settle = (i) => new Promise((resolve) => (i < 200 ? setImmediate(resolve) : setTimeout(resolve, 1)));

const until = async (condition, what = 'condition') => {
  for (let i = 0; i < 5_000; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => (i < 200 ? setImmediate(resolve) : setTimeout(resolve, 1)));
  }
  assert.fail(`${what} never became true`);
};

async function channels() {
  const identity = await generateRelayE2EEServerIdentity();
  const pairing = relayE2EEPairingMaterial(identity);
  const challenge = { ...createRelayE2EEChallenge(), binaryFrames: 1, transportWebrtc: 1 };
  const { hello, channel: phoneChannel } = await createRelayE2EEClientHandshake(pairing, challenge, {
    transportWebrtc: true,
  });
  const desktopChannel = await acceptRelayE2EEClientHello(identity, challenge, hello);
  assert.equal(desktopChannel.transportEnabled, true);
  return { challenge, desktopChannel, phoneChannel };
}

/** The client end, built from the shared stream cores (what stage 1C runs). */
function createPhone(channel, clock) {
  const receiver = new RemoteTransportReceiver();
  const sender = new RemoteTransportSender();
  const assembler = new RemoteTransportMessageAssembler(new RemoteTransportAssemblyPool());
  const messages = [];
  const controls = [];
  let confirmed = false;
  const drain = async () => {
    for (let next = receiver.next(); next; next = receiver.next()) {
      const value = await channel.decryptJson(next.box);
      if (!confirmed) {
        channel.confirmHandshake(value);
        confirmed = true;
      }
      receiver.commit(next.sequence, clock.t);
      const result = assembler.accept(value, clock.t);
      if (result.state === 'complete') messages.push(result.payload);
    }
  };
  return {
    receiver,
    sender,
    messages,
    controls,
    /** Takes carrier messages from the desktop, as delivered on `lane`. */
    /** The client registers the lane of a connection it answers. */
    register(lane) {
      channel.registerControlLane(lane);
    },
    async ingest(raws, lane = RELAY_E2EE_RELAY_LANE) {
      for (const raw of raws) {
        const message = decodeRemoteTransportMessage(raw);
        if (message.kind === 'control') {
          const control = readRemoteTransportControl(await channel.openControl(message.box, lane), 'desktop');
          if (!control) continue;
          controls.push({ lane, control });
          if (control.t === 'ack') sender.acknowledge(control, clock.t);
          if (control.t === 'repair') sender.repair(control);
        } else {
          receiver.accept(message, clock.t);
        }
      }
      await drain();
    },
    /** One application message as carrier messages (sealed and retained). */
    async record(payload) {
      const box = await channel.encryptBinary(payload);
      sender.push(box);
      sender.markSent(sender.nextSequence() - 1, 'relay', clock.t);
      return encodeRemoteTransportRecord(box);
    },
    /** Retained records the desktop asked for again. */
    resend() {
      const out = [];
      for (const { sequence, box } of sender.due(clock.t)) {
        out.push(...encodeRemoteTransportRecord(box));
        sender.markSent(sequence, 'relay', clock.t);
      }
      return out;
    },
    async control(message, lane = RELAY_E2EE_RELAY_LANE) {
      return encodeRemoteTransportControl(await channel.sealControl(message, lane));
    },
  };
}

function fakePeerHost() {
  const peers = [];
  return {
    peers,
    create(init, events) {
      const peer = {
        init,
        events,
        sent: [],
        buffered: 0,
        closedWith: null,
        answered: null,
        offer: async () => ({ sdp: SDP, fingerprints: FINGERPRINTS }),
        answer: async (sdp) => {
          peer.answered = sdp;
        },
        candidate: async () => {},
        send: (channel, message) => {
          peer.sent.push({ channel, message });
          return true;
        },
        bufferedAmount: () => peer.buffered,
        close: (reason) => {
          peer.closedWith = reason;
        },
      };
      peers.push(peer);
      return peer;
    },
  };
}

async function harness({ peerHost = null, media = null, relaySend } = {}) {
  const { challenge, desktopChannel, phoneChannel } = await channels();
  const clock = { t: 10_000 };
  const relay = [];
  const delivered = [];
  const ended = [];
  const logs = [];
  let iceResolves = 0;
  const coordinator = createRemoteTransportCoordinator({
    sessionId: challenge.challenge,
    channel: desktopChannel,
    relay: {
      send:
        relaySend ??
        (async (message) => {
          relay.push(message);
        }),
    },
    deliver: (payload) => {
      delivered.push(payload);
    },
    ended: (value) => ended.push(value),
    suspended: () => {
      h.suspended += 1;
    },
    peerHost,
    media,
    resolveIceServers: async () => {
      iceResolves += 1;
      return ICE;
    },
    now: () => clock.t,
    schedule: () => () => {},
    log: (line) => logs.push(line),
  });
  const phone = createPhone(phoneChannel, clock);
  let relaySeen = 0;
  const h = {
    suspended: 0,
    challenge,
    desktopChannel,
    clock,
    relay,
    delivered,
    ended,
    logs,
    coordinator,
    phone,
    iceResolves: () => iceResolves,
    /** The phone takes every relay message it has not seen yet. */
    async phoneReadsRelay() {
      const fresh = relay.slice(relaySeen);
      relaySeen = relay.length;
      await phone.ingest(fresh);
    },
    async ready() {
      await coordinator.send({ type: 'e2ee-ready', version: 1, ...desktopChannel.handshakeConfirmation() });
      await h.phoneReadsRelay();
    },
    /** Moves the clock and runs the coordinator's timer once. */
    async advance(ms) {
      clock.t += ms;
      coordinator.tick();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return h;
}

const appMessages = (raws) => raws.map((raw) => decodeRemoteTransportMessage(raw)).filter((m) => m.kind !== 'control');

test('relay-only without a peer host: split → seal → sender out, receiver → open → assembler in; acks and pings on the control domain', async () => {
  const h = await harness();
  await h.ready();
  assert.equal(h.phone.messages[0].type, 'e2ee-ready');
  const large = { id: 4, ok: true, value: 'x'.repeat(1_500_000) };
  assert.ok(splitRemoteTransportPayload(large, 1).length > 1, 'the large answer is fragmented');
  await h.coordinator.send({ event: 'push', payload: 1 });
  await h.coordinator.send(large);
  await h.phoneReadsRelay();
  assert.deepEqual(h.phone.messages.slice(1), [{ event: 'push', payload: 1 }, large]);
  assert.ok(
    h.relay.every((raw) => raw[0] === 0x4d && raw[1] === 0x58 && raw[2] === 0x54),
    'MXT messages only'
  );

  // Inbound: the client's calls are delivered in order; the desktop acks
  // them in the control domain.
  for (const call of [
    { id: 1, method: 'a' },
    { id: 2, method: 'b' },
  ]) {
    for (const raw of await h.phone.record(call)) h.coordinator.receive('relay', raw);
  }
  await until(() => h.delivered.length === 2, 'delivery');
  assert.deepEqual(h.delivered, [
    { id: 1, method: 'a' },
    { id: 2, method: 'b' },
  ]);
  await h.advance(30);
  const seenControl = (t) => h.phone.controls.some(({ control }) => control.t === t);
  for (let i = 0; i < 2_000 && !(seenControl('ack') && seenControl('ping')); i += 1) {
    await h.phoneReadsRelay();
    await settle(i);
  }
  const ack = h.phone.controls.find(({ control }) => control.t === 'ack');
  assert.equal(ack.control.through, 2, 'the ack names the opened records');
  const ping = h.phone.controls.find(({ control }) => control.t === 'ping');
  assert.equal(typeof ping.control.sent, 'number', 'every ping carries `sent`');

  // The client's ack releases the desktop's records.
  assert.ok(h.coordinator.diagnostics().outstandingBytes > 0);
  const through = h.coordinator.nextSequence() - 1;
  h.coordinator.receive('relay', await h.phone.control(remoteTransportAck(through)));
  await until(() => h.coordinator.diagnostics().outstandingBytes === 0, 'release');
  assert.equal(h.coordinator.diagnostics().path, 'relay');
  assert.equal(h.ended.length, 0);
});

test('a refusal before sealing leaves nextSequence unchanged', async () => {
  const h = await harness();
  await h.ready();
  const before = h.coordinator.nextSequence();
  await assert.rejects(
    h.coordinator.send({ id: 3, ok: true, value: 'y'.repeat(REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES) }),
    (error) =>
      error instanceof RemoteTransportOversizeError && error.bytes > REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES
  );
  assert.equal(h.coordinator.nextSequence(), before, 'oversize: no sequence consumed');
  // Fill the window (no acks), then a droppable message is dropped unsealed.
  const filler = 'z'.repeat(1_000_000);
  while (h.coordinator.canAdmit()) await h.coordinator.send({ event: 'fill', filler });
  const full = h.coordinator.nextSequence();
  assert.equal(await h.coordinator.send({ event: 'tick' }, { droppable: true }), null);
  assert.equal(h.coordinator.nextSequence(), full, 'window: no sequence consumed');
  // The stream has no hole: the client opens every record in order.
  await h.phoneReadsRelay();
  assert.equal(h.phone.receiver.stats().deliveredThrough, full - 1);
});

test('record expiry ends the session and fails unacked calls as ambiguous', async () => {
  const h = await harness();
  await h.ready();
  await h.coordinator.send({ id: 7, ok: true, value: 'answer' });
  await h.advance(59_000);
  assert.equal(h.ended.length, 0, 'not before 60 s without ack progress');
  await h.advance(1_000);
  assert.equal(h.ended.length, 1);
  assert.equal(h.ended[0].reason, 'record-expiry');
  assert.deepEqual(h.ended[0].ambiguousCallIds, [7]);
  await assert.rejects(h.coordinator.send({ id: 8, ok: true }), RemoteTransportEndedError);
});

test('loss recovery: a dropped middle record and a dropped final record are repaired', async () => {
  const h = await harness();
  await h.ready();
  const records = [];
  for (let id = 1; id <= 4; id += 1) records.push(await h.phone.record({ id, method: 'm' }));
  // Record 2 is lost on the carrier.
  for (const index of [0, 2, 3]) for (const raw of records[index]) h.coordinator.receive('relay', raw);
  await until(() => h.delivered.length === 1, 'record 1');
  // Below the packet threshold (2 + 3 > 4): declared by the time threshold,
  // 9/8 × the initial RTT.
  await h.advance(400);
  for (let i = 0; i < 2_000 && !h.phone.controls.some(({ control }) => control.t === 'repair'); i += 1) {
    await h.phoneReadsRelay();
    await settle(i);
  }
  const repair = h.phone.controls.find(({ control }) => control.t === 'repair');
  assert.deepEqual(repair.control.sequences, [2], 'one box for the round');
  for (const raw of h.phone.resend()) h.coordinator.receive('relay', raw);
  await until(() => h.delivered.length === 4, 'all four');
  assert.deepEqual(
    h.delivered.map((call) => call.id),
    [1, 2, 3, 4]
  );

  // A lost FINAL record: only the client's ping `sent` reveals it.
  await h.phone.record({ id: 5, method: 'm' });
  h.coordinator.receive('relay', await h.phone.control(remoteTransportPing(1, 5)));
  for (let i = 0; i < 200 && h.phone.controls.filter(({ control }) => control.t === 'repair').length < 2; i += 1) {
    await h.advance(50);
    await h.phoneReadsRelay();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const second = h.phone.controls.filter(({ control }) => control.t === 'repair').at(-1);
  assert.deepEqual(second.control.sequences, [5]);
  for (const raw of h.phone.resend()) h.coordinator.receive('relay', raw);
  await until(() => h.delivered.length === 5, 'the final record');
});

test('a client repair re-sends exactly the named record', async () => {
  const h = await harness();
  await h.ready();
  await h.coordinator.send({ event: 'a' });
  await h.coordinator.send({ event: 'b' });
  const before = appMessages(h.relay).length;
  h.coordinator.receive('relay', await h.phone.control({ v: 1, t: 'repair', sequences: [2] }));
  await until(() => appMessages(h.relay).length === before + 1, 'the re-send');
  assert.equal(appMessages(h.relay).at(-1).sequence, 2);
  assert.equal(h.coordinator.diagnostics().retransmits, 1);
});

/** Drives a peer to promotion: offer → answer → open → validation pong. */
async function promote(h, peerHost, { maxMessageSize = 65_536, relayed = false, pong = true } = {}) {
  await h.advance(30);
  await until(() => peerHost.peers.length > 0, 'a peer');
  const peer = peerHost.peers.at(-1);
  let offer;
  for (let i = 0; i < 2_000 && !offer; i += 1) {
    if (i > 0) await settle(i);
    await h.phoneReadsRelay();
    offer = h.phone.controls.find(
      ({ lane, control }) =>
        lane.kind === 'relay' && control.t === 'offer' && control.connectionId === peer.init.connectionId
    )?.control;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(offer, 'an offer on the relay lane');
  const ref = { v: 1, sessionId: offer.sessionId, connectionId: offer.connectionId, generation: offer.generation };
  const lane = { kind: 'direct', epoch: offer.generation, connectionId: offer.connectionId };
  h.phone.register(lane);
  h.coordinator.receive('relay', await h.phone.control({ ...ref, t: 'answer', sdp: SDP, fingerprints: FINGERPRINTS }));
  await until(() => peer.answered === SDP, 'the answer applied');
  peer.events.open({ maxMessageSize, relayed });
  if (!pong) return { peer, offer, lane };
  await until(() => peer.sent.some(({ channel }) => channel === 'control'), 'the validation ping');
  await h.phone.ingest(
    peer.sent.filter(({ channel }) => channel === 'control').map(({ message }) => message),
    lane
  );
  const ping = h.phone.controls.filter((entry) => entry.lane === lane && entry.control.t === 'ping').at(-1);
  peer.events.message(await h.phone.control({ v: 1, t: 'pong', id: ping.control.id }, lane));
  await until(() => h.coordinator.diagnostics().path !== 'relay', 'promotion');
  return { peer, offer, lane };
}

test('promotion needs the fitting channel and a fresh ping/pong on it; then new records go direct', async () => {
  const peerHost = fakePeerHost();
  const h = await harness({ peerHost });
  await h.ready();
  const { peer, offer, lane } = await promote(h, peerHost);
  assert.deepEqual(offer.iceServers, ICE, 'the session ICE set rides the offer');
  assert.equal(h.iceResolves(), 1, 'resolved once from the shared cache');
  assert.equal(h.coordinator.diagnostics().path, 'direct');
  const relayApps = appMessages(h.relay).length;
  await h.coordinator.send({ event: 'direct' });
  assert.equal(appMessages(h.relay).length, relayApps, 'nothing new on the relay');
  const direct = peer.sent.filter(({ channel }) => channel === 'app').map(({ message }) => message);
  await h.phone.ingest(direct, lane);
  assert.deepEqual(h.phone.messages.at(-1), { event: 'direct' });
  // The resume ack went out at once on the promoted carrier.
  await until(() => peer.sent.filter(({ channel }) => channel === 'control').length >= 2, 'resume ack');
  // Diagnostics: the path, and that application records really moved on it.
  const stats = h.coordinator.diagnostics();
  assert.equal(stats.path, 'direct');
  assert.ok(stats.directBytesSent >= messageBytes(direct), 'direct bytes counted');
  assert.ok(stats.directBytesSent < stats.bytesSent, 'the relay share is the rest');
  assert.equal(h.logs.filter((line) => /carrying path=direct generation=\d+$/.test(line)).length, 1, 'logged once');
  h.coordinator.close();
  assert.ok(
    h.logs.some((line) => /ended reason=session-ended .*direct-tx=[1-9]\d* direct-rx=\d+$/.test(line)),
    'the end line shows what the direct path carried'
  );
});

test('no promotion without a pong, and none on a carrier whose max message size does not fit', async () => {
  const silentHost = fakePeerHost();
  const silent = await harness({ peerHost: silentHost });
  await silent.ready();
  await promote(silent, silentHost, { pong: false });
  await silent.advance(30);
  assert.equal(silent.coordinator.diagnostics().path, 'relay', 'open alone is not validation');

  const smallHost = fakePeerHost();
  const small = await harness({ peerHost: smallHost });
  await small.ready();
  const { peer } = await promote(small, smallHost, { maxMessageSize: 16_384, pong: false });
  assert.equal(peer.closedWith, 'channel-failed');
  assert.equal(small.coordinator.diagnostics().path, 'relay');
  assert.equal(small.coordinator.diagnostics().reason, 'message-size');
});

const messageBytes = (raws) => raws.reduce((sum, raw) => sum + raw.byteLength, 0);

test('relay meter: a message carried on the relay reports its bytes; one carried on direct reports none', async () => {
  const peerHost = fakePeerHost();
  const h = await harness({ peerHost });
  await h.ready();
  const relayWrites = [];
  const before = h.relay.length;
  const total = await h.coordinator.send({ event: 'relay' }, { onRelayWrite: (bytes) => relayWrites.push(bytes) });
  await until(() => relayWrites.length > 0, 'the relay write');
  assert.equal(
    relayWrites.reduce((a, b) => a + b, 0),
    total
  );
  assert.equal(messageBytes(h.relay.slice(before)), total);

  const { peer } = await promote(h, peerHost);
  const directWrites = [];
  await h.coordinator.send({ event: 'direct' }, { onRelayWrite: (bytes) => directWrites.push(bytes) });
  await until(() => peer.sent.some(({ channel }) => channel === 'app'), 'the direct write');
  await h.advance(30);
  assert.deepEqual(directWrites, [], 'nothing the relay carried');
});

test('relay meter: a message split across a carrier switch reports only its relay share', async () => {
  const peerHost = fakePeerHost();
  const h = await harness({ peerHost });
  await h.ready();
  const { peer, lane } = await promote(h, peerHost);
  // Once the first record is on the direct channel it stops taking more.
  const appSend = peer.send;
  peer.send = (channel, message) => {
    if (channel === 'app') peer.buffered = REMOTE_TRANSPORT_BUFFER_HIGH_BYTES;
    return appSend(channel, message);
  };
  const relayWrites = [];
  const firstSequence = h.coordinator.nextSequence();
  const total = await h.coordinator.send(
    { event: 'bulk', data: randomBytes(2_000_000).toString('base64') },
    { onRelayWrite: (bytes) => relayWrites.push(bytes) }
  );
  assert.ok(h.coordinator.nextSequence() - firstSequence >= 3, 'several records');
  await until(() => peer.sent.some(({ channel }) => channel === 'app'), 'the first record on direct');
  const directBytes = messageBytes(peer.sent.filter(({ channel }) => channel === 'app').map(({ message }) => message));
  assert.deepEqual(relayWrites, []);
  // The client acks the direct record, then the carrier fails: the rest resumes on the relay.
  const outstanding = h.coordinator.diagnostics().outstandingBytes;
  peer.events.message(await h.phone.control(remoteTransportAck(firstSequence), lane));
  await until(() => h.coordinator.diagnostics().outstandingBytes < outstanding, 'direct record acked');
  peer.events.closed('ice-failed');
  await h.advance(1_100);
  await until(() => relayWrites.reduce((a, b) => a + b, 0) === total - directBytes, 'the relay share');
  assert.ok(directBytes > 0 && directBytes < total);
});

test('relay meter: a throwing callback never disturbs delivery or rejects the write', async () => {
  const h = await harness();
  await h.ready();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    let calls = 0;
    const boom = () => {
      calls += 1;
      throw new Error('meter failed');
    };
    for (let i = 0; i < 3; i += 1) await h.coordinator.send({ event: 'metered', i }, { onRelayWrite: boom });
    await until(() => calls === 3, 'every callback ran');
    await h.coordinator.send({ event: 'after' });
    await h.phoneReadsRelay();
    assert.deepEqual(h.phone.messages.slice(-4), [
      { event: 'metered', i: 0 },
      { event: 'metered', i: 1 },
      { event: 'metered', i: 2 },
      { event: 'after' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('relay meter: a relay write that resolves after close() fires no callback', async () => {
  const pending = [];
  const h = await harness({ relaySend: (message) => new Promise((resolve) => pending.push(resolve)) });
  const calls = [];
  void h.coordinator.send({ event: 'late' }, { onRelayWrite: (bytes) => calls.push(bytes) });
  await until(() => pending.length > 0, 'a relay write in flight');
  h.coordinator.close();
  for (const resolve of pending) resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, []);
});

test('a stalled direct carrier is demoted and its unacked records resume on the relay', async () => {
  const peerHost = fakePeerHost();
  const h = await harness({ peerHost });
  await h.ready();
  const { peer } = await promote(h, peerHost);
  peer.buffered = 200_000;
  await h.coordinator.send({ event: 'stuck-1' });
  await h.coordinator.send({ event: 'stuck-2' });
  const relayApps = appMessages(h.relay).length;
  await h.advance(5_900);
  assert.equal(h.coordinator.diagnostics().path, 'direct', 'not before the 6 s bound');
  await h.advance(100);
  assert.equal(h.coordinator.diagnostics().path, 'relay');
  assert.equal(h.coordinator.diagnostics().reason, 'stall');
  assert.equal(peer.closedWith, 'stall');
  // Held for one relay PTO (no resume ack), then re-sent on the relay.
  await h.advance(1_100);
  await until(() => appMessages(h.relay).length === relayApps + 2, 'the re-sends');
  await h.phoneReadsRelay();
  assert.deepEqual(h.phone.messages.slice(-2), [{ event: 'stuck-1' }, { event: 'stuck-2' }]);
});

test('a hard failure demotes at once; a new peer may be promoted again with no hold-down', async () => {
  const peerHost = fakePeerHost();
  const h = await harness({ peerHost });
  await h.ready();
  const { peer, offer } = await promote(h, peerHost);
  peer.events.closed('ice-failed');
  assert.equal(h.coordinator.diagnostics().path, 'relay');
  assert.equal(h.coordinator.diagnostics().reason, 'ice-failed');
  // The client asks for a new offer: a new peer, generation + 1, once the
  // negotiation window allows it.
  h.coordinator.receive('relay', await h.phone.control({ ...refOf(offer), t: 'close', reason: 'restart' }));
  await handled(h, 1);
  await h.advance(REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS);
  await until(() => peerHost.peers.length === 2, 'a new peer');
  const again = await promote(h, peerHost);
  assert.equal(again.offer.generation, 2);
  assert.equal(h.coordinator.diagnostics().path, 'direct');
});

test('a slow but draining carrier is never demoted or re-sent to', async () => {
  const peerHost = fakePeerHost();
  const h = await harness({ peerHost });
  await h.ready();
  const { peer, lane } = await promote(h, peerHost);
  peer.buffered = 4_000_000;
  for (let i = 0; i < 4; i += 1) await h.coordinator.send({ event: 'bulk', i });
  const sentApps = peer.sent.filter(({ channel }) => channel === 'app').length;
  let answered = peer.sent.length;
  for (let second = 0; second < 20; second += 1) {
    peer.buffered -= 100_000; // draining slowly, never acked
    await h.advance(1_000);
    // The client answers the keep-alive pings on the direct lane.
    const fresh = peer.sent.slice(answered).filter(({ channel }) => channel === 'control');
    answered = peer.sent.length;
    const before = h.phone.controls.length;
    await h.phone.ingest(
      fresh.map(({ message }) => message),
      lane
    );
    for (const { control } of h.phone.controls.slice(before)) {
      if (control.t === 'ping') peer.events.message(await h.phone.control({ v: 1, t: 'pong', id: control.id }, lane));
    }
  }
  assert.equal(h.coordinator.diagnostics().path, 'direct');
  assert.equal(h.coordinator.diagnostics().retransmits, 0);
  assert.equal(peer.sent.filter(({ channel }) => channel === 'app').length, sentApps, 'nothing re-sent');
  assert.equal(peer.closedWith, null);
});

test('TURN allocations are logged per session without credentials', async () => {
  const peerHost = fakePeerHost();
  const h = await harness({ peerHost });
  await h.ready();
  await promote(h, peerHost, { relayed: true });
  assert.equal(h.coordinator.diagnostics().path, 'turn');
  assert.equal(h.coordinator.diagnostics().turnAllocations, 1);
  assert.ok(h.logs.some((line) => /turn-allocations=1 path=turn/.test(line)));
  assert.ok(
    h.logs.every((line) => !line.includes('secret')),
    'no credentials in logs'
  );
});

test('media hook: client media messages reach the route; chunks are bulk records within the stream credit', async () => {
  // A fake 1D adapter on the session's link.
  const received = [];
  let link = null;
  let closedCount = 0;
  let writable = 0;
  const media = (sessionLink) => {
    link = sessionLink;
    link.onWritable(() => {
      writable += 1;
    });
    return {
      receive: (payload) => {
        if (payload?.type !== 'transport-media') return false;
        received.push(payload);
        return true;
      },
      close: () => {
        closedCount += 1;
      },
    };
  };
  const h = await harness({ media });
  await h.ready();
  const request = {
    type: 'transport-media',
    op: 'request',
    id: 'm1',
    assetId: 'abcdef12',
    variant: 'original',
    range: '',
    enc: 'e2ee1',
  };
  for (const raw of await h.phone.record(request)) h.coordinator.receive('relay', raw);
  for (const raw of await h.phone.record({ id: 1, method: 'listProjects' })) h.coordinator.receive('relay', raw);
  await until(() => received.length === 1 && h.delivered.length === 1, 'routing');
  assert.deepEqual(h.delivered, [{ id: 1, method: 'listProjects' }], 'media is consumed by the adapter, RPCs are not');

  // A download in progress, then an RPC answer: both go through the one
  // serialized seal path, and the answer is not starved.
  const frame = 'A'.repeat(80_000);
  const send = () => link.send({ type: 'transport-media', op: 'chunk', id: 'm1', frame }, { stream: 'm1' });
  let chunks = 0;
  while (link.canAdmit('m1')) {
    assert.equal(await send(), true);
    chunks += 1;
  }
  assert.ok(chunks >= 10 && chunks <= 12, `the 1 MiB stream credit bounds the stream (${chunks})`);
  const sealedBefore = h.coordinator.nextSequence();
  // The download keeps pushing while an RPC answer is due: the chunk is
  // refused before sealing (nothing consumed), the answer is sealed at once.
  const [refused, answer] = await Promise.all([send(), h.coordinator.send({ id: 1, ok: true, value: [] })]);
  assert.equal(refused, false, 'over credit: refused before sealing');
  assert.ok(answer > 0, 'the RPC answer is not starved by the download');
  const sequence = h.coordinator.nextSequence();
  assert.equal(sequence, sealedBefore + 1, 'only the answer took a sequence');
  assert.equal(link.canAdmit('m2'), true, 'another stream still has credit');
  await h.phoneReadsRelay();
  assert.deepEqual(h.phone.messages.at(-1), { id: 1, ok: true, value: [] });
  assert.equal(h.phone.receiver.stats().deliveredThrough, sequence - 1);

  // An ack advance wakes the adapter.
  const before = writable;
  h.coordinator.receive('relay', await h.phone.control(remoteTransportAck(sequence - 1)));
  await until(() => writable > before, 'writable');
  assert.equal(link.canAdmit('m1'), true, 'credit returns with the ack');

  h.coordinator.close();
  assert.equal(closedCount, 1, 'the adapter closes with the session');
  await assert.rejects(
    link.send({ type: 'transport-media', op: 'end', id: 'm1' }, { stream: 'm1' }),
    RemoteTransportEndedError
  );
});

test('delivery: every sealed record takes the non-droppable relay path; drops happen only before sealing', async () => {
  const { challenge, desktopChannel } = await channels();
  const writes = [];
  const state = { channel: desktopChannel, binaryFrames: true, challenge, credentialId: 'c1' };
  const closed = [];
  const delivery = createRelayEncryptedDelivery({
    clients: {
      clients: new Map([['c11e1700-0001', state]]),
      get: (id) => (id === 'c11e1700-0001' ? state : undefined),
      close: (id, reason) => closed.push(reason),
    },
    relayBinaryFrames: () => true,
    relayFrameLimit: () => 4_096,
    // A busy relay leg: every write takes a while.
    sendRawAndWait: (frame) =>
      new Promise((resolve) =>
        setTimeout(() => {
          writes.push(frame);
          resolve();
        }, 1)
      ),
    byteMeter: { record: () => null },
    transport: { options: { schedule: () => () => {}, log: () => {} } },
  });
  const transport = delivery.openTransport('c11e1700-0001', state, { deliver: () => {}, authenticated: () => {} });
  await delivery.sendEncryptedFrame('c11e1700-0001', { type: 'e2ee-ready', ...desktopChannel.handshakeConfirmation() });
  const pad = 'p'.repeat(300_000);
  for (let i = 0; i < 40; i += 1) delivery.broadcastEncrypted({ event: 'push', i, pad }, true);
  await until(() => transport.diagnostics().queueDepth === 0, 'the queue settles');
  const sealed = transport.nextSequence() - 1;
  assert.ok(sealed < 41, 'the window closed: some pushes were dropped unsealed');
  await until(() => {
    const frames = writes.map((frame) => decodeRelayBinaryFrame(frame));
    const sequences = new Set(appMessages(frames.map((f) => f.data)).map((m) => m.sequence));
    return sequences.size === sealed;
  }, 'every sealed record written');
  const frames = writes.map((frame) => decodeRelayBinaryFrame(frame));
  assert.ok(
    frames.every((frame) => frame.droppable === false),
    'never droppable'
  );
  assert.deepEqual(closed, []);
});

test('delivery: the byte meter records each relay write with its payload, at the bytes the relay took', async () => {
  const { challenge, desktopChannel } = await channels();
  const writes = [];
  const recorded = [];
  const state = { channel: desktopChannel, binaryFrames: true, challenge, credentialId: 'c1' };
  const delivery = createRelayEncryptedDelivery({
    clients: {
      clients: new Map([['c11e1700-0001', state]]),
      get: () => state,
      close() {},
    },
    relayBinaryFrames: () => true,
    relayFrameLimit: () => 1 << 26,
    sendRawAndWait: async (frame) => {
      writes.push(frame);
    },
    byteMeter: {
      record: (payload, bytes) => {
        recorded.push({ payload, bytes });
        return null;
      },
    },
    transport: { options: { schedule: () => () => {}, log: () => {} } },
  });
  delivery.openTransport('c11e1700-0001', state, { deliver: () => {}, authenticated: () => {} });
  const payload = { event: 'push', pad: 'p'.repeat(200_000) };
  await delivery.sendEncryptedFrame('c11e1700-0001', payload);
  await until(() => recorded.length > 0, 'a metered write');
  await until(
    () =>
      recorded.reduce((sum, entry) => sum + entry.bytes, 0) ===
      messageBytes(writes.map((f) => decodeRelayBinaryFrame(f).data)),
    'every write metered'
  );
  assert.ok(recorded.every((entry) => entry.payload === payload));
});

test('an authenticated suspended close makes the leg non-foreground at once, with no prior hidden report', async () => {
  const { challenge, desktopChannel, phoneChannel } = await channels();
  const writes = [];
  const state = {
    channel: desktopChannel,
    binaryFrames: true,
    challenge,
    credentialId: 'c1',
    background: false,
    screenSessionIds: new Set(['A']),
    liveAt: 0,
  };
  const peerHost = fakePeerHost();
  let tick = () => {};
  const delivery = createRelayEncryptedDelivery({
    clients: { clients: new Map([['c11e1700-0001', state]]), get: () => state, close() {} },
    relayBinaryFrames: () => true,
    relayFrameLimit: () => 1 << 26,
    sendRawAndWait: async (frame) => {
      writes.push(frame);
    },
    byteMeter: { record: () => null },
    transport: {
      peerHost,
      options: {
        schedule: (run) => {
          tick = run;
          return () => {};
        },
        resolveIceServers: async () => [],
        log: () => {},
      },
    },
  });
  const transport = delivery.openTransport('c11e1700-0001', state, { deliver: () => {}, authenticated: () => {} });
  await delivery.sendEncryptedFrame('c11e1700-0001', { type: 'e2ee-ready', ...desktopChannel.handshakeConfirmation() });
  const phone = createPhone(phoneChannel, { t: 0 });
  await phone.ingest(writes.map((frame) => decodeRelayBinaryFrame(frame).data));
  // The PC offers a connection; the phone suspends before answering.
  tick();
  // ready, the keep-alive ping, then the offer.
  await until(() => peerHost.peers.length === 1 && writes.length >= 3, 'an offer');
  assert.equal(legShowsSession(state, 'A', 1), true, 'foreground before');
  const { connectionId } = peerHost.peers[0].init;
  const close = { v: 1, sessionId: challenge.challenge, connectionId, generation: 1, t: 'close', reason: 'suspended' };
  transport.receive('relay', await phone.control(close));
  await until(() => state.background === true, 'background');
  assert.equal(legShowsSession(state, 'A', 1), false, 'not foreground, though no setForeground(false) came');
  transport.close();
});

test('a suspended close for a connection already closed here still marks the leg background, and nothing else', async () => {
  const peerHost = fakePeerHost();
  const h = await harness({ peerHost });
  await h.ready();
  const { peer, offer } = await promote(h, peerHost);
  peer.events.closed('ice-failed');
  assert.equal(h.coordinator.diagnostics().path, 'relay');
  const ref = { v: 1, sessionId: offer.sessionId, connectionId: offer.connectionId, generation: offer.generation };
  h.coordinator.receive('relay', await h.phone.control({ ...ref, t: 'close', reason: 'suspended' }));
  await until(() => h.suspended === 1, 'background');
  // A connection this session never offered: ignored, not a protocol error.
  h.coordinator.receive(
    'relay',
    await h.phone.control({ ...ref, connectionId: 'never-offered', t: 'close', reason: 'suspended' })
  );
  await handled(h, 9);
  await h.advance(30);
  assert.equal(h.suspended, 1);
  assert.deepEqual(h.ended, [], 'the session goes on');
  assert.equal(peerHost.peers.length, 1, 'no peer was touched or started by it');
});

const refOf = (offer) => ({
  v: 1,
  sessionId: offer.sessionId,
  connectionId: offer.connectionId,
  generation: offer.generation,
});

/** Sends a client ping and waits for its pong: control boxes open in
 *  order, so everything sent before it was handled. */
async function handled(h, id) {
  h.coordinator.receive('relay', await h.phone.control({ v: 1, t: 'ping', id }));
  for (
    let i = 0;
    i < 200 && !h.phone.controls.some(({ control }) => control.t === 'pong' && control.id === id);
    i += 1
  ) {
    await h.phoneReadsRelay();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(
    h.phone.controls.some(({ control }) => control.t === 'pong' && control.id === id),
    `pong ${id}`
  );
}

/** The client acks everything sealed so far (no record expiry over long runs). */
async function ackAll(h) {
  h.coordinator.receive('relay', await h.phone.control(remoteTransportAck(h.coordinator.nextSequence() - 1)));
  await until(() => h.coordinator.diagnostics().outstandingBytes === 0, 'acked');
}

test('restart: only the newest offer may be named, and it never shortens the negotiation window', async () => {
  const peerHost = fakePeerHost();
  const h = await harness({ peerHost });
  await h.ready();
  await ackAll(h);
  const first = await promote(h, peerHost);
  const startedAt = h.clock.t;
  // Repeated restarts naming the live connection: it closes once, and no
  // new offer comes before the window has passed.
  for (let i = 0; i < 5; i += 1) {
    h.coordinator.receive('relay', await h.phone.control({ ...refOf(first.offer), t: 'close', reason: 'restart' }));
    await h.advance(30);
  }
  await handled(h, 1);
  assert.equal(first.peer.closedWith, 'superseded');
  await h.advance(REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS - (h.clock.t - startedAt) - 100);
  assert.equal(peerHost.peers.length, 1, 'no offer within the negotiation window');
  await h.advance(200);
  await until(() => peerHost.peers.length === 2, 'one offer after it');
  const second = await promote(h, peerHost, { pong: false });
  assert.equal(second.offer.generation, 2);

  // Stale and unknown references are no-ops.
  const stale = [
    refOf(first.offer),
    { ...refOf(second.offer), generation: 1 },
    { ...refOf(second.offer), connectionId: 'never-offered' },
  ];
  for (const ref of stale)
    h.coordinator.receive('relay', await h.phone.control({ ...ref, t: 'close', reason: 'restart' }));
  await handled(h, 2);
  await h.advance(30);
  assert.equal(second.peer.closedWith, null, 'the live connection is untouched');
  assert.equal(peerHost.peers.length, 2);
  assert.deepEqual(h.ended, []);

  // The newest one may be restarted, but the next offer still waits.
  h.coordinator.receive('relay', await h.phone.control({ ...refOf(second.offer), t: 'close', reason: 'restart' }));
  await handled(h, 3);
  await h.advance(30);
  assert.equal(second.peer.closedWith, 'superseded');
  assert.equal(peerHost.peers.length, 2, 'paced from the second offer');
});

test('the offered history stays bounded over many reconnects', async () => {
  const peerHost = fakePeerHost();
  const h = await harness({ peerHost });
  await h.ready();
  await ackAll(h);
  const offers = [];
  for (let i = 0; i < 8; i += 1) {
    if (i > 0) {
      await h.advance(REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS);
      await until(() => peerHost.peers.length === i + 1, `peer ${i + 1}`);
    }
    const { peer, offer } = await promote(h, peerHost, { pong: false });
    offers.push(offer);
    peer.events.closed('ice-failed');
    assert.ok(h.coordinator.diagnostics().retainedOffers <= 2, 'at most the last two offers');
  }
  assert.equal(new Set(offers.map((offer) => offer.connectionId)).size, 8);
  // The first and the expired previous offer are forgotten; the last one,
  // closed just now, still counts.
  for (const offer of [offers[0], offers[6]]) {
    h.coordinator.receive('relay', await h.phone.control({ ...refOf(offer), t: 'close', reason: 'suspended' }));
  }
  await handled(h, 1);
  assert.equal(h.suspended, 0);
  assert.equal(h.coordinator.diagnostics().retainedOffers, 1, 'the expired previous offer is dropped');
  h.coordinator.receive('relay', await h.phone.control({ ...refOf(offers[7]), t: 'close', reason: 'suspended' }));
  await until(() => h.suspended === 1, 'background');
  assert.deepEqual(h.ended, []);
});

test('a suspended close that crossed a newer offer still marks background, within the window', async () => {
  const peerHost = fakePeerHost();
  const h = await harness({ peerHost });
  await h.ready();
  await ackAll(h);
  const first = await promote(h, peerHost);
  const startedAt = h.clock.t;
  // It fails late in its window; the next offer follows soon after.
  await h.advance(REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS - 1_000);
  await ackAll(h);
  first.peer.events.closed('ice-failed');
  await h.advance(REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS - (h.clock.t - startedAt) + 100);
  await until(() => peerHost.peers.length === 2, 'the newer peer');
  await promote(h, peerHost, { pong: false });
  // The client, unaware of the newer offer, names the one it knew.
  h.coordinator.receive('relay', await h.phone.control({ ...refOf(first.offer), t: 'close', reason: 'suspended' }));
  await until(() => h.suspended === 1, 'background');
  assert.equal(peerHost.peers[1].closedWith, null, 'the newer connection is untouched');
  // Once the window since its close has passed, it is forgotten.
  await h.advance(REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS);
  h.coordinator.receive('relay', await h.phone.control({ ...refOf(first.offer), t: 'close', reason: 'suspended' }));
  await handled(h, 1);
  assert.equal(h.suspended, 1);
});

test('delivery: an oversize answer is refused before sealing and the call is told', async () => {
  const { challenge, desktopChannel, phoneChannel } = await channels();
  const writes = [];
  const state = { channel: desktopChannel, binaryFrames: true, challenge, credentialId: '' };
  const delivery = createRelayEncryptedDelivery({
    clients: { clients: new Map([['c11e1700-0001', state]]), get: () => state, close() {} },
    relayBinaryFrames: () => true,
    relayFrameLimit: () => 1 << 30,
    sendRawAndWait: async (frame) => {
      writes.push(frame);
    },
    byteMeter: { record: () => null },
    transport: { options: { schedule: () => () => {}, log: () => {} } },
  });
  const transport = delivery.openTransport('c11e1700-0001', state, { deliver: () => {}, authenticated: () => {} });
  await delivery.sendEncryptedFrame('c11e1700-0001', { type: 'e2ee-ready', ...desktopChannel.handshakeConfirmation() });
  const before = transport.nextSequence();
  await delivery.sendEncryptedFrame('c11e1700-0001', {
    id: 9,
    ok: true,
    value: 'v'.repeat(REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES),
  });
  assert.equal(transport.nextSequence(), before + 1, 'only the refusal notice was sealed');
  const clock = { t: 0 };
  const phone = createPhone(phoneChannel, clock);
  await phone.ingest(writes.map((frame) => decodeRelayBinaryFrame(frame).data));
  assert.equal(phone.messages.length, 2);
  assert.equal(phone.messages[1].payload.id, 9, 'the refused call is named');
});

// ---------------------------------------------------------------------------
// The real stage 1B bridge (peer-window.ts) on the 1B test's fake host page:
// a fake Electron window whose IPC hop is a queue pumped by the test, the
// real page module, and a fake RTCPeerConnection.
// ---------------------------------------------------------------------------

const bridgeWorld = { windows: [], peers: [] };

class BridgeContents {
  constructor() {
    this.handlers = new Map();
    this.ipcHandlers = new Map();
    this.toPage = [];
    this.toMain = [];
    this.page = null;
    this.ipc = { on: (channel, listener) => this.ipcHandlers.set(channel, listener) };
  }
  on(name, listener) {
    this.handlers.set(name, listener);
  }
  setWindowOpenHandler() {}
  send(_channel, payload) {
    this.toPage.push(structuredClone(payload));
  }
}

class BridgeWindow {
  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.handlers = new Map();
    this.webContents = new BridgeContents();
    bridgeWorld.windows.push(this);
  }
  on(name, listener) {
    this.handlers.set(name, listener);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.handlers.get('closed')?.();
  }
  loadFile() {
    startBridgePage(this);
    return Promise.resolve();
  }
  loadURL() {
    startBridgePage(this);
    return Promise.resolve();
  }
}

globalThis.__coordinatorPeerWindowElectron = { BridgeWindow };
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,export const BrowserWindow=globalThis.__coordinatorPeerWindowElectron.BridgeWindow;' +
            'export const app={getAppPath:()=>"/app"};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});

class BridgeChannel extends EventTarget {
  constructor(label, init) {
    super();
    this.label = label;
    this.ordered = init.ordered;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.binaryType = 'blob';
    this.sent = [];
  }
  send(data) {
    this.sent.push(data);
    this.bufferedAmount += data.byteLength;
  }
  open() {
    this.readyState = 'open';
    this.onopen?.();
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }
  drain(bytes) {
    const before = this.bufferedAmount;
    this.bufferedAmount = Math.max(0, before - bytes);
    if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
      this.dispatchEvent(new Event('bufferedamountlow'));
    }
  }
  receive(bytes) {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
}

class BridgePeerConnection {
  constructor(config) {
    this.config = config;
    this.channels = [];
    this.connectionState = 'new';
    this.sctp = { maxMessageSize: 262_144, transport: { state: 'connected' } };
    this.localDescription = null;
    this.remoteDescription = null;
    this.closed = false;
    bridgeWorld.peers.push(this);
  }
  createDataChannel(label, init) {
    const channel = new BridgeChannel(label, init);
    this.channels.push(channel);
    return channel;
  }
  channel(label) {
    return this.channels.find((channel) => channel.label === label);
  }
  async createOffer() {
    return { type: 'offer', sdp: BRIDGE_LOCAL_SDP };
  }
  async setLocalDescription(description) {
    this.localDescription = description;
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }
  async addIceCandidate() {}
  async getStats() {
    return new Map([
      ['t', { type: 'transport', remoteCertificateId: 'c', selectedCandidatePairId: 'p' }],
      ['c', { type: 'certificate', fingerprint: FINGERPRINT, fingerprintAlgorithm: 'sha-256' }],
      ['p', { type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r' }],
      ['l', { type: 'local-candidate', candidateType: 'host' }],
      ['r', { type: 'remote-candidate', candidateType: 'srflx' }],
    ]);
  }
  close() {
    this.closed = true;
  }
  connect() {
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
  }
}

const bridgeSdp = (fingerprint) =>
  `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 ${fingerprint}\r\n` +
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
const BRIDGE_LOCAL_SDP = bridgeSdp(Array.from({ length: 32 }, (_, i) => (i + 64).toString(16).toUpperCase()).join(':'));
const BRIDGE_ANSWER_SDP = bridgeSdp(FINGERPRINT);

let startRemoteTransportPeerHost;
function startBridgePage(window) {
  const contents = window.webContents;
  startRemoteTransportPeerHost({
    bridge: {
      onCommand(listener) {
        contents.page = listener;
      },
      emit(event) {
        contents.toMain.push(structuredClone(event));
      },
    },
    RTCPeerConnection: BridgePeerConnection,
  });
}

/** Moves one round across every window's IPC hop, both ways. */
async function bridgePump() {
  await new Promise((resolve) => setImmediate(resolve));
  for (const window of bridgeWorld.windows) {
    const contents = window.webContents;
    if (window.destroyed) {
      contents.toPage.length = 0;
      contents.toMain.length = 0;
      continue;
    }
    while (contents.toPage.length) contents.page(contents.toPage.shift());
    while (contents.toMain.length) {
      contents.ipcHandlers.get('remote-transport-peer:event')?.({}, contents.toMain.shift());
    }
  }
}

async function pumpUntil(condition, what, pump = bridgePump) {
  for (let i = 0; i < 2_000; i += 1) {
    if (condition()) return;
    await pump();
    if (i > 200) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`${what} never became true`);
}

/** Drives the coordinator's next offer through the fake host page to
 *  promotion: offer on the relay lane, answer, open, validation ping/pong. */
async function promoteThroughPage(h, pump = bridgePump) {
  const before = h.phone.controls.length;
  let offer;
  for (let i = 0; i < 500 && !offer; i += 1) {
    await pump();
    await h.phoneReadsRelay();
    offer = h.phone.controls
      .slice(before)
      .find(({ lane, control }) => lane.kind === 'relay' && control.t === 'offer')?.control;
  }
  assert.ok(offer, 'the offer');
  assert.equal(offer.sdp, BRIDGE_LOCAL_SDP);
  const pc = bridgeWorld.peers.at(-1);
  const app = pc.channel('mixdog-transport');
  const control = pc.channel('mixdog-transport-control');
  const lane = { kind: 'direct', epoch: offer.generation, connectionId: offer.connectionId };
  h.phone.register(lane);
  h.coordinator.receive(
    'relay',
    await h.phone.control({ ...refOf(offer), t: 'answer', sdp: BRIDGE_ANSWER_SDP, fingerprints: FINGERPRINTS })
  );
  await pumpUntil(() => pc.remoteDescription !== null, 'the answer applied', pump);
  pc.connect();
  app.open();
  control.open();
  let seen = 0;
  const phoneReadsControl = async () => {
    const fresh = control.sent.slice(seen);
    seen = control.sent.length;
    await h.phone.ingest(fresh, lane);
  };
  await pumpUntil(() => control.sent.length > 0, 'the validation ping', pump);
  await phoneReadsControl();
  const validation = h.phone.controls.find((entry) => entry.lane === lane && entry.control.t === 'ping');
  control.receive(await h.phone.control({ v: 1, t: 'pong', id: validation.control.id }, lane));
  await pumpUntil(() => h.coordinator.diagnostics().path === 'direct', 'promotion', pump);
  return { offer, pc, app, control, lane, phoneReadsControl };
}

test('through the real 1B bridge: offer, open, the aggregate bound, control past bulk, drain, and a host reload back to relay', async () => {
  ({ startRemoteTransportPeerHost } = await import('../../renderer/remote-transport-peer-host/main.ts'));
  const { createRemoteTransportPeerWindow } = await import('./peer-window.ts');
  bridgeWorld.windows.length = 0;
  bridgeWorld.peers.length = 0;
  const bridge = createRemoteTransportPeerWindow({ page: { file: '/app/out/renderer/remote-transport-peer.html' } });
  const h = await harness({ peerHost: createRemoteTransportPeerHost(bridge) });
  await h.ready();
  await ackAll(h);

  // Offer: the coordinator creates the peer through the bridge and signals
  // the page's offer on the relay lane; then open, validation, promotion.
  await h.advance(30);
  const { offer, app, control, lane, phoneReadsControl } = await promoteThroughPage(h);
  assert.equal(bridgeWorld.windows.length, 1);

  // Bulk against the aggregate bound: the network holds 3 MiB already, and
  // nothing drains. App records stop the control reserve short of HIGH.
  const appLimit = REMOTE_TRANSPORT_BUFFER_HIGH_BYTES - REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES;
  app.bufferedAmount = 3 * 1024 * 1024;
  let bulk = 0;
  while (h.coordinator.canAdmit() && bulk < 40) {
    await h.coordinator.send({ event: 'bulk', bulk, data: randomBytes(400_000).toString('base64') });
    bulk += 1;
    await bridgePump();
  }
  for (let i = 0; i < 20; i += 1) await bridgePump();
  const id = offer.connectionId;
  const appWire = () => app.sent.reduce((sum, data) => sum + data.byteLength, 0);
  assert.ok(bridge.queued(id, 'app') <= appLimit, 'app records within their share of the aggregate load');
  assert.ok(bridge.queued(id, 'app') > appLimit - 1_100_000, 'the app share is (nearly) full');
  assert.ok(appWire() < h.coordinator.diagnostics().outstandingBytes, 'sealed records wait for room');

  // Control still passes: a client ping is answered on the direct lane.
  control.receive(await h.phone.control({ v: 1, t: 'ping', id: 77 }, lane));
  for (let i = 0; i < 500 && !h.phone.controls.some(({ control: c }) => c.t === 'pong' && c.id === 77); i += 1) {
    await bridgePump();
    await phoneReadsControl();
  }
  assert.ok(
    h.phone.controls.some(({ control: c }) => c.t === 'pong' && c.id === 77),
    'the pong past bulk'
  );
  assert.ok(bridge.queued(id) <= REMOTE_TRANSPORT_BUFFER_HIGH_BYTES);

  // A drain resumes the held records.
  const held = app.sent.length;
  app.drain(app.bufferedAmount);
  await pumpUntil(() => app.sent.length > held, 'sending resumed after the drain');

  // A host reload fails the carrier back to the relay; its records resume there.
  const relayApps = appMessages(h.relay).length;
  startBridgePage(bridgeWorld.windows[0]);
  await pumpUntil(() => h.coordinator.diagnostics().path === 'relay', 'demotion');
  assert.equal(bridgeWorld.windows[0].destroyed, true);
  for (let i = 0; i < 100 && appMessages(h.relay).length === relayApps; i += 1) await h.advance(200);
  assert.ok(appMessages(h.relay).length > relayApps, 'unacked records resume on the relay');
  for (let i = 0; i < 100 && h.phone.messages.length < 1 + bulk; i += 1) {
    await h.phoneReadsRelay();
    await h.advance(200);
  }
  assert.deepEqual(
    h.phone.messages.slice(1).map((message) => message.bulk),
    Array.from({ length: bulk }, (_, i) => i),
    'every bulk message arrives once, in order'
  );
  assert.deepEqual(h.ended, []);
  h.coordinator.close();
  bridge.dispose();
});

// ---------------------------------------------------------------------------
// The daemon ↔ app hop (peer-link.ts): the daemon's stand-in bridge, the JSON
// lane in both directions, the app endpoint and the real peer window.
// ---------------------------------------------------------------------------

async function linkWorld() {
  ({ startRemoteTransportPeerHost } = await import('../../renderer/remote-transport-peer-host/main.ts'));
  const { createRemoteTransportPeerWindow } = await import('./peer-window.ts');
  const json = (value) => JSON.parse(JSON.stringify(value));
  const toApp = [];
  const toDaemon = [];
  const published = [];
  const timers = [];
  const service = createRemoteTransportPeerService({
    publish: (envelope) => {
      published.push(envelope);
      toApp.push(json(envelope));
    },
    schedule: (run) => {
      const timer = { run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  });
  const world = {
    service,
    published,
    windows: 0,
    bridge: null,
    attaches: 0,
    reports: 0,
    /** false: the app process stopped answering (crashed or hung). */
    appAlive: true,
    endpoint: null,
  };
  /** A fresh app process (an endpoint is disposed for good on quit). */
  world.restartApp = () => {
    world.endpoint = makeEndpoint();
  };
  const makeEndpoint = () =>
    createRemoteTransportPeerEndpoint({
      createBridge: () => {
        world.windows += 1;
        world.bridge = createRemoteTransportPeerWindow({
          page: { file: '/app/out/renderer/remote-transport-peer.html' },
        });
        return world.bridge;
      },
      attach: async () => {
        world.attaches += 1;
        return json(service.standIn.attach());
      },
      report: (attachment, report) => {
        world.reports += 1;
        toDaemon.push(['report', attachment, json(report)]);
      },
      detach: (attachment) => toDaemon.push(['detach', attachment]),
    });
  world.endpoint = makeEndpoint();
  /** Carrier bytes still on the daemon → app lane for one connection. */
  world.hopBytes = (connectionId) =>
    toApp
      .filter((envelope) => envelope.command.type === 'send')
      .flatMap((envelope) => envelope.command.items)
      .filter((item) => item.connectionId === connectionId)
      .reduce((sum, item) => sum + Buffer.from(item.data, 'base64').byteLength, 0);
  /** One round over both hops (daemon ↔ app ↔ page). */
  world.pump = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    if (world.appAlive) while (toApp.length) world.endpoint.command(toApp.shift());
    else toApp.length = 0;
    await bridgePump();
    while (toDaemon.length) {
      const [kind, attachment, report] = toDaemon.shift();
      if (kind === 'detach') service.standIn.detach(attachment);
      else service.standIn.report(attachment, report);
    }
  };
  /** Every ack deadline passes (REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS). */
  world.expire = () => {
    for (const timer of timers.splice(0)) if (timer.live) timer.run();
  };
  return world;
}

test('the daemon always has a peer service: a stand-in and a peer host, no configuration', async () => {
  const world = await linkWorld();
  assert.ok(world.service.standIn, 'a stand-in');
  assert.ok(world.service.peerHost, 'a peer host the relay offers the transport with');
});

test('without a peer host sessions are relay-only', async () => {
  const h = await harness({ peerHost: null });
  await h.ready();
  await h.advance(REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS);
  assert.equal(h.coordinator.diagnostics().path, 'relay');
  h.coordinator.close();
});

test('one stand-in and one peer window serve every session of the daemon', async () => {
  bridgeWorld.windows.length = 0;
  bridgeWorld.peers.length = 0;
  const world = await linkWorld();
  await world.endpoint.attach();
  const sessions = [
    await harness({ peerHost: world.service.peerHost }),
    await harness({ peerHost: world.service.peerHost }),
  ];
  for (const h of sessions) {
    await h.ready();
    await h.advance(30);
  }
  for (const h of sessions) {
    await pumpUntil(
      () => h.phone.controls.some(({ control }) => control.t === 'offer'),
      'an offer per session',
      async () => {
        await world.pump();
        await h.phoneReadsRelay();
      }
    );
  }
  assert.equal(world.windows, 1, 'one bridge');
  assert.equal(bridgeWorld.windows.length, 1, 'one hidden window');
  assert.equal(bridgeWorld.peers.length, 2, 'a peer connection per session');
  for (const h of sessions) h.coordinator.close();
  world.endpoint.dispose();
});

test('across the daemon ↔ app hop: no app, the bound end to end, drain, failure, detach, a silent app and reattach', async () => {
  bridgeWorld.windows.length = 0;
  bridgeWorld.peers.length = 0;
  const world = await linkWorld();
  const h = await harness({ peerHost: world.service.peerHost });
  await h.ready();
  await ackAll(h);

  // No app attached: the offer attempt is refused at the stand-in; nothing
  // crosses the lane and the session stays on the relay.
  await h.advance(30);
  await world.pump();
  assert.equal(world.published.length, 0);
  assert.equal(world.windows, 0);
  assert.equal(h.coordinator.diagnostics().path, 'relay');

  // The app attaches: the next offer (one negotiation window later) runs
  // through it, and the window opens only then.
  await world.endpoint.attach();
  assert.equal(world.windows, 0, 'attach opens no window');
  await h.advance(REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS);
  const first = await promoteThroughPage(h, world.pump);
  assert.equal(world.windows, 1);
  const id = first.offer.connectionId;

  // The bound end to end: bytes on the daemon → app lane plus the app's own
  // load (its IPC hop and bufferedAmount) never exceed HIGH, and the
  // stand-in's figure never undercounts them.
  const appLimit = REMOTE_TRANSPORT_BUFFER_HIGH_BYTES - REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES;
  const check = () => {
    const actual = world.hopBytes(id) + world.bridge.queued(id);
    assert.ok(actual <= REMOTE_TRANSPORT_BUFFER_HIGH_BYTES, `end-to-end load ${actual}`);
    assert.ok(world.service.standIn.queued(id) >= actual, 'the stand-in never undercounts');
  };
  // Nothing drains: the channel's bufferedAmount only grows with what it sent.
  let bulk = 0;
  while (h.coordinator.canAdmit() && bulk < 40) {
    await h.coordinator.send({ event: 'bulk', bulk, data: randomBytes(400_000).toString('base64') });
    bulk += 1;
    check();
    await world.pump();
    check();
  }
  for (let i = 0; i < 20; i += 1) {
    await world.pump();
    check();
  }
  assert.ok(world.bridge.queued(id, 'app') > appLimit - 1_100_000, 'the app share is (nearly) full');
  assert.ok(world.bridge.queued(id, 'app') <= appLimit);

  // Control still passes under the full share.
  first.control.receive(await h.phone.control({ v: 1, t: 'ping', id: 91 }, first.lane));
  for (
    let i = 0;
    i < 500 && !h.phone.controls.some(({ control }) => control.t === 'pong' && control.id === 91);
    i += 1
  ) {
    await world.pump();
    check();
    await first.phoneReadsControl();
  }
  assert.ok(
    h.phone.controls.some(({ control }) => control.t === 'pong' && control.id === 91),
    'the pong past bulk'
  );

  // A drain in the page crosses both hops and resumes sending.
  const held = first.app.sent.length;
  first.app.drain(first.app.bufferedAmount);
  await pumpUntil(
    () => first.app.sent.length > held,
    'sending resumed after the drain',
    async () => {
      await world.pump();
      check();
    }
  );

  // A failure in the app (the page reloads) fails the carrier to the relay.
  startBridgePage(bridgeWorld.windows.at(-1));
  await pumpUntil(() => h.coordinator.diagnostics().path === 'relay', 'demotion on a page failure', world.pump);
  for (let i = 0; i < 100 && appMessages(h.relay).length === 0; i += 1) await h.advance(200);
  await ackAll(h);

  // The next offer opens a fresh page; then the app quits (detach).
  await h.advance(REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS);
  await promoteThroughPage(h, world.pump);
  world.endpoint.dispose();
  await world.pump();
  assert.equal(h.coordinator.diagnostics().path, 'relay', 'detach: back to the relay at once');
  assert.equal(h.coordinator.diagnostics().reason, 'peer-host-unavailable');
  const afterQuit = world.published.length;
  await h.advance(REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS);
  await world.pump();
  assert.equal(world.published.length, afterQuit, 'no app: nothing more is sent its way');

  // The app starts again and attaches: the next offer is served. Then it
  // goes silent (a crash): a client release probes it, the probe is never
  // answered, and its carrier fails to the relay.
  world.restartApp();
  await world.endpoint.attach();
  await h.advance(REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS);
  await promoteThroughPage(h, world.pump);
  world.appAlive = false;
  world.service.standIn.clientReleased();
  await world.pump();
  assert.equal(h.coordinator.diagnostics().path, 'direct', 'not before the ack deadline');
  world.expire();
  await world.pump();
  assert.equal(h.coordinator.diagnostics().path, 'relay', 'a silent app fails the carrier');
  assert.equal(h.coordinator.diagnostics().reason, 'peer-host-unavailable');

  // Reattached (the app came back), it serves again.
  world.appAlive = true;
  await world.endpoint.attach();
  await h.advance(REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS);
  await promoteThroughPage(h, world.pump);
  assert.equal(h.coordinator.diagnostics().path, 'direct');
  assert.deepEqual(h.ended, []);
  h.coordinator.close();
  world.endpoint.dispose();
});

/** An app endpoint whose attach operations the test resolves by hand. */
function pendingAttachEndpoint() {
  const pending = [];
  const seen = { creates: 0, detaches: [], reports: 0 };
  const endpoint = createRemoteTransportPeerEndpoint({
    createBridge: () => {
      seen.creates += 1;
      return {
        create: () => true,
        offer() {},
        answer() {},
        candidate() {},
        send: () => true,
        queued: () => 0,
        sample() {},
        close() {},
        onEvent: () => () => {},
        dispose() {},
      };
    },
    attach: () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
    report: () => {
      seen.reports += 1;
    },
    detach: (attachment) => seen.detaches.push(attachment),
  });
  const create = (attachment) => ({
    attachment,
    seq: 1,
    command: { type: 'create', connectionId: 'c1', session: 's', iceServers: [] },
  });
  return { endpoint, pending, seen, create };
}

test('peer endpoint: an attach that resolves after dispose is detached and creates nothing', async () => {
  const { endpoint, pending, seen, create } = pendingAttachEndpoint();
  const attaching = endpoint.attach();
  endpoint.dispose();
  pending[0]('late');
  await attaching;
  assert.deepEqual(seen.detaches, ['late'], 'the late attachment is handed back');
  endpoint.command(create('late'));
  assert.equal(seen.creates, 0, 'no window after dispose');
  assert.equal(seen.reports, 0);
  // Disposed for good: a later attach does nothing.
  await endpoint.attach();
  assert.equal(pending.length, 1, 'no attach operation after dispose');
});

test('peer endpoint: overlapping attaches install only the latest and detach the superseded one', async () => {
  // The older response resolves last.
  {
    const { endpoint, pending, seen, create } = pendingAttachEndpoint();
    const first = endpoint.attach();
    const second = endpoint.attach();
    pending[1]('new');
    await second;
    pending[0]('old');
    await first;
    assert.deepEqual(seen.detaches, ['old']);
    endpoint.command(create('old'));
    assert.equal(seen.creates, 0, 'the superseded attachment drives nothing');
    endpoint.command(create('new'));
    assert.equal(seen.creates, 1, 'the latest attachment is installed');
    endpoint.dispose();
  }
  // The older response resolves first.
  {
    const { endpoint, pending, seen, create } = pendingAttachEndpoint();
    const first = endpoint.attach();
    const second = endpoint.attach();
    pending[0]('old');
    await first;
    pending[1]('new');
    await second;
    assert.deepEqual(seen.detaches, ['old']);
    endpoint.command(create('old'));
    assert.equal(seen.creates, 0);
    endpoint.command(create('new'));
    assert.equal(seen.creates, 1);
    endpoint.dispose();
    assert.deepEqual(seen.detaches, ['old', 'new'], 'quit detaches the installed attachment');
  }
});
