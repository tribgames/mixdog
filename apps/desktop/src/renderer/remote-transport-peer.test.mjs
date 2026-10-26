import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  createRelayE2EEClientHandshake,
  generateRelayE2EEServerIdentity,
  relayE2EEPairingMaterial,
  RELAY_E2EE_RELAY_LANE,
} from '../shared/remote-e2ee.ts';
import {
  REMOTE_TRANSPORT_BUFFER_HIGH_BYTES,
  REMOTE_TRANSPORT_BUFFER_LOW_BYTES,
  REMOTE_TRANSPORT_ASSEMBLY_IDLE_MS,
  REMOTE_TRANSPORT_MAX_CONTROL_BOX_BYTES,
  REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES,
  REMOTE_TRANSPORT_PREFIX_BYTES,
  remoteTransportControlBytes,
  RemoteTransportAssemblyPool,
  RemoteTransportMessageAssembler,
  RemoteTransportReceiver,
  RemoteTransportSender,
  decodeRemoteTransportMessage,
  encodeRemoteTransportControl,
  encodeRemoteTransportRecord,
  readRemoteTransportControl,
  remoteTransportAck,
  remoteTransportAssemblyPool,
  remoteTransportPing,
  remoteTransportRepair,
  splitRemoteTransportPayload,
} from '../shared/remote-transport.ts';
import {
  REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES,
  REMOTE_TRANSPORT_PHONE_OPT_IN,
  createRemoteTransportPeer,
} from './remote-transport-peer.ts';

const until = async (condition, what = 'condition') => {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`${what} did not settle`);
    await new Promise((resolve) => setImmediate(resolve));
  }
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(':');
const FP2 = FP.replace(/^10/u, '11');
const sdpWith = (fp) => `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:sha-256 ${fp}\r\n`;
const CONN = 'conn-0001';
const LANE = { kind: 'direct', epoch: 1, connectionId: CONN };

class FakeChannel {
  constructor(label, ordered = true) {
    this.label = label;
    this.ordered = ordered;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.thresholdAtFirstSend = null;
    this.sent = [];
  }
  send(data) {
    if (this.readyState !== 'open') throw new Error('not open');
    this.thresholdAtFirstSend ??= this.bufferedAmountLowThreshold;
    this.sent.push(data);
    // As a browser does: queued until the stack takes it.
    this.bufferedAmount += data.byteLength;
  }
  open() {
    this.readyState = 'open';
    this.onopen?.();
  }
  close() {
    this.readyState = 'closed';
  }
}

class FakePeer {
  constructor(config) {
    this.config = config;
    this.sctp = { maxMessageSize: 65_536 };
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.closed = false;
    this.added = [];
    this.certificate = FP;
    FakePeer.last = this;
  }
  async setRemoteDescription(description) {
    this.remote = description;
  }
  async createAnswer() {
    return { type: 'answer', sdp: sdpWith(FP) };
  }
  async setLocalDescription(description) {
    this.localDescription = description;
  }
  async addIceCandidate(candidate) {
    this.added.push(candidate);
  }
  async getStats() {
    return new Map([
      ['t', { id: 't', type: 'transport', dtlsState: 'connected', remoteCertificateId: 'c' }],
      ['c', { id: 'c', type: 'certificate', fingerprint: this.certificate, fingerprintAlgorithm: 'sha-256' }],
    ]);
  }
  close() {
    this.closed = true;
  }
  connect() {
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
  }
  channel(label, ordered = true) {
    const channel = new FakeChannel(label, ordered);
    this.ondatachannel({ channel });
    return channel;
  }
}

/** The PC side: a real server channel and the shared stream core. */
class Desk {
  constructor(server, sessionId) {
    this.server = server;
    this.sessionId = sessionId;
    this.sender = new RemoteTransportSender();
    this.receiver = new RemoteTransportReceiver();
    this.assembler = new RemoteTransportMessageAssembler(new RemoteTransportAssemblyPool());
    this.cursors = new Map();
    this.controls = [];
    this.apps = [];
    this.fragment = 0;
  }
  async records(payload) {
    const out = [];
    for (const part of splitRemoteTransportPayload(payload, ++this.fragment)) {
      const box = await this.server.encryptBinary(part);
      this.sender.push(box);
      out.push(encodeRemoteTransportRecord(box));
    }
    return out;
  }
  async control(message, lane = RELAY_E2EE_RELAY_LANE) {
    return encodeRemoteTransportControl(await this.server.sealControl(message, lane));
  }
  /** Reads what the phone put on `wire` (one lane) since the last read. */
  async drain(wire, lane) {
    const from = this.cursors.get(wire) ?? 0;
    this.cursors.set(wire, wire.length);
    for (const raw of wire.slice(from)) {
      const message = decodeRemoteTransportMessage(raw);
      if (message.kind === 'control') {
        const control = readRemoteTransportControl(await this.server.openControl(message.box, lane), 'client');
        if (control) this.controls.push({ ...control, lane });
        continue;
      }
      this.receiver.accept(message, 0);
      for (let next = this.receiver.next(); next; next = this.receiver.next()) {
        const value = await this.server.decryptJson(next.box);
        this.receiver.commit(next.sequence, 0);
        const result = this.assembler.accept(value, 0);
        if (result.state === 'complete') this.apps.push(result.payload);
      }
    }
  }
  ref(generation = 1) {
    return { v: 1, sessionId: this.sessionId, connectionId: CONN, generation };
  }
}

function fakeTimers() {
  const live = new Map();
  let next = 1;
  return {
    live,
    setTimeout(fn, ms) {
      live.set(next, { fn, ms });
      return next++;
    },
    clearTimeout(id) {
      live.delete(id);
    },
    run() {
      const due = [...live.values()];
      live.clear();
      for (const timer of due) timer.fn();
    },
  };
}

/** A confirmed transport session: the phone peer over a fake relay, the desk
 *  beside it, `e2ee-ready` already delivered as record 1. */
async function session({ confirm = true } = {}) {
  const identity = await generateRelayE2EEServerIdentity();
  const challenge = { ...createRelayE2EEChallenge(), binaryFrames: 1, transportWebrtc: 1 };
  const client = await createRelayE2EEClientHandshake(relayE2EEPairingMaterial(identity), challenge, {
    transportWebrtc: true,
    helloFields: { viewSync: 1 },
  });
  const server = await acceptRelayE2EEClientHello(identity, challenge, client.hello);
  const clock = { now: 1_000 };
  const timers = fakeTimers();
  const relay = { sent: [], bufferedAmount: 0 };
  const view = { visible: true };
  const delivered = [];
  const fatal = [];
  const peer = createRemoteTransportPeer({
    channel: client.channel,
    sessionId: challenge.challenge,
    relay: { send: (data) => relay.sent.push(data), bufferedAmount: () => relay.bufferedAmount },
    deliver: (payload) => {
      if (payload?.type === 'e2ee-ready') {
        client.channel.confirmHandshake(payload);
        peer.confirm();
      }
      delivered.push(payload);
    },
    fatal: (error) => fatal.push(error),
    createPeer: (config) => new FakePeer(config),
    visible: () => view.visible,
    now: () => clock.now,
    timers,
    log() {},
  });
  const desk = new Desk(server, challenge.challenge);
  const feed = async (messages, into = (raw) => peer.receiveRelay(raw)) => {
    for (const raw of messages.flat(Infinity)) into(raw);
    await settle();
  };
  if (confirm) {
    await feed(await desk.records({ type: 'e2ee-ready', version: 1, ...server.handshakeConfirmation() }));
    await until(() => delivered.length === 1, 'e2ee-ready');
  }
  return { peer, desk, relay, clock, timers, view, delivered, fatal, feed, server, client };
}

/** Offers a direct carrier, connects it and opens both channels. */
async function connectDirect(s, { maxMessageSize = 65_536, certificate = FP } = {}) {
  const { desk, feed } = s;
  desk.server.registerControlLane(LANE);
  await feed([
    await desk.control({
      ...desk.ref(),
      t: 'offer',
      sdp: sdpWith(FP),
      fingerprints: [{ algorithm: 'sha-256', value: FP }],
      iceServers: [{ urls: ['turn:turn.example:3478'], username: 'u', credential: 'secret' }],
    }),
  ]);
  const pc = FakePeer.last;
  pc.sctp.maxMessageSize = maxMessageSize;
  pc.certificate = certificate;
  const app = pc.channel('mixdog-transport');
  const control = pc.channel('mixdog-transport-control');
  app.open();
  control.open();
  pc.connect();
  await settle();
  return { pc, app, control };
}

/** Answers the phone's latest ping on the direct control channel. */
async function pongDirect(s, link) {
  await s.desk.drain(link.control.sent, LANE);
  const ping = s.desk.controls.filter((c) => c.t === 'ping' && c.lane?.kind === 'direct').at(-1);
  await s.feed([await s.desk.control({ v: 1, t: 'pong', id: ping.id }, LANE)], (raw) => link.control.onmessage({ data: raw }));
}

test('the rollout switch is off', () => {
  assert.equal(REMOTE_TRANSPORT_PHONE_OPT_IN, false);
});

test('nothing is sent before the confirmation; acks start after it', async () => {
  const s = await session({ confirm: false });
  await s.feed(await s.desk.records({ type: 'e2ee-ready', version: 1, transcript: 'A'.repeat(43) }));
  // The caller refused the altered transcript (confirmHandshake threw): fatal, silent.
  assert.equal(s.fatal.length, 1);
  assert.deepEqual(s.relay.sent, []);

  const ok = await session();
  ok.clock.now += 25;
  ok.timers.run();
  await until(() => ok.relay.sent.length > 0, 'an ack after confirmation');
  await ok.desk.drain(ok.relay.sent, RELAY_E2EE_RELAY_LANE);
  assert.equal(ok.desk.controls[0].t, 'ack');
  assert.equal(ok.desk.controls[0].through, 1);
});

test('sending: split, seal, sender; large messages fragment and reassemble', async () => {
  const s = await session();
  const big = { method: 'upload', data: 'x'.repeat(1_500_000) };
  assert.equal(await s.peer.send(big), true);
  await s.desk.drain(s.relay.sent, RELAY_E2EE_RELAY_LANE);
  assert.deepEqual(s.desk.apps, [big]);
  assert.equal(s.peer.diagnostics().sender.nextSequence, 3, 'two fragments, two records');
});

test('a pre-seal refusal leaves the next sequence unchanged', async () => {
  const s = await session();
  for (let index = 0; index < 9; index += 1) await s.peer.send({ fill: 'y'.repeat(900_000) });
  const before = s.peer.diagnostics().sender.nextSequence;
  assert.equal(await s.peer.send({ method: 'motion' }, { droppable: true }), false, 'dropped before sealing');
  assert.equal(s.peer.diagnostics().sender.nextSequence, before);
  await assert.rejects(s.peer.send({ huge: 'z'.repeat(64 * 1024 * 1024) }), /message size/);
  assert.equal(s.peer.diagnostics().sender.nextSequence, before);
});

test('every sealed message reaches the relay: a full relay queue delays, never drops', async () => {
  const s = await session();
  const baseline = s.relay.sent.length;
  s.relay.bufferedAmount = REMOTE_TRANSPORT_BUFFER_HIGH_BYTES;
  await s.peer.send({ id: 1, method: 'a' });
  await s.peer.send({ id: 2, method: 'b' });
  assert.equal(s.relay.sent.length, baseline, 'held while the relay queue is full');
  s.relay.bufferedAmount = 0;
  s.timers.run();
  await s.desk.drain(s.relay.sent, RELAY_E2EE_RELAY_LANE);
  assert.deepEqual(s.desk.apps.map((app) => app.id), [1, 2]);
});

test('loss recovery: a dropped middle record and a dropped final record are both repaired', async () => {
  const s = await session();
  const r = [];
  for (let id = 2; id <= 5; id += 1) r.push(await s.desk.records({ id }));
  await s.feed([r[1], r[2], r[3]]);
  s.timers.run();
  await settle();
  await s.desk.drain(s.relay.sent, RELAY_E2EE_RELAY_LANE);
  const repair = s.desk.controls.find((c) => c.t === 'repair');
  assert.ok(repair, JSON.stringify([s.desk.controls, s.timers.live.size, String(s.fatal), s.peer.diagnostics().receiver]));
  assert.deepEqual(repair.sequences, [2], 'one box names the round');
  await s.feed([r[0]]);
  assert.deepEqual(s.delivered.slice(1).map((p) => p.id), [2, 3, 4, 5]);

  const last = await s.desk.records({ id: 6 });
  // Never arrives; the PC's probe says it was sent.
  await s.feed([await s.desk.control(remoteTransportPing(41, 6))]);
  s.clock.now += 1_000;
  s.timers.run();
  await settle();
  await s.desk.drain(s.relay.sent, RELAY_E2EE_RELAY_LANE);
  assert.deepEqual(s.desk.controls.filter((c) => c.t === 'repair').at(-1).sequences, [6]);
  assert.ok(s.desk.controls.some((c) => c.t === 'pong' && c.id === 41));
  await s.feed([last]);
  assert.equal(s.delivered.at(-1).id, 6);
});

test('the phone probes with ping.sent and re-sends what the PC repairs', async () => {
  const s = await session();
  await s.peer.send({ id: 7 });
  await s.desk.drain(s.relay.sent, RELAY_E2EE_RELAY_LANE);
  s.clock.now += 2_000;
  s.timers.run();
  await settle();
  await s.desk.drain(s.relay.sent, RELAY_E2EE_RELAY_LANE);
  const probe = s.desk.controls.filter((c) => c.t === 'ping').at(-1);
  assert.equal(probe.sent, 1);
  const count = s.relay.sent.length;
  await s.feed([await s.desk.control(remoteTransportRepair([1]))]);
  assert.equal(s.relay.sent.length, count + 1, 'the repaired record went again');
});

test('only a matched pong on its own carrier feeds the RTT, once', async () => {
  const s = await session();
  s.peer.wake();
  await settle();
  await s.desk.drain(s.relay.sent, RELAY_E2EE_RELAY_LANE);
  const ping = s.desk.controls.filter((c) => c.t === 'ping').at(-1);
  await s.feed([await s.desk.control({ v: 1, t: 'pong', id: 999 })]);
  assert.equal(s.peer.diagnostics().relayRttMs, 333, 'unknown id: no sample');
  s.clock.now += 100;
  await s.feed([await s.desk.control({ v: 1, t: 'pong', id: ping.id })]);
  assert.equal(s.peer.diagnostics().relayRttMs, 100);
  s.clock.now += 400;
  await s.feed([await s.desk.control({ v: 1, t: 'pong', id: ping.id })]);
  assert.equal(s.peer.diagnostics().relayRttMs, 100, 'consumed once');
});

test('answering: ICE from the offer, both ordered channels, threshold first, path validation, then promotion', async () => {
  const s = await session();
  const link = await connectDirect(s);
  assert.deepEqual(link.pc.config.iceServers, [{ urls: ['turn:turn.example:3478'], username: 'u', credential: 'secret' }]);
  await s.desk.drain(s.relay.sent, RELAY_E2EE_RELAY_LANE);
  const answer = s.desk.controls.find((c) => c.t === 'answer');
  assert.deepEqual(answer.fingerprints, [{ algorithm: 'sha-256', value: FP }]);
  assert.equal(link.control.thresholdAtFirstSend, REMOTE_TRANSPORT_BUFFER_LOW_BYTES);
  assert.equal(s.peer.diagnostics().path, 'relay', 'not before a round trip');
  await pongDirect(s, link);
  assert.equal(s.peer.diagnostics().path, 'direct');
  await s.peer.send({ id: 9 });
  await s.desk.drain(link.app.sent, LANE);
  assert.equal(s.desk.apps.at(-1).id, 9);
  assert.equal(link.app.thresholdAtFirstSend, REMOTE_TRANSPORT_BUFFER_LOW_BYTES);
});

test('the message-size gate and the fingerprint keep a carrier off', async () => {
  for (const options of [{ maxMessageSize: 16_384 }, { certificate: FP2 }]) {
    const s = await session();
    const link = await connectDirect(s, options);
    await s.desk.drain(s.relay.sent, RELAY_E2EE_RELAY_LANE);
    assert.ok(s.desk.controls.some((c) => c.t === 'close'));
    assert.equal(link.pc.closed, true);
    assert.equal(s.peer.diagnostics().path, 'relay');
  }
});

test('an unordered channel is refused', async () => {
  const s = await session();
  await s.feed([
    await s.desk.control({ ...s.desk.ref(), t: 'offer', sdp: sdpWith(FP), fingerprints: [{ algorithm: 'sha-256', value: FP }], iceServers: [] }),
  ]);
  FakePeer.last.channel('mixdog-transport-control', false);
  assert.equal(FakePeer.last.closed, true);
});

test('backpressure: a drain between the high mark and the listener is not missed', async () => {
  const s = await session();
  const link = await connectDirect(s);
  await pongDirect(s, link);
  link.app.bufferedAmount = REMOTE_TRANSPORT_BUFFER_HIGH_BYTES;
  let handler = null;
  Object.defineProperty(link.app, 'onbufferedamountlow', {
    get: () => handler,
    set(value) {
      handler = value;
      // It drained before anyone listened.
      link.app.bufferedAmount = 0;
    },
  });
  const count = link.app.sent.length;
  await s.peer.send({ id: 10 });
  await settle();
  assert.equal(link.app.sent.length, count + 1);
});

test('a bare e2ee-ready on a transport session ends it, unopened and unanswered', async () => {
  const s = await session({ confirm: false });
  const bare = await s.server.encryptBinary({ type: 'e2ee-ready', version: 1, ...s.server.handshakeConfirmation() });
  s.peer.receiveRelay(bare.buffer);
  await until(() => s.fatal.length === 1, 'the session ends');
  assert.match(String(s.fatal[0]), /bare box/);
  assert.deepEqual(s.delivered, []);
  assert.deepEqual(s.relay.sent, []);
});

test('control stays responsive while bulk saturates the direct carrier; the queue bound holds', async () => {
  const s = await session();
  const link = await connectDirect(s);
  await pongDirect(s, link);
  // Bulk filled its share of the aggregate bound; more keeps arriving.
  link.app.bufferedAmount = REMOTE_TRANSPORT_BUFFER_HIGH_BYTES - REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES;
  const appBefore = link.app.sent.length;
  for (let id = 20; id < 24; id += 1) await s.peer.send({ id, data: 'b'.repeat(200_000) });
  assert.equal(link.app.sent.length, appBefore, 'nothing written past the aggregate bound');
  // The PC probes on the control channel and sends records: both get answers at once.
  const controlBefore = link.control.sent.length;
  await s.feed(
    [await s.desk.control(remoteTransportPing(77), LANE), ...(await s.desk.records({ id: 'x' })), ...(await s.desk.records({ id: 'y' }))],
    (raw) => (decodeRemoteTransportMessage(raw).kind === 'control' ? link.control : link.app).onmessage({ data: raw })
  );
  await s.desk.drain(link.control.sent, LANE);
  const fresh = s.desk.controls.slice(-2).map((c) => c.t).sort();
  assert.ok(link.control.sent.length >= controlBefore + 2);
  assert.deepEqual(fresh, ['ack', 'pong']);
  assert.ok(s.desk.controls.some((c) => c.t === 'pong' && c.id === 77));
  // Drained: the held bulk goes out, in order.
  link.app.bufferedAmount = 0;
  link.app.onbufferedamountlow();
  await s.desk.drain(link.app.sent, LANE);
  assert.deepEqual(s.desk.apps.slice(-4).map((app) => app.id), [20, 21, 22, 23]);
});

/** Carrier bytes of one sealed control message (JSON, box header and tag, prefix). */
const controlWire = (message) =>
  remoteTransportControlBytes(message) +
  REMOTE_TRANSPORT_MAX_CONTROL_BOX_BYTES -
  REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES +
  REMOTE_TRANSPORT_PREFIX_BYTES;
const combined = (link) => link.app.bufferedAmount + link.control.bufferedAmount;

test('aggregate bound: a nearly full control channel stops bulk, control never passes 8 MiB, the latest pong is kept', async () => {
  const s = await session();
  const link = await connectDirect(s);
  await pongDirect(s, link);
  // Room for exactly three pongs left in the whole bound.
  const pong = controlWire({ v: 1, t: 'pong', id: 31 });
  link.app.bufferedAmount = 0;
  link.control.bufferedAmount = REMOTE_TRANSPORT_BUFFER_HIGH_BYTES - 3 * pong;
  const appBefore = link.app.sent.length;
  const controlBefore = link.control.sent.length;
  await s.peer.send({ id: 30 });
  assert.equal(link.app.sent.length, appBefore, 'no bulk past the aggregate bound');
  for (let id = 31; id <= 40; id += 1) {
    await s.feed([await s.desk.control(remoteTransportPing(id), LANE)], (raw) => link.control.onmessage({ data: raw }));
    assert.ok(combined(link) <= REMOTE_TRANSPORT_BUFFER_HIGH_BYTES, `channels within the bound after ping ${id}`);
    assert.ok(s.peer.diagnostics().queueDepth <= REMOTE_TRANSPORT_BUFFER_HIGH_BYTES, `aggregate within the bound after ping ${id}`);
  }
  assert.equal(link.control.sent.length, controlBefore + 3, 'what fits went; nothing more was sealed');
  // Either channel's low event resumes: here the control channel's.
  link.control.bufferedAmount = 0;
  link.control.onbufferedamountlow();
  await settle();
  await s.desk.drain(link.control.sent, LANE);
  const pongs = s.desk.controls.filter((c) => c.t === 'pong' && c.id > 30).map((c) => c.id);
  assert.deepEqual(pongs, [31, 32, 33, 40], 'in lane order, the coalesced one last (a reordered box would read as stale)');
  await s.desk.drain(link.app.sent, LANE);
  assert.equal(s.desk.apps.at(-1).id, 30, 'bulk follows once there is room');
});

test('ping flood with both channels saturated: nothing grows past the bound, one pong answers it', async () => {
  const s = await session();
  const link = await connectDirect(s);
  await pongDirect(s, link);
  link.app.bufferedAmount = REMOTE_TRANSPORT_BUFFER_HIGH_BYTES / 2;
  link.control.bufferedAmount = REMOTE_TRANSPORT_BUFFER_HIGH_BYTES / 2;
  const controlBefore = link.control.sent.length;
  const pings = [];
  for (let id = 101; id <= 300; id += 1) pings.push(await s.desk.control(remoteTransportPing(id), LANE));
  for (const raw of pings) link.control.onmessage({ data: raw });
  await settle();
  assert.equal(link.control.sent.length, controlBefore);
  assert.ok(s.peer.diagnostics().queueDepth <= REMOTE_TRANSPORT_BUFFER_HIGH_BYTES);
  assert.equal(s.peer.diagnostics().path, 'direct', 'regenerable control never fails the carrier');
  assert.deepEqual(s.fatal, []);
  link.app.bufferedAmount = 0;
  link.app.onbufferedamountlow();
  await settle();
  await s.desk.drain(link.control.sent, LANE);
  assert.deepEqual(
    s.desk.controls.filter((c) => c.t === 'pong' && c.id > 100).map((c) => c.id),
    [300]
  );
});

test('a repair that finds no room fails the direct carrier and goes on the relay lane', async () => {
  const s = await session();
  const link = await connectDirect(s);
  await pongDirect(s, link);
  const records = [];
  for (let id = 2; id <= 5; id += 1) records.push(await s.desk.records({ id }));
  link.control.bufferedAmount = REMOTE_TRANSPORT_BUFFER_HIGH_BYTES;
  // Record 2 never arrives; 3..5 show it lost.
  await s.feed([records[1], records[2], records[3]], (raw) => link.app.onmessage({ data: raw }));
  s.timers.run();
  await settle();
  assert.equal(link.pc.closed, true);
  assert.equal(s.peer.diagnostics().path, 'relay');
  await s.desk.drain(s.relay.sent, RELAY_E2EE_RELAY_LANE);
  assert.ok(s.desk.controls.some((c) => c.t === 'close' && c.reason === 'stall' && c.detail === 'control-backlog'));
  assert.deepEqual(s.desk.controls.find((c) => c.t === 'repair' && c.lane.kind === 'relay')?.sequences, [2]);
});

test('sendPromptly: true once handed to a carrier; false at once when it cannot be, and it still goes', async () => {
  const s = await session();
  const before = s.relay.sent.length;
  assert.equal(await s.peer.sendPromptly({ method: 'setForeground', params: [false, 'b'] }), true);
  assert.ok(s.relay.sent.length > before, 'on the carrier before it resolved');

  // A fragmented upload ahead of it: no waiting.
  const upload = s.peer.send({ method: 'upload', data: 'u'.repeat(3_000_000) });
  assert.equal(await s.peer.sendPromptly({ method: 'setForeground', params: [false, 'c'] }), false);
  await upload;
  // A full window: no waiting either; it goes once acks make room.
  const blocked = await session();
  for (let index = 0; index < 9; index += 1) await blocked.peer.send({ fill: 'y'.repeat(900_000) });
  assert.equal(await blocked.peer.sendPromptly({ method: 'setForeground', params: [false, 'd'] }), false);
  await blocked.desk.drain(blocked.relay.sent, RELAY_E2EE_RELAY_LANE);
  await blocked.feed([await blocked.desk.control(remoteTransportAck(9))]);
  await until(async () => {
    await blocked.desk.drain(blocked.relay.sent, RELAY_E2EE_RELAY_LANE);
    return blocked.desk.apps.some((app) => app.params?.[1] === 'd');
  }, 'the report after room');
});

test('suspension sends close{suspended} for the last offered connection even after it closed', async () => {
  const s = await session();
  const link = await connectDirect(s);
  await s.feed([await s.desk.control({ ...s.desk.ref(), t: 'close', reason: 'stall' })]);
  assert.equal(link.pc.closed, true);
  await s.peer.suspend();
  await s.desk.drain(s.relay.sent, RELAY_E2EE_RELAY_LANE);
  const close = s.desk.controls.at(-1);
  assert.equal(close.t, 'close');
  assert.equal(close.reason, 'suspended');
  assert.equal(close.connectionId, CONN);
});

test('wake: ping at once on both carriers; an open channel is unproven until answered', async () => {
  const s = await session();
  const link = await connectDirect(s);
  await pongDirect(s, link);
  s.peer.hidden();
  assert.equal(s.timers.live.size, 0, 'no timer while hidden');
  const relayBefore = s.relay.sent.length;
  const controlBefore = link.control.sent.length;
  s.peer.wake();
  await settle();
  assert.ok(s.relay.sent.length > relayBefore && link.control.sent.length > controlBefore);
  assert.equal(s.peer.diagnostics().path, 'relay');
  await pongDirect(s, link);
  assert.equal(s.peer.diagnostics().path, 'direct');
});

test('suspension tells the PC and closes the peer', async () => {
  const s = await session();
  const link = await connectDirect(s);
  await s.peer.suspend();
  await s.desk.drain(s.relay.sent, RELAY_E2EE_RELAY_LANE);
  assert.equal(s.desk.controls.at(-1).reason, 'suspended');
  assert.equal(link.pc.closed, true);
});

test('assembler: wait holds the payload without losing it; a stalled message ends the session', async () => {
  const s = await session();
  const free = remoteTransportAssemblyPool.capacity - remoteTransportAssemblyPool.usedBytes();
  assert.ok(remoteTransportAssemblyPool.tryReserve(free));
  const big = { id: 11, data: 'q'.repeat(1_200_000) };
  const records = await s.desk.records(big);
  await s.feed(records);
  assert.equal(s.delivered.length, 1, 'held while the pool is full');
  remoteTransportAssemblyPool.release(free);
  s.timers.run();
  await until(() => s.delivered.length === 2, 'delivered once room exists');
  assert.equal(s.delivered[1].id, 11);

  const half = await s.desk.records({ id: 12, data: 'r'.repeat(1_200_000) });
  await s.feed([half[0]]);
  s.clock.now += REMOTE_TRANSPORT_ASSEMBLY_IDLE_MS;
  s.timers.run();
  assert.equal(s.fatal.length, 1);
});

test('an authenticated ack releases the window', async () => {
  const s = await session();
  await s.peer.send({ id: 13 });
  await s.feed([await s.desk.control(remoteTransportAck(1))]);
  assert.equal(s.peer.diagnostics().outstandingBytes, 0);
});
