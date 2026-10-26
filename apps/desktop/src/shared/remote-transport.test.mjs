import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  createRelayE2EEClientHandshake,
  generateRelayE2EEServerIdentity,
  relayE2EEPairingMaterial,
  RELAY_E2EE_RELAY_LANE as RELAY,
} from './remote-e2ee';
import {
  REMOTE_TRANSPORT_CHUNK_BYTES,
  REMOTE_TRANSPORT_FUTURE_BUDGET_BYTES,
  REMOTE_TRANSPORT_HEAD_RESERVE_BYTES,
  REMOTE_TRANSPORT_ASSEMBLY_IDLE_MS,
  REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS,
  REMOTE_TRANSPORT_PTO_PROBES,
  REMOTE_TRANSPORT_MAX_ACK_DELAY_MS,
  REMOTE_TRANSPORT_ASSEMBLY_POOL_BYTES,
  REMOTE_TRANSPORT_FRAGMENT_BYTES,
  REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES,
  REMOTE_TRANSPORT_MAX_FRAGMENTS,
  RemoteTransportAssemblyPool,
  remoteTransportPing,
  REMOTE_TRANSPORT_MAX_CONTROL_BOX_BYTES,
  REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES,
  REMOTE_TRANSPORT_MAX_MESSAGE_BYTES,
  REMOTE_TRANSPORT_MAX_OUTSTANDING_BYTES,
  REMOTE_TRANSPORT_MAX_RECORD_BYTES,
  REMOTE_TRANSPORT_MAX_RECORD_PLAINTEXT_BYTES,
  REMOTE_TRANSPORT_RECEIVE_BUDGET_BYTES,
  REMOTE_TRANSPORT_RECORD_EXPIRY_MS,
  REMOTE_TRANSPORT_BULK_OUTSTANDING_BYTES,
  REMOTE_TRANSPORT_BUFFER_LOW_BYTES,
  REMOTE_TRANSPORT_INITIAL_RTT_MS,
  REMOTE_TRANSPORT_MEDIA_CHUNK_MAX_CHARS,
  REMOTE_TRANSPORT_MEDIA_RECORD_MAX_BYTES,
  REMOTE_TRANSPORT_MEDIA_STREAM_CREDIT_BYTES,
  RemoteTransportPathMonitor,
  remoteTransportCarrierFits,
  remoteTransportRepair,
  REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT,
  remoteTransportRecordCharge,
  RemoteTransportMessageAssembler,
  RemoteTransportReceiver,
  RemoteTransportSender,
  decodeRemoteTransportMessage,
  encodeRemoteTransportControl,
  encodeRemoteTransportRecord,
  parseRemoteTransportSignal,
  readRemoteTransportControl,
  readRemoteTransportMedia,
  remoteTransportAck,
  remoteTransportControlBytes,
  splitRemoteTransportPayload,
} from './remote-transport';

/** Control lane of the direct connection `conn-a`, first offered at generation 1. */
const DIRECT_A = { kind: 'direct', epoch: 1, connectionId: 'conn-a' };

async function session() {
  const identity = await generateRelayE2EEServerIdentity();
  const challenge = { ...createRelayE2EEChallenge(), binaryFrames: 1, transportWebrtc: 1 };
  const client = await createRelayE2EEClientHandshake(relayE2EEPairingMaterial(identity), challenge, {
    transportWebrtc: true,
  });
  const server = await acceptRelayE2EEClientHello(identity, challenge, client.hello);
  client.channel.confirmHandshake({ type: 'e2ee-ready', version: 1, ...server.handshakeConfirmation() });
  // The direct connection `conn-a` (offer generation 1) is authorized and current on both ends.
  for (const side of [client.channel, server]) {
    side.registerControlLane(DIRECT_A);
    side.activateControlLane(DIRECT_A);
  }
  return { client: client.channel, server, sessionId: challenge.challenge };
}

/** Feeds carrier messages to a receiver and opens everything that is ready. */
async function pump(receiver, channel, messages, now = 0) {
  const out = [];
  for (const raw of messages) {
    const message = decodeRemoteTransportMessage(raw);
    assert.notEqual(message.kind, 'control');
    receiver.accept(message, now);
    for (let next = receiver.next(); next; next = receiver.next()) {
      try {
        out.push(await channel.decryptJson(next.box));
        receiver.commit(next.sequence, now);
      } catch {
        receiver.discard(next.sequence);
      }
    }
  }
  return out;
}

async function authenticatedAck(from, to, through, ranges = [], lane = RELAY) {
  const opened = await to.openControl(await from.sealControl(remoteTransportAck(through, ranges), lane), lane);
  return readRemoteTransportControl(opened, 'client');
}

async function authenticatedRepair(from, to, sequences, lane = RELAY) {
  const list = Array.isArray(sequences) ? sequences : [sequences];
  const opened = await to.openControl(await from.sealControl(remoteTransportRepair(list), lane), lane);
  return readRemoteTransportControl(opened, 'client');
}

const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(':');
const SDP = `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:sha-256 ${FINGERPRINT}\r\n`;
const ref = (sessionId) => ({ v: 1, sessionId, connectionId: 'conn-0001', generation: 1 });

test('signaling parser: roles, fingerprints bound to the SDP, strict fields', async () => {
  const sessionId = 'A'.repeat(43);
  const fingerprints = [{ algorithm: 'sha-256', value: FINGERPRINT }];
  const offer = parseRemoteTransportSignal({ ...ref(sessionId), t: 'offer', sdp: SDP, fingerprints, iceServers: [{ urls: ['turn:example.org:3478'], username: 'u', credential: 'c' }] }, 'desktop');
  assert.equal(offer.t, 'offer');
  assert.deepEqual(offer.fingerprints, fingerprints);
  assert.throws(() => parseRemoteTransportSignal({ ...ref(sessionId), t: 'offer', sdp: SDP, fingerprints, iceServers: [] }, 'client'), /offer direction/);
  assert.throws(() => parseRemoteTransportSignal({ ...ref(sessionId), t: 'answer', sdp: SDP, fingerprints }, 'desktop'), /answer direction/);
  const other = [{ algorithm: 'sha-256', value: FINGERPRINT.replace(/^10/u, '11') }];
  assert.throws(() => parseRemoteTransportSignal({ ...ref(sessionId), t: 'answer', sdp: SDP, fingerprints: other }, 'client'), /fingerprints/);
  assert.throws(() => parseRemoteTransportSignal({ ...ref(sessionId), t: 'answer', sdp: `${SDP}a=ice-lite\r\n`, fingerprints }, 'client'), /sdp/);
  assert.equal(parseRemoteTransportSignal({ ...ref(sessionId), t: 'candidate', candidate: null }, 'client').candidate, null);
  const line = 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host generation 0';
  assert.equal(parseRemoteTransportSignal({ ...ref(sessionId), t: 'candidate', candidate: { candidate: line, sdpMid: '0' } }, 'desktop').candidate.candidate, line);
  assert.throws(() => parseRemoteTransportSignal({ ...ref(sessionId), t: 'candidate', candidate: { candidate: 'candidate:bad', sdpMid: '0' } }, 'desktop'), /candidate/);
  assert.equal(parseRemoteTransportSignal({ ...ref(sessionId), t: 'close', reason: 'stall' }, 'client').reason, 'stall');
  assert.throws(() => parseRemoteTransportSignal({ ...ref(sessionId), t: 'close', reason: 'nope' }, 'client'), /close reason/);
  assert.throws(() => parseRemoteTransportSignal({ ...ref(sessionId), v: 2, t: 'close', reason: 'stall' }, 'client'), /version/);
  assert.throws(() => parseRemoteTransportSignal({ ...ref('short'), t: 'close', reason: 'stall' }, 'client'), /session id/);
  assert.throws(() => parseRemoteTransportSignal({ ...ref(sessionId), generation: 0, t: 'close', reason: 'stall' }, 'client'), /generation/);
});

test('media adapter parser keeps direction, range and frame bounds', () => {
  const request = { type: 'transport-media', op: 'request', id: 'm1', assetId: 'abcdef12-3456', variant: 'download', range: 'bytes=0-', enc: 'e2ee1' };
  assert.deepEqual(readRemoteTransportMedia(request, 'client'), request);
  assert.throws(() => readRemoteTransportMedia(request, 'desktop'), /media direction/);
  assert.throws(() => readRemoteTransportMedia({ ...request, range: 'bytes=a-b' }, 'client'), /media range/);
  assert.throws(() => readRemoteTransportMedia({ ...request, assetId: '../etc' }, 'client'), /media asset/);
  assert.equal(readRemoteTransportMedia({ type: 'transport-media', op: 'head', id: 'm1', status: 412 }, 'desktop').status, 412);
  assert.throws(() => readRemoteTransportMedia({ type: 'transport-media', op: 'head', id: 'm1', status: 302 }, 'desktop'), /media status/);
  assert.throws(() => readRemoteTransportMedia({ type: 'transport-media', op: 'chunk', id: 'm1', frame: 'A'.repeat(90_000) }, 'desktop'), /media frame/);
  assert.equal(readRemoteTransportMedia({ type: 'transport-media', op: 'cancel', id: 'm1' }, 'client').op, 'cancel');
  assert.equal(readRemoteTransportMedia({ method: 'x' }, 'client'), null);
});

test('framing: small records go whole, large ones chunk under the message bound', async () => {
  const { client } = await session();
  const small = await client.encryptBinary({ a: 1 });
  const [whole] = encodeRemoteTransportRecord(small);
  assert.deepEqual(decodeRemoteTransportMessage(whole), { kind: 'app', sequence: 1, box: small });
  const large = await client.encryptBinary({ blob: 'x'.repeat(3 * REMOTE_TRANSPORT_CHUNK_BYTES) });
  const chunks = encodeRemoteTransportRecord(large);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) assert.ok(chunk.byteLength <= REMOTE_TRANSPORT_MAX_MESSAGE_BYTES);
  const decoded = decodeRemoteTransportMessage(chunks[0]);
  assert.equal(decoded.kind, 'chunk');
  assert.equal(decoded.sequence, 2);
  // Malformed chunk headers.
  const bad = chunks[0].slice();
  new DataView(bad.buffer).setUint32(17, 99, false);
  assert.throws(() => decodeRemoteTransportMessage(bad), /chunk index/);
  const truncated = chunks[0].slice(0, chunks[0].byteLength - 1);
  assert.throws(() => decodeRemoteTransportMessage(truncated), /chunk length/);
  assert.throws(() => decodeRemoteTransportMessage(new Uint8Array(REMOTE_TRANSPORT_MAX_MESSAGE_BYTES + 1)), /message size/);
  assert.throws(() => decodeRemoteTransportMessage(new Uint8Array([1, 2, 3, 4, 5, 6])), /magic/);
  assert.equal(decodeRemoteTransportMessage(encodeRemoteTransportControl(await client.sealControl({ t: 'ping' }, RELAY))).kind, 'control');
});

test('receiver reorders, dedups and reassembles chunks before decryption', async () => {
  const { client, server } = await session();
  const boxes = [];
  for (let i = 1; i <= 4; i += 1) boxes.push(await client.encryptBinary(i === 3 ? { i, big: 'y'.repeat(70_000) } : { i }));
  const messages = boxes.map((box) => encodeRemoteTransportRecord(box));
  const receiver = new RemoteTransportReceiver();
  const flat = [...messages[3], ...messages[2].reverse(), ...messages[1], ...messages[1], ...messages[0]];
  const delivered = await pump(receiver, server, flat);
  assert.deepEqual(delivered.map((value) => value.i), [1, 2, 3, 4]);
  assert.equal(receiver.stats().deliveredThrough, 4);
  assert.equal(receiver.stats().bufferedBytes, 0);
  // A late copy (e.g. from the old carrier) is a duplicate, not a replay error.
  assert.deepEqual(await pump(receiver, server, messages[1]), []);
  assert.ok(receiver.stats().duplicates >= 2);
  assert.equal(receiver.ackDue(0).through, 4, 'a duplicate of a delivered record forces an ack');
});

test('sender retains until an authenticated ack and re-sends only after a carrier switch', async () => {
  const { client, server } = await session();
  const sender = new RemoteTransportSender();
  const receiver = new RemoteTransportReceiver();
  for (let i = 1; i <= 3; i += 1) sender.push(await client.encryptBinary({ i }));
  // Sent on the direct carrier; only #1 arrives before it fails.
  const sent = sender.due(0);
  for (const { sequence } of sent) sender.markSent(sequence, 'direct:a', 0);
  const firstOnly = encodeRemoteTransportRecord(sent[0].box);
  assert.deepEqual((await pump(receiver, server, firstOnly)).map((v) => v.i), [1]);
  assert.equal(sender.carrierFailed('direct:a', 10, 0), 3);
  const again = sender.due(10);
  assert.deepEqual(again.map((r) => r.sequence), [1, 2, 3]);
  for (const { sequence } of again) sender.markSent(sequence, 'relay', 10);
  const viaRelay = again.flatMap((r) => encodeRemoteTransportRecord(r.box));
  // #1 again is a harmless duplicate; #2 and #3 complete the stream.
  assert.deepEqual((await pump(receiver, server, viaRelay, 10)).map((v) => v.i), [2, 3]);
  // And a straggler from the dead direct carrier arrives last.
  assert.deepEqual(await pump(receiver, server, encodeRemoteTransportRecord(sent[1].box), 20), []);
  const ack = receiver.ackDue(20);
  assert.equal(ack.through, 3);
  receiver.ackSent(ack.through);
  assert.equal(sender.acknowledge(await authenticatedAck(server, client, ack.through), 20), 3);
  assert.equal(sender.stats().retainedRecords, 0);
  assert.equal(sender.stats().retransmits, 3);
  assert.equal(sender.expired(10_000_000), false, 'nothing outstanding, nothing expires');
});

test('P1-1: a healthy slow carrier is never re-sent to; expiry counts from the last ack advance', async () => {
  const { client, server } = await session();
  const sender = new RemoteTransportSender();
  for (let i = 1; i <= 4; i += 1) sender.push(await client.encryptBinary({ i, pad: 'x'.repeat(200_000) }));
  for (const { sequence } of sender.due(0)) sender.markSent(sequence, 'direct:slow', 0);
  // Minutes behind a slow queue: nothing is due again, no timer fires.
  for (const now of [1_000, 2_800, 30_000, 59_999]) assert.deepEqual(sender.due(now), []);
  assert.equal(sender.stats().retransmits, 0);
  // Acks keep advancing slowly: never expires.
  assert.equal(sender.acknowledge(await authenticatedAck(server, client, 1), 50_000), 1);
  assert.equal(sender.expired(100_000), false);
  assert.equal(sender.expired(50_000 + REMOTE_TRANSPORT_RECORD_EXPIRY_MS), true);
  // A repair request (the receiver discarded a forged copy) re-sends that one only.
  assert.equal(sender.repair(await authenticatedRepair(server, client, 3)), 1);
  assert.deepEqual(sender.due(60_000).map((r) => r.sequence), [3]);
  assert.throws(() => sender.repair(remoteTransportRepair([3])), /unauthenticated/);
  assert.equal(sender.repair(await authenticatedRepair(server, client, 900)), 0, 'never sent: ignored');
});

test('P1-1: the receiver asks for a repair after a discard or an eviction', async () => {
  const { client, server } = await session();
  const receiver = new RemoteTransportReceiver();
  const first = await client.encryptBinary({ i: 1 });
  const forged = first.slice();
  forged[forged.length - 1] ^= 1;
  await pump(receiver, server, encodeRemoteTransportRecord(forged));
  assert.deepEqual(receiver.repairDue(0), [1], 'a discard is repaired at once');
  assert.deepEqual(receiver.repairDue(0), [], 'and not again before its PTO');
  receiver.accept(decodeRemoteTransportMessage(chunkMessage(2, 1, 3 * REMOTE_TRANSPORT_CHUNK_BYTES)), 0);
  receiver.sweep(REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS);
  // The eviction of #2 is declared at once; one PTO later both are probed.
  const at = REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS;
  assert.deepEqual(receiver.repairDue(at), [2]);
  const pto = new RemoteTransportPathMonitor(0).ptoMs();
  assert.deepEqual(receiver.repairDue(at + pto - 1), []);
  assert.deepEqual(receiver.repairDue(at + pto), [1, 2]);
});

test('repeated discards keep a declared loss’s PTO deadline and backoff', async () => {
  const { client, server } = await session();
  const receiver = new RemoteTransportReceiver();
  const genuine = await client.encryptBinary({ i: 1 });
  const forged = genuine.slice();
  forged[forged.length - 1] ^= 1;
  const rtt = new RemoteTransportPathMonitor(0);
  rtt.rttSample(100);
  const base = rtt.ptoMs();
  await pump(receiver, server, encodeRemoteTransportRecord(forged), 0);
  assert.deepEqual(receiver.repairDue(0, rtt), [1], 'immediate when the recovery state is created');
  // The forger keeps sending bad copies: none of them brings the repair forward.
  for (const now of [10, 50, 200, base - 1]) {
    await pump(receiver, server, encodeRemoteTransportRecord(forged), now);
    assert.deepEqual(receiver.repairDue(now, rtt), [], `no extra repair at ${now}`);
  }
  assert.deepEqual(receiver.repairDue(base, rtt), [1]);
  await pump(receiver, server, encodeRemoteTransportRecord(forged), base + 1);
  assert.deepEqual(receiver.repairDue(base + 2 * base - 1, rtt), [], 'the doubled backoff holds too');
  assert.deepEqual(receiver.repairDue(base + 2 * base, rtt), [1]);
  assert.equal(receiver.stats().discarded, 6);
  assert.deepEqual((await pump(receiver, server, encodeRemoteTransportRecord(genuine), 2_000)).map((v) => v.i), [1]);
});

test('repeated evictions keep a declared loss’s PTO deadline and backoff', () => {
  const receiver = new RemoteTransportReceiver();
  const rtt = new RemoteTransportPathMonitor(0);
  rtt.rttSample(100);
  const base = rtt.ptoMs();
  const rival = (k, now) =>
    receiver.accept(decodeRemoteTransportMessage(chunkMessage(1, 1, (k + 2) * REMOTE_TRANSPORT_CHUNK_BYTES)), now);
  rival(1, 0);
  rival(2, 0);
  rival(3, 0); // the slot cap evicts the least advanced rival
  assert.equal(receiver.stats().evicted, 1);
  assert.deepEqual(receiver.repairDue(0, rtt), [1], 'immediate when the recovery state is created');
  for (let k = 4; k < 10; k += 1) {
    rival(k, k * 10);
    assert.deepEqual(receiver.repairDue(k * 10, rtt), [], `eviction ${k} brings nothing forward`);
  }
  assert.equal(receiver.stats().evicted, 7);
  assert.deepEqual(receiver.repairDue(base, rtt), [1]);
  rival(10, base + 1);
  assert.deepEqual(receiver.repairDue(3 * base - 1, rtt), []);
  assert.deepEqual(receiver.repairDue(3 * base, rtt), [1]);
});

test('repair budget (RFC 9002): one declared repair per sequence, then PTO probes', async () => {
  const initial = new RemoteTransportPathMonitor(0);
  assert.equal(initial.ptoMs(), REMOTE_TRANSPORT_INITIAL_RTT_MS + 4 * (REMOTE_TRANSPORT_INITIAL_RTT_MS / 2) + REMOTE_TRANSPORT_MAX_ACK_DELAY_MS);
  const lossDelay = initial.lossDelayMs();
  assert.equal(lossDelay, (REMOTE_TRANSPORT_INITIAL_RTT_MS * 9) / 8);
  // Packet threshold (§6.1.1): #4 arriving declares #1 at once; #2 and #3
  // wait for the time threshold (§6.1.2).
  const { client, server } = await session();
  const boxes = [];
  for (let i = 1; i <= 4; i += 1) boxes.push(await client.encryptBinary({ i }));
  const receiver = new RemoteTransportReceiver();
  await pump(receiver, server, encodeRemoteTransportRecord(boxes[3]), 0);
  assert.deepEqual(receiver.repairDue(0), [1]);
  assert.deepEqual(receiver.repairDue(Math.ceil(lossDelay) - 1), []);
  assert.deepEqual(receiver.repairDue(Math.ceil(lossDelay)), [2, 3]);
  // Many sequences: each is declared exactly once; afterwards only
  // REMOTE_TRANSPORT_PTO_PROBES per backed-off PTO (§6.2.4).
  const many = new RemoteTransportReceiver();
  many.probe(40, 0);
  assert.deepEqual(many.repairDue(0), []);
  const at = Math.ceil(lossDelay);
  assert.equal(many.repairDue(at).length, 40, 'each declared once');
  let total = 0;
  let requests = 0;
  for (let now = at + 1; now <= at + 60_000; now += 10) {
    const due = many.repairDue(now);
    assert.ok(due.length <= REMOTE_TRANSPORT_PTO_PROBES);
    total += due.length;
    if (due.length) requests += 1;
  }
  // PTO × (1 + 2 + 4 + …) within 60 s: log2(60 000 / PTO + 1) expiries.
  const expiries = Math.floor(Math.log2(60_000 / initial.ptoMs() + 1));
  assert.ok(requests <= expiries + 1 && requests >= expiries - 1, `${requests} PTO expiries`);
  assert.equal(total, requests * REMOTE_TRANSPORT_PTO_PROBES);
});

/** Seals `messages` (control payloads) from `from` in order, sends message i
 *  on lane `relay` (even i) or `direct:a` (odd i), and opens them at `to` in
 *  `order` (indexes): two FIFO lanes may deliver in either order. */
async function controlInOrder(from, to, messages, order) {
  const laneOf = (index) => (index % 2 === 0 ? RELAY : DIRECT_A);
  const boxes = [];
  for (const [index, message] of messages.entries()) boxes.push(await from.sealControl(message, laneOf(index)));
  const out = [];
  for (const index of order) {
    out.push(readRemoteTransportControl(await to.openControl(boxes[index], laneOf(index)), 'client'));
  }
  return out;
}

for (const [label, order] of [
  ['repair first, older ack late', [1, 0]],
  ['older ack first, then repair', [0, 1]],
]) {
  test(`an out-of-order SACK never undoes a repair (${label})`, async () => {
    const { client, server } = await session();
    const sender = new RemoteTransportSender();
    for (let i = 1; i <= 4; i += 1) sender.push(await client.encryptBinary({ i }));
    for (const { sequence } of sender.due(0)) sender.markSent(sequence, 'direct:a', 0);
    // The receiver acked 1 holding #3, THEN discarded #3 and asked for it.
    const [first, second] = await controlInOrder(
      server,
      client,
      [remoteTransportAck(1, [[3, 3]]), remoteTransportRepair([3])],
      order
    );
    for (const message of [first, second]) {
      if (message.t === 'ack') sender.acknowledge(message, 10);
      else assert.equal(sender.repair(message), 1);
    }
    assert.deepEqual(sender.due(10).map((r) => r.sequence), [3], 'the repaired record goes out');
    assert.equal(sender.stats().ackedThrough, 1);
    // The cumulative point only moves forward: an older ack arriving after a
    // newer one changes nothing.
    const [newer, older] = await controlInOrder(server, client, [remoteTransportAck(0), remoteTransportAck(2, [[4, 4]])], [1, 0]);
    assert.equal(newer.through, 2);
    assert.equal(sender.acknowledge(newer, 20), 1);
    assert.equal(sender.acknowledge(older, 20), 0);
    assert.equal(sender.stats().ackedThrough, 2);
    // A selective ack sealed AFTER the repair is current news again.
    sender.markSent(3, 'direct:a', 30);
    sender.carrierFailed('direct:a', 30, 0);
    const [current] = await controlInOrder(server, client, [remoteTransportAck(2, [[3, 4]])], [0]);
    sender.acknowledge(current, 40);
    assert.deepEqual(sender.due(40), [], 'held records are spared');
  });
}

test('a lost whole record is declared by the time threshold, then probed with PTO backoff', async () => {
  const { client, server } = await session();
  const boxes = [];
  for (let i = 1; i <= 3; i += 1) boxes.push(await client.encryptBinary({ i }));
  const receiver = new RemoteTransportReceiver();
  // #2 is lost; #3 reveals the gap (below the packet threshold).
  await pump(receiver, server, [boxes[0], boxes[2]].flatMap((box) => encodeRemoteTransportRecord(box)));
  const rtt = new RemoteTransportPathMonitor(0);
  rtt.rttSample(100);
  const wait = Math.ceil(rtt.lossDelayMs());
  assert.deepEqual(receiver.repairDue(0, rtt), [], 'time threshold first');
  assert.deepEqual(receiver.repairDue(wait - 1, rtt), []);
  assert.deepEqual(receiver.repairDue(wait, rtt), [2]);
  let at = wait;
  for (let round = 0; round < 8; round += 1) {
    const timeout = rtt.ptoMs() * 2 ** round;
    assert.deepEqual(receiver.repairDue(at + timeout - 1, rtt), [], `PTO ${round} not yet`);
    at += timeout;
    assert.deepEqual(receiver.repairDue(at, rtt), [2], `PTO ${round} probes`);
  }
  // Progress resumes: nothing more is asked.
  assert.deepEqual((await pump(receiver, server, encodeRemoteTransportRecord(boxes[1]), at)).map((v) => v.i), [2, 3]);
  assert.deepEqual(receiver.repairDue(at + 600_000, rtt), []);
});

test('a lost FINAL record is found through the authenticated ping.sent probe', async () => {
  const { client, server } = await session();
  const sender = new RemoteTransportSender();
  const receiver = new RemoteTransportReceiver();
  const boxes = [];
  for (let i = 1; i <= 3; i += 1) {
    const box = await client.encryptBinary({ i });
    boxes.push(box);
    sender.push(box);
  }
  for (const { sequence } of sender.due(0)) sender.markSent(sequence, 'direct:a', 0);
  // #3, the last one, is lost: no later record can reveal it.
  await pump(receiver, server, [boxes[0], boxes[1]].flatMap((box) => encodeRemoteTransportRecord(box)));
  assert.deepEqual(receiver.repairDue(10_000), []);
  // Only bytes that have left the queue count: with #3 still queued, 2.
  assert.equal(sender.probeThrough('direct:a', boxes[2].byteLength), 2);
  assert.equal(sender.probeThrough('direct:a', 0), 3);
  const opened = await server.openControl(await client.sealControl(remoteTransportPing(1, sender.probeThrough('direct:a', 0)), DIRECT_A), DIRECT_A);
  const ping = readRemoteTransportControl(opened, 'desktop');
  assert.equal(ping.sent, 3);
  receiver.probe(ping.sent, 20_000);
  const wait = Math.ceil((REMOTE_TRANSPORT_INITIAL_RTT_MS * 9) / 8);
  assert.deepEqual(receiver.repairDue(20_000), []);
  const due = receiver.repairDue(20_000 + wait);
  assert.deepEqual(due, [3]);
  assert.equal(sender.repair(await authenticatedRepair(server, client, due)), 1);
  const again = sender.due(20_000 + wait);
  assert.deepEqual(again.map((r) => r.sequence), [3]);
  assert.deepEqual((await pump(receiver, server, encodeRemoteTransportRecord(again[0].box))).map((v) => v.i), [3]);
  assert.deepEqual(receiver.repairDue(100_000), []);
  // A probe is strictly validated.
  assert.throws(() => readRemoteTransportControl({ stale: false, sequence: 9, value: { v: 1, t: 'ping', id: 1, sent: -1 } }, 'desktop'), /ping sent/);
  // The sender's PTO (§6.2.1) says when to send that probe ping: after one
  // PTO without a send or an ack, doubling per expiry, reset by an ack.
  const probing = new RemoteTransportSender();
  probing.push(await (await session()).client.encryptBinary({ tail: 1 }));
  probing.markSent(1, 'direct:a', 0);
  const pto = new RemoteTransportPathMonitor(0).ptoMs();
  assert.equal(probing.probeDue(pto - 1, pto), false);
  assert.equal(probing.probeDue(pto, pto), true);
  assert.equal(probing.probeDue(pto + 2 * pto - 1, pto), false);
  assert.equal(probing.probeDue(pto + 2 * pto, pto), true);
});

test('an empty queue is not drain progress: pongs over a stuck ack report no-progress at the 6 s application-progress bound', () => {
  const path = new RemoteTransportPathMonitor(0);
  const stall = REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS;
  // Idle for a long time with pongs: the old ack/drain time must not count
  // against work that becomes outstanding later.
  for (let now = 0; now <= 100_000; now += 2_000) {
    path.inbound(now);
    path.buffered(0, now);
    assert.equal(path.stalled(now, 0), null);
  }
  path.outstanding(4096, 100_000);
  for (let now = 100_000; now < 100_000 + stall; now += 250) {
    path.inbound(now);
    path.buffered(0, now);
    assert.equal(path.stalled(now, 4096), null, `not yet at ${now}`);
  }
  const at = 100_000 + stall;
  path.inbound(at);
  path.buffered(0, at);
  assert.equal(path.stalled(at, 4096), 'no-progress');
  // An actual decrease, or an ack advance, is progress.
  const draining = new RemoteTransportPathMonitor(0);
  draining.outstanding(4096, 0);
  draining.buffered(10_000, 0);
  draining.buffered(5_000, stall - 1);
  draining.inbound(stall);
  assert.equal(draining.stalled(stall, 4096), null, 'drained just before');
  draining.ackAdvanced(2 * stall - 2);
  draining.inbound(2 * stall);
  assert.equal(draining.stalled(2 * stall, 4096), null, 'acked just before');
  draining.inbound(3 * stall - 2);
  assert.equal(draining.stalled(3 * stall - 2, 4096), 'no-progress');
});

/** A hand-built fragment of `count` × REMOTE_TRANSPORT_FRAGMENT_BYTES. */
function fragment(index, count, id = 1) {
  const data = 'A'.repeat(Math.ceil((REMOTE_TRANSPORT_FRAGMENT_BYTES * 4) / 3));
  return { type: 'transport-fragment', id, index, count, data };
}

test('large-message assembly: relay-equal size cap, one per session, a process-wide pool', () => {
  assert.equal(REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES, 64 * 1024 * 1024, 'the relay frame ceiling, both ways');
  assert.equal(REMOTE_TRANSPORT_ASSEMBLY_POOL_BYTES, (64 + 8) * 1024 * 1024);
  const fit = REMOTE_TRANSPORT_MAX_FRAGMENTS;
  assert.equal(fit, Math.ceil(REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES / REMOTE_TRANSPORT_FRAGMENT_BYTES));
  // Desktop → phone keeps parity: a 9 MiB view frame is split, not refused.
  const nine = 9 * 1024 * 1024 + 2;
  assert.equal(splitRemoteTransportPayload('x'.repeat(9 * 1024 * 1024), 1).length, Math.ceil(nine / REMOTE_TRANSPORT_FRAGMENT_BYTES));
  assert.throws(() => splitRemoteTransportPayload('x'.repeat(REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES), 1), /message size/);
  const pool = new RemoteTransportAssemblyPool();
  // More fragments than a maximal message is refused before anything is kept.
  const over = new RemoteTransportMessageAssembler(pool);
  assert.throws(() => over.accept(fragment(0, fit + 1), 0), /fragment count/);
  assert.equal(pool.usedBytes(), 0);
  // An empty pool always admits one maximal message; its declared size is reserved.
  const maximal = fit * REMOTE_TRANSPORT_FRAGMENT_BYTES;
  const first = new RemoteTransportMessageAssembler(pool);
  assert.deepEqual(first.accept(fragment(0, fit), 0), { state: 'partial' });
  assert.equal(first.reservedBytes(), maximal);
  // One large message per session: a second one cannot start beside it.
  assert.throws(() => first.accept(fragment(0, 2, 2), 1), /fragment order/);
  assert.equal(pool.usedBytes(), 0, 'the failure freed the reservation');
  const again = new RemoteTransportMessageAssembler(pool);
  assert.deepEqual(again.accept(fragment(0, fit), 0), { state: 'partial' });
  // Another session's large message fits only in what the pool has left…
  const room = Math.floor((REMOTE_TRANSPORT_ASSEMBLY_POOL_BYTES - maximal) / REMOTE_TRANSPORT_FRAGMENT_BYTES);
  assert.ok(room >= 2);
  const second = new RemoteTransportMessageAssembler(pool);
  assert.deepEqual(second.accept(fragment(0, room), 0), { state: 'partial' });
  // …and beyond that it waits, keeping nothing.
  const third = new RemoteTransportMessageAssembler(pool);
  assert.deepEqual(third.accept(fragment(0, 2), 0), { state: 'wait' });
  assert.equal(third.pendingBytes(), 0);
  // A stalled assembly ends its session; `close` frees the pool, and the
  // waiting payload is admitted when offered again.
  assert.equal(again.stalled(REMOTE_TRANSPORT_ASSEMBLY_IDLE_MS - 1), false);
  assert.equal(again.stalled(REMOTE_TRANSPORT_ASSEMBLY_IDLE_MS), true);
  again.close();
  assert.deepEqual(third.accept(fragment(0, 2), 10), { state: 'partial' });
  assert.equal(pool.usedBytes(), (room + 2) * REMOTE_TRANSPORT_FRAGMENT_BYTES);
});

test('P1-2: no demotion while the link makes progress; stall only when progress stops', () => {
  const path = new RemoteTransportPathMonitor(0);
  // A slow uplink: no ack advance for 20 s, but the queue drains and pongs arrive.
  for (let now = 0; now <= 20_000; now += 1_000) {
    path.buffered(4 * 1024 * 1024 - now * 100, now);
    if (now % 2_000 === 0) path.inbound(now);
    assert.equal(path.stalled(now, 7 * 1024 * 1024), null, `healthy at ${now}`);
  }
  // Pongs keep coming but the queue is frozen and no ack moves.
  const frozen = new RemoteTransportPathMonitor(0);
  frozen.outstanding(1, 0);
  frozen.buffered(1_000_000, 0);
  for (let now = 0; now < REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS; now += 1_000) {
    frozen.inbound(now);
    frozen.buffered(1_000_000, now);
  }
  frozen.inbound(REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS);
  assert.equal(frozen.stalled(REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS, 1), 'no-progress');
  assert.equal(frozen.stalled(REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS, 0), null, 'nothing outstanding is not a stall');
  // Silence.
  const silent = new RemoteTransportPathMonitor(0);
  assert.equal(silent.stalled(REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS - 1, 0), null);
  assert.equal(silent.stalled(REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS, 0), 'silent');
});

test('P2-1: resume point at a carrier switch de-duplicates re-sends', async () => {
  const { client, server } = await session();
  const sender = new RemoteTransportSender();
  const receiver = new RemoteTransportReceiver();
  const boxes = [];
  for (let i = 1; i <= 6; i += 1) {
    const box = await client.encryptBinary({ i });
    boxes.push(box);
    sender.push(box);
  }
  for (const { sequence } of sender.due(0)) sender.markSent(sequence, 'direct:a', 0);
  // Over direct, #1, #2 arrived and #4, #5 are held (#3 and #6 lost with the path).
  await pump(receiver, server, [1, 2, 4, 5].flatMap((n) => encodeRemoteTransportRecord(boxes[n - 1])));
  sender.carrierFailed('direct:a', 100, 500);
  assert.deepEqual(sender.due(100), [], 'held for about one RTT');
  receiver.carrierChanged(100);
  const resume = receiver.ackDue(100);
  assert.deepEqual(resume, { through: 2, ranges: [[4, 5]] });
  assert.equal(sender.acknowledge(await authenticatedAck(server, client, resume.through, resume.ranges), 150), 2);
  assert.deepEqual(sender.due(150).map((r) => r.sequence), [3, 6], 'only what lies above and outside the ranges');
  // Without a resume ack, the hold lapses and everything outstanding goes.
  const fresh = await session();
  const other = new RemoteTransportSender();
  for (let i = 1; i <= 3; i += 1) other.push(await fresh.client.encryptBinary({ j: i }));
  for (const { sequence } of other.due(0)) other.markSent(sequence, 'direct:b', 0);
  other.carrierFailed('direct:b', 0, 400);
  assert.deepEqual(other.due(399), []);
  assert.deepEqual(other.due(400).map((r) => r.sequence), [1, 2, 3]);
  // Relay backpressure: only what the carrier has room for.
  const first = other.due(400, 1);
  assert.equal(first.length, 1);
  // Ranges are hints: they never release a buffer.
  assert.equal(sender.stats().retainedRecords, 4);
});

test('P2-2: RFC 9002 RTT estimator, PTO and idle timeout; state resets on carrier change', () => {
  const path = new RemoteTransportPathMonitor(0);
  const initialPto = REMOTE_TRANSPORT_INITIAL_RTT_MS + 4 * (REMOTE_TRANSPORT_INITIAL_RTT_MS / 2) + REMOTE_TRANSPORT_MAX_ACK_DELAY_MS;
  assert.equal(path.ptoMs(), initialPto, '§6.2.2 initial values in the §6.2.1 formula');
  path.rttSample(40);
  assert.equal(path.smoothedRttMs(), 40, '§5.3 first sample');
  assert.equal(path.ptoMs(), 40 + 80 + REMOTE_TRANSPORT_MAX_ACK_DELAY_MS);
  path.rttSample(80);
  // rttvar = 3/4 × 20 + 1/4 × |40 − 80| = 25; smoothed = 7/8 × 40 + 1/8 × 80 = 45.
  assert.equal(path.smoothedRttMs(), 45);
  assert.equal(path.ptoMs(), 45 + 100 + REMOTE_TRANSPORT_MAX_ACK_DELAY_MS);
  assert.equal(path.lossDelayMs(), (9 / 8) * 80, '§6.1.2 uses max(smoothed_rtt, latest_rtt)');
  assert.equal(path.idleTimeoutMs(), REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS, 'max(max_idle_timeout, 3 × PTO)');
  const slow = new RemoteTransportPathMonitor(0);
  slow.rttSample(3_000);
  assert.equal(slow.idleTimeoutMs(), 3 * slow.ptoMs(), 'RFC 9000 §10.1 floor of three PTOs');
  path.reset(1_000);
  assert.equal(path.ptoMs(), initialPto, 'RFC 9000 §9.4: a new path starts fresh');
});

test('P2-3: bulk never starves RPCs; each media stream has its own credit', async () => {
  const { client } = await session();
  const sender = new RemoteTransportSender();
  const frame = 'f'.repeat(REMOTE_TRANSPORT_MEDIA_CHUNK_MAX_CHARS);
  const media = (stream) => client.encryptBinary({ type: 'transport-media', op: 'chunk', id: stream, frame });
  // Above the low-water mark, bulk waits while an RPC is still admitted.
  assert.equal(sender.canAdmit({ stream: 'a', bufferedAmount: REMOTE_TRANSPORT_BUFFER_LOW_BYTES + 1 }), false);
  assert.equal(sender.canAdmit({ bufferedAmount: REMOTE_TRANSPORT_BUFFER_LOW_BYTES + 1 }), true);
  // Stream `a` fills its credit; stream `b` still goes.
  let sentA = 0;
  while (sender.canAdmit({ stream: 'a' })) {
    sender.push(await media('a'), { stream: 'a' });
    sentA += 1;
  }
  assert.ok(sentA >= 2 && sentA * REMOTE_TRANSPORT_MEDIA_RECORD_MAX_BYTES <= REMOTE_TRANSPORT_MEDIA_STREAM_CREDIT_BYTES);
  assert.equal(sender.canAdmit({ stream: 'b' }), true);
  // Many streams together stop at the bulk share; RPC records still fit.
  for (let stream = 0; stream < 32; stream += 1) {
    while (sender.canAdmit({ stream: `s${stream}` })) sender.push(await media(`s${stream}`), { stream: `s${stream}` });
  }
  assert.ok(sender.stats().bulkBytes <= REMOTE_TRANSPORT_BULK_OUTSTANDING_BYTES);
  assert.equal(sender.canAdmit(), true, 'the other half of the window is left for RPC and state');
  // Pushing past a stream's credit is refused (last: the sealed box is a hole).
  await assert.rejects(async () => sender.push(await media('a'), { stream: 'a' }), /bulk credit/);
});

test('P2-4: a carrier is promotable only if its SCTP max message size takes our largest message', () => {
  assert.equal(remoteTransportCarrierFits(Number.POSITIVE_INFINITY), true);
  assert.equal(remoteTransportCarrierFits(262_144), true);
  assert.equal(remoteTransportCarrierFits(65_536), true, 'RFC 8841 default');
  assert.equal(remoteTransportCarrierFits(REMOTE_TRANSPORT_MAX_MESSAGE_BYTES - 1), false);
  assert.equal(remoteTransportCarrierFits(null), false);
});

test('forged, unauthenticated or impossible acks never release buffers', async () => {
  const { client, server } = await session();
  const sender = new RemoteTransportSender();
  sender.push(await client.encryptBinary({ i: 1 }));
  sender.markSent(1, 'relay', 0);
  // A relay-built cleartext ack of the right shape.
  assert.throws(() => sender.acknowledge({ v: 1, t: 'ack', through: 1 }, 0), /unauthenticated/);
  // A forged control box fails authentication.
  const box = await server.sealControl(remoteTransportAck(1), RELAY);
  box[box.length - 1] ^= 1;
  await assert.rejects(() => client.openControl(box, RELAY));
  // The client's OWN ack reflected back to it: wrong direction key.
  await assert.rejects(async () => client.openControl(await client.sealControl(remoteTransportAck(1), RELAY), RELAY));
  // An authenticated ack for something never sent is a protocol violation.
  assert.throws(() => sender.acknowledge(readRemoteTransportControl({ stale: false, sequence: 1, value: remoteTransportAck(5) }, 'client'), 0), /beyond sent/);
  // Selective ranges beyond what was sent, or malformed, are refused as well.
  assert.throws(() => sender.acknowledge(readRemoteTransportControl({ stale: false, sequence: 2, value: remoteTransportAck(0, [[3, 4]]) }, 'client'), 0), /beyond sent/);
  assert.throws(() => readRemoteTransportControl({ stale: false, sequence: 3, value: { v: 1, t: 'ack', through: 2, ranges: [[2, 3]] } }, 'client'), /ack range/);
  assert.throws(() => readRemoteTransportControl({ stale: false, sequence: 4, value: { v: 1, t: 'ack', through: 0, ranges: [[3, 4], [4, 5]] } }, 'client'), /ack range/);
  // A stale copy reads as nothing.
  assert.equal(readRemoteTransportControl({ stale: true, sequence: 1 }, 'client'), null);
  assert.equal(sender.stats().retainedRecords, 1);
  assert.equal(sender.acknowledge(await authenticatedAck(server, client, 1), 0), 1);
});

test('sender refuses a sequence hole; refusals before sealing leave the next sequence unchanged', async () => {
  const { client } = await session();
  const sender = new RemoteTransportSender();
  await client.encryptBinary({ skipped: true });
  await assert.rejects(async () => sender.push(await client.encryptBinary({ i: 2 })), /expected 1/);

  const fresh = await session();
  const ordered = new RemoteTransportSender();
  // A body over the record cap is refused by the channel before a sequence is
  // assigned; an over-large message is refused by the splitter before sealing.
  await assert.rejects(
    () => fresh.client.encryptBinary({ big: 'z'.repeat(REMOTE_TRANSPORT_MAX_RECORD_PLAINTEXT_BYTES) }),
    /exceeds/
  );
  assert.throws(
    () => splitRemoteTransportPayload('x'.repeat(REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES), 1),
    /message size/
  );
  assert.equal(ordered.nextSequence(), 1);
  assert.equal(ordered.push(await fresh.client.encryptBinary({ i: 1 })), 1);
  assert.equal(ordered.nextSequence(), 2);
});

test('sender window reserves a maximal record and never exceeds the receiver future budget', async () => {
  const { client } = await session();
  const sender = new RemoteTransportSender();
  const body = { big: 'z'.repeat(REMOTE_TRANSPORT_MAX_RECORD_PLAINTEXT_BYTES - 20) };
  let pushed = 0;
  while (sender.canAdmit()) {
    sender.push(await client.encryptBinary(body));
    pushed += 1;
  }
  assert.ok(pushed >= 1);
  const { outstandingBytes } = sender.stats();
  assert.ok(outstandingBytes <= REMOTE_TRANSPORT_MAX_OUTSTANDING_BYTES);
  assert.ok(outstandingBytes + REMOTE_TRANSPORT_MAX_RECORD_BYTES > REMOTE_TRANSPORT_MAX_OUTSTANDING_BYTES);
  assert.equal(REMOTE_TRANSPORT_MAX_OUTSTANDING_BYTES, REMOTE_TRANSPORT_FUTURE_BUDGET_BYTES);
  assert.equal(
    REMOTE_TRANSPORT_HEAD_RESERVE_BYTES + REMOTE_TRANSPORT_FUTURE_BUDGET_BYTES,
    REMOTE_TRANSPORT_RECEIVE_BUDGET_BYTES
  );
  await assert.rejects(async () => sender.push(await client.encryptBinary(body)), /sender window/);
});

/** A chunk message built by hand (what a relay could inject). */
function chunkMessage(sequence, index, total, fill = 0x41) {
  const count = Math.ceil(total / REMOTE_TRANSPORT_CHUNK_BYTES);
  const length = index === count - 1 ? total - index * REMOTE_TRANSPORT_CHUNK_BYTES : REMOTE_TRANSPORT_CHUNK_BYTES;
  const out = new Uint8Array(25 + length);
  out.set([0x4d, 0x58, 0x54, 0x01, 2], 0);
  const view = new DataView(out.buffer);
  view.setBigUint64(5, BigInt(sequence), false);
  view.setUint32(13, index, false);
  view.setUint32(17, count, false);
  view.setUint32(21, total, false);
  out.fill(fill, 25);
  return out;
}

/** Re-labels every chunk of a genuine record with another outer sequence. */
function relabel(messages, sequence) {
  return messages.map((message) => {
    const copy = message.slice();
    new DataView(copy.buffer).setBigUint64(5, BigInt(sequence), false);
    return copy;
  });
}

test('a genuine box is only ever exposed under its own sequence (relabeled chunks)', async () => {
  const { client, server } = await session();
  const receiver = new RemoteTransportReceiver();
  const first = await client.encryptBinary({ i: 1 });
  const second = await client.encryptBinary({ i: 2, pad: 'p'.repeat(3 * REMOTE_TRANSPORT_CHUNK_BYTES) });
  const chunks = encodeRemoteTransportRecord(second);
  assert.ok(chunks.length > 1);
  // Seq 2's genuine chunks presented as seq 1: chunk 0 is refused, the rest
  // can never complete, nothing is opened, nothing is acked.
  const results = relabel(chunks, 1).map((raw) => receiver.accept(decodeRemoteTransportMessage(raw), 0));
  assert.equal(results[0], 'mismatch');
  assert.equal(receiver.next(), null);
  assert.equal(receiver.ackDue(10_000), null);
  // A whole box cannot be relabeled at all: its sequence IS its header.
  const whole = encodeRemoteTransportRecord(first)[0].slice();
  new DataView(whole.buffer).setBigUint64(9, 2n, false);
  assert.equal(decodeRemoteTransportMessage(whole).sequence, 2);
  // The genuine records still arrive in order.
  const delivered = await pump(receiver, server, [...encodeRemoteTransportRecord(first), ...chunks]);
  assert.deepEqual(delivered.map((v) => v.i), [1, 2]);
  assert.equal(receiver.stats().deliveredThrough, 2);
});

test('forged geometry and forged parts never poison a slot', async () => {
  const { client, server } = await session();
  const receiver = new RemoteTransportReceiver();
  const genuine = await client.encryptBinary({ i: 1, pad: 'g'.repeat(2 * REMOTE_TRANSPORT_CHUNK_BYTES) });
  const chunks = encodeRemoteTransportRecord(genuine);
  const total = genuine.byteLength;
  // A rival geometry first: it assembles beside the genuine one.
  assert.equal(receiver.accept(decodeRemoteTransportMessage(chunkMessage(1, 1, total + REMOTE_TRANSPORT_CHUNK_BYTES)), 0), 'buffered');
  assert.deepEqual((await pump(receiver, server, chunks)).map((v) => v.i), [1]);

  // Same geometry, forged part first: the assembly completes, fails to open,
  // is discarded, and the retransmission refills it.
  const next = await client.encryptBinary({ i: 2, pad: 'h'.repeat(2 * REMOTE_TRANSPORT_CHUNK_BYTES) });
  const nextChunks = encodeRemoteTransportRecord(next);
  assert.equal(receiver.accept(decodeRemoteTransportMessage(chunkMessage(2, 1, next.byteLength)), 0), 'buffered');
  assert.deepEqual(await pump(receiver, server, nextChunks), []);
  assert.equal(receiver.stats().discarded, 1);
  assert.deepEqual((await pump(receiver, server, nextChunks)).map((v) => v.i), [2]);

  // Rivals beyond the per-slot cap evict the least advanced; an assembly that
  // stops progressing is swept, and the slot recovers from retransmission.
  const third = await client.encryptBinary({ i: 3, pad: 'k'.repeat(2 * REMOTE_TRANSPORT_CHUNK_BYTES) });
  const thirdChunks = encodeRemoteTransportRecord(third);
  for (let rival = 1; rival <= 4; rival += 1) {
    receiver.accept(decodeRemoteTransportMessage(chunkMessage(3, 1, third.byteLength + rival * REMOTE_TRANSPORT_CHUNK_BYTES)), 0);
  }
  assert.ok(receiver.stats().evicted >= 2);
  // Only part of the genuine record arrives, then everything stalls.
  receiver.accept(decodeRemoteTransportMessage(thirdChunks[1]), 0);
  assert.ok(receiver.sweep(REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS) >= 2);
  assert.equal(receiver.stats().bufferedBytes, 0);
  assert.deepEqual((await pump(receiver, server, thirdChunks, REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS)).map((v) => v.i), [3]);
});

test('future forged records cannot saturate the budget and starve the head record', async () => {
  const { client, server } = await session();
  const receiver = new RemoteTransportReceiver();
  // Fill the future region with forged maximal assemblies until refused.
  let accepted = 0;
  let sequence = 2;
  for (; sequence < 64; sequence += 1) {
    const result = receiver.accept(decodeRemoteTransportMessage(chunkMessage(sequence, 1, REMOTE_TRANSPORT_MAX_RECORD_BYTES)), 0);
    if (result === 'over-memory') break;
    assert.equal(result, 'buffered');
    accepted += 1;
  }
  assert.ok(accepted >= 1 && sequence < 64, 'the future budget refuses past its bound');
  assert.ok(receiver.stats().futureBytes <= REMOTE_TRANSPORT_FUTURE_BUDGET_BYTES);
  // The head slot still takes a forged rival AND the genuine maximal record.
  const head = await client.encryptBinary({ i: 1, pad: 'm'.repeat(REMOTE_TRANSPORT_MAX_RECORD_PLAINTEXT_BYTES - 30) });
  assert.ok(head.byteLength > REMOTE_TRANSPORT_MAX_RECORD_BYTES - 64);
  assert.equal(receiver.accept(decodeRemoteTransportMessage(chunkMessage(1, 1, REMOTE_TRANSPORT_MAX_RECORD_BYTES)), 0), 'buffered');
  assert.deepEqual((await pump(receiver, server, encodeRemoteTransportRecord(head))).map((v) => v.i), [1]);
  const stats = receiver.stats();
  assert.ok(stats.bufferedBytes <= REMOTE_TRANSPORT_RECEIVE_BUDGET_BYTES);
});

test('byte-only window: every record is charged one carrier message, so tiny forged records are bounded', async () => {
  assert.equal(REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT, Math.floor(REMOTE_TRANSPORT_MAX_OUTSTANDING_BYTES / REMOTE_TRANSPORT_MAX_MESSAGE_BYTES));
  assert.equal(REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT, 128);
  const { client } = await session();
  const tiny = await client.encryptBinary({});
  assert.ok(tiny.byteLength < 100);
  assert.equal(remoteTransportRecordCharge(tiny.byteLength), REMOTE_TRANSPORT_MAX_MESSAGE_BYTES);
  // A relay floods forged tiny records at every sequence it can name.
  const receiver = new RemoteTransportReceiver();
  const results = { buffered: 0, 'over-memory': 0, 'out-of-window': 0 };
  for (let sequence = 2; sequence <= 4 * REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT; sequence += 1) {
    const forged = tiny.slice();
    new DataView(forged.buffer).setBigUint64(4, BigInt(sequence), false);
    results[receiver.accept(decodeRemoteTransportMessage(encodeRemoteTransportRecord(forged)[0]), 0)] += 1;
  }
  const { bufferedRecords, futureBytes } = receiver.stats();
  assert.equal(bufferedRecords, results.buffered);
  assert.ok(bufferedRecords < REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT, 'the span is the window over the charge');
  assert.equal(futureBytes, bufferedRecords * REMOTE_TRANSPORT_MAX_MESSAGE_BYTES, 'charged, not their real ~60 bytes');
  assert.ok(futureBytes <= REMOTE_TRANSPORT_FUTURE_BUDGET_BYTES);
  assert.ok(results['out-of-window'] >= 3 * REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT);
  // The sender is held to the same charge: tiny records fill the window by count.
  const fresh = await session();
  const sender = new RemoteTransportSender();
  let pushed = 0;
  while (sender.canAdmit()) {
    sender.push(await fresh.client.encryptBinary({}));
    pushed += 1;
  }
  assert.ok(pushed <= REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT);
  assert.equal(sender.stats().outstandingBytes, pushed * REMOTE_TRANSPORT_MAX_MESSAGE_BYTES);
});

test('receiver window cap; a forged whole record is vacated and refilled', async () => {
  const { client, server } = await session();
  const receiver = new RemoteTransportReceiver();
  const first = await client.encryptBinary({ i: 1 });
  const future = first.slice();
  new DataView(future.buffer).setBigUint64(4, BigInt(REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT + 1), false);
  assert.equal(receiver.accept(decodeRemoteTransportMessage(encodeRemoteTransportRecord(future)[0]), 0), 'out-of-window');
  const forged = first.slice();
  forged[forged.length - 1] ^= 1;
  assert.deepEqual(await pump(receiver, server, encodeRemoteTransportRecord(forged)), []);
  assert.equal(receiver.stats().discarded, 1);
  assert.equal(receiver.ackDue(1_000), null, 'nothing authenticated, nothing acked');
  assert.deepEqual((await pump(receiver, server, encodeRemoteTransportRecord(first))).map((v) => v.i), [1]);
});

test('payloads above one record are split above the record layer and reassembled in order', async () => {
  const { client, server } = await session();
  const sender = new RemoteTransportSender();
  const receiver = new RemoteTransportReceiver();
  const pool = new RemoteTransportAssemblyPool();
  const assembler = new RemoteTransportMessageAssembler(pool);
  const big = { method: 'upload', data: 'é'.repeat(REMOTE_TRANSPORT_MAX_RECORD_PLAINTEXT_BYTES) };
  const parts = splitRemoteTransportPayload(big, 7);
  assert.ok(parts.length >= 3);
  assert.deepEqual(splitRemoteTransportPayload({ small: true }, 8), [{ small: true }]);
  const delivered = [];
  for (const part of [...parts, { after: true }]) {
    const box = await client.encryptBinary(part);
    assert.ok(box.byteLength <= REMOTE_TRANSPORT_MAX_RECORD_BYTES);
    sender.push(box);
    for (const value of await pump(receiver, server, encodeRemoteTransportRecord(box))) {
      const message = assembler.accept(value, 0);
      if (message.state === 'complete') delivered.push(message.payload);
    }
  }
  assert.deepEqual(delivered, [big, { after: true }]);
  assert.equal(assembler.pendingBytes(), 0);
  assert.equal(assembler.reservedBytes(), 0);
  assert.equal(pool.usedBytes(), 0);
  // Interleaving and gaps are protocol errors, and free the pool.
  const strict = new RemoteTransportMessageAssembler(pool);
  strict.accept(parts[0], 0);
  assert.throws(() => strict.accept({ other: 1 }, 0), /interleaved/);
  strict.close();
  const gap = new RemoteTransportMessageAssembler(pool);
  gap.accept(parts[0], 0);
  assert.throws(() => gap.accept(parts[2], 0), /fragment order/);
  assert.equal(pool.usedBytes(), 0);
});

test('control boundary: the largest valid signal fills one carrier message exactly', async () => {
  const { client, server, sessionId } = await session();
  const hex = (bytes, seed) => Array.from({ length: bytes }, (_, i) => ((i + seed) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
  const fingerprints = [
    { algorithm: 'sha-256', value: hex(32, 1) },
    { algorithm: 'sha-384', value: hex(48, 2) },
    { algorithm: 'sha-512', value: hex(64, 3) },
  ];
  const iceServers = [
    { urls: ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:5349'], username: `1700000000:${'u'.repeat(40)}`, credential: 'c'.repeat(44) },
  ];
  const offer = (pad) => ({
    ...ref(sessionId),
    t: 'offer',
    sdp: `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n${fingerprints.map((f) => `a=fingerprint:${f.algorithm} ${f.value}\r\n`).join('')}a=x-pad:${'p'.repeat(pad)}\r\n`,
    fingerprints,
    iceServers,
  });
  const base = remoteTransportControlBytes(parseRemoteTransportSignal(offer(0), 'desktop'));
  const pad = REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES - base;
  assert.ok(pad > 0);
  const largest = parseRemoteTransportSignal(offer(pad), 'desktop');
  assert.equal(remoteTransportControlBytes(largest), REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES);
  const box = await server.sealControl(largest, RELAY);
  assert.equal(box.byteLength, REMOTE_TRANSPORT_MAX_CONTROL_BOX_BYTES);
  const message = encodeRemoteTransportControl(box);
  assert.equal(message.byteLength, REMOTE_TRANSPORT_MAX_MESSAGE_BYTES);
  const decoded = decodeRemoteTransportMessage(message);
  const reread = readRemoteTransportControl(await client.openControl(decoded.box, RELAY), 'desktop');
  assert.equal(reread.t, 'offer');
  assert.equal(reread.sdp, largest.sdp);
  // One byte more no longer parses, and could not be carried if sealed.
  assert.throws(() => parseRemoteTransportSignal(offer(pad + 1), 'desktop'), /control size/);
  // An SDP the shared validator accepts (≤ 64 KiB) but no control box can carry.
  assert.throws(() => parseRemoteTransportSignal(offer(65_536 - offer(0).sdp.length), 'desktop'), /sdp size/);
  // The shared ICE normalizer turns a scalar `urls` into a list.
  const scalar = parseRemoteTransportSignal({ ...offer(0), iceServers: [{ urls: 'stun:stun.example.org:3478' }] }, 'desktop');
  assert.deepEqual(scalar.iceServers, [{ urls: ['stun:stun.example.org:3478'] }]);
  const oversize = new Uint8Array(REMOTE_TRANSPORT_MAX_CONTROL_BOX_BYTES + 1);
  oversize.set([0x4d, 0x58, 0x43, 0x01], 0);
  assert.throws(() => encodeRemoteTransportControl(oversize), /control size/);
});

test('one repair round is one control box, however many records it names', async () => {
  const { client, server } = await session();
  const sender = new RemoteTransportSender();
  for (let i = 1; i <= REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT; i += 1) sender.push(await client.encryptBinary({ i }));
  for (const { sequence } of sender.due(0)) sender.markSent(sequence, 'direct:a', 0);
  // Every record in the span is lost (the receiver only learns of them by probe).
  const receiver = new RemoteTransportReceiver();
  receiver.probe(REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT, 0);
  assert.deepEqual(receiver.repairDue(0), []);
  const due = receiver.repairDue(Math.ceil(new RemoteTransportPathMonitor(0).lossDelayMs()));
  assert.equal(due.length, REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT);
  const box = await server.sealControl(remoteTransportRepair(due), DIRECT_A);
  assert.ok(box.byteLength <= REMOTE_TRANSPORT_MAX_CONTROL_BOX_BYTES);
  const message = readRemoteTransportControl(await client.openControl(box, DIRECT_A), 'client');
  assert.equal(sender.repair(message), REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT);
  assert.equal(sender.due(0).length, REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT);
  // The list is strict: non-empty, ascending, distinct, within the span.
  const read = (sequences, sequence) => readRemoteTransportControl({ stale: false, sequence, value: { v: 1, t: 'repair', sequences } }, 'client');
  assert.throws(() => read([], 900), /repair/);
  assert.throws(() => read([3, 2], 901), /repair order/);
  assert.throws(() => read([2, 2], 902), /repair order/);
  assert.throws(() => read(Array.from({ length: REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT + 1 }, (_, i) => i + 1), 903), /repair/);
  assert.throws(() => read([0], 904), /repair/);
});

test('a burst whose lanes deliver it out of order is accepted in full; within a FIFO lane only replays are stale', async () => {
  const { client, server } = await session();
  const boxes = [];
  for (let index = 1; index <= 3 * REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT; index += 1) {
    boxes.push(await client.sealControl(remoteTransportPing(index), index % 3 === 1 ? RELAY : DIRECT_A));
  }
  // Every third box went by relay (slow), the rest by the direct lane (fast).
  // (box i was sealed as ping i + 1, so ping index % 3 === 1 ⇔ i % 3 === 0.)
  const relay = boxes.filter((_, index) => index % 3 === 0);
  const direct = boxes.filter((_, index) => index % 3 !== 0);
  // The fast lane delivers everything first; the slow lane's whole burst then
  // arrives far behind the global high-water, in reverse global order of
  // arrival. A shared sliding window of 64 would drop most of it.
  for (const box of direct) assert.equal((await server.openControl(box, DIRECT_A)).stale, false);
  for (const box of relay) assert.equal((await server.openControl(box, RELAY)).stale, false);
  // Replays on either lane are stale.
  assert.equal((await server.openControl(direct[0], DIRECT_A)).stale, true);
  assert.equal((await server.openControl(relay.at(-1), RELAY)).stale, true);
  // A burst reversed WITHIN one FIFO lane cannot be genuine (a reordering
  // relay): only the first-delivered, highest box opens.
  const reversed = [];
  for (let index = 0; index < 10; index += 1) reversed.push(await client.sealControl(remoteTransportPing(1_000 + index), RELAY));
  const results = [];
  for (const box of [...reversed].reverse()) results.push((await server.openControl(box, RELAY)).stale);
  assert.deepEqual(results, [false, ...Array(9).fill(true)]);
});

test('signaling delayed across a carrier switch still opens after a flood of direct control', async () => {
  const { client, server, sessionId } = await session();
  const fingerprints = [{ algorithm: 'sha-256', value: FINGERPRINT }];
  // The desktop sends a re-offer by relay, then promotes the direct carrier
  // and acks a long run of records there while the offer is still in transit.
  const offer = await server.sealControl({ ...ref(sessionId), generation: 2, t: 'offer', sdp: SDP, fingerprints, iceServers: [] }, RELAY);
  const acks = [];
  for (let through = 1; through <= 1_000; through += 1) acks.push(await server.sealControl(remoteTransportAck(through), DIRECT_A));
  for (const box of acks) assert.equal((await client.openControl(box, DIRECT_A)).stale, false);
  const opened = await client.openControl(offer, RELAY);
  assert.equal(opened.stale, false, 'not overtaken: lanes are checked separately');
  const signal = readRemoteTransportControl(opened, 'desktop');
  assert.equal(signal.t, 'offer');
  assert.equal(signal.generation, 2);
  // After a demotion the relay lane keeps going; the old direct lane's late
  // boxes are stale only against their own lane.
  const later = await server.sealControl(remoteTransportAck(1_001), RELAY);
  assert.equal((await client.openControl(later, RELAY)).stale, false);
  assert.equal((await client.openControl(acks.at(-1), DIRECT_A)).stale, true);
});

test('application-progress policy: a healthy low-RTT path whose peer accepts late is not demoted early', () => {
  const path = new RemoteTransportPathMonitor(0);
  path.rttSample(1);
  assert.ok(path.ptoMs() < 100, 'PTO is tiny on this path');
  path.outstanding(4096, 0);
  // Pongs every 100 ms, empty queue, no ack for almost the whole 6 s bound.
  for (let now = 0; now < REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS; now += 100) {
    path.inbound(now);
    path.buffered(0, now);
    assert.equal(path.stalled(now, 4096), null, `not demoted at ${now}`);
  }
  // The peer accepts (the ack advances) just before the bound; the bound
  // then restarts from that progress.
  path.ackAdvanced(REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS - 1);
  const resumed = REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS - 1;
  for (let now = REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS; now < resumed + REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS; now += 100) {
    path.inbound(now);
    assert.equal(path.stalled(now, 4096), null);
  }
  path.inbound(resumed + REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS);
  assert.equal(path.stalled(resumed + REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS, 4096), 'no-progress');
});

test('application-progress policy over repeated promote/demote cycles: each carrier starts its own bound', () => {
  const direct = new RemoteTransportPathMonitor(0);
  const relay = new RemoteTransportPathMonitor(0);
  let now = 0;
  for (let cycle = 0; cycle < 5; cycle += 1) {
    // Promote: the direct carrier starts fresh while work is still outstanding.
    direct.reset(now);
    direct.rttSample(2);
    const promoted = now;
    for (; now < promoted + REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS; now += 500) {
      direct.inbound(now);
      assert.equal(direct.stalled(now, 8192), null, `cycle ${cycle}: direct healthy at ${now}`);
    }
    direct.inbound(now);
    assert.equal(direct.stalled(now, 8192), 'no-progress', `cycle ${cycle}: direct stalls after 6 s`);
    // Demote: the relay carrier starts fresh too; the direct wait is not inherited.
    relay.reset(now);
    const demoted = now;
    relay.inbound(now);
    assert.equal(relay.stalled(now, 8192), null, `cycle ${cycle}: relay not demoted on arrival`);
    now += 1_000;
    relay.inbound(now);
    relay.ackAdvanced(now);
    assert.equal(relay.stalled(now, 8192), null);
    assert.ok(now - demoted < REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS);
  }
});
