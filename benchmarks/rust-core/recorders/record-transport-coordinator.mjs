#!/usr/bin/env node
// Records, from Node's product at b6f10295a, the desktop's transport coordinator
// (apps/desktop/src/main/remote-transport/coordinator.ts) driven by scripted inputs: the REAL coordinator, the REAL
// shared stream cores, a deterministic stand-in for the E2EE channel, a relay carrier, a peer host and a media
// adapter. Every effect the coordinator has on its surroundings (relay writes, peer sends and closes, sealed control
// messages, deliveries, ended/suspended/authenticated callbacks, log lines, lane operations) is logged in the order it
// happened, step by step, with the coordinator's diagnostics after each step. The inputs are chosen here; every outcome
// is what Node did.
//
// The channel stand-in is a convention, not an expectation: an application box is `MXE\x01 | u64 sequence | 12 zero
// bytes | JSON text | 16 zero bytes`, a control box is the same with `MXC\x01`; a box whose last 16 bytes are not zero
// fails authentication. Control lanes: the relay lane always exists; a direct lane must be registered before it
// seals or opens, a retired lane opens as stale, and every lane replays against its own high-water mark. The Rust
// replay builds the same boxes from the same convention.
//
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-transport-coordinator.mjs --tree <exact git archive of b6f10295a with node_modules> --commit b6f10295a2f698afc85332467192de28500bd146
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, args.get('commit') ?? (() => { throw new Error('--commit is required'); })());
const recorder = 'benchmarks/rust-core/recorders/record-transport-coordinator.mjs';
const finalDir = join(FIXTURES_ROOT, 'remote-transport-coordinator');
const stage = stageSet(finalDir);

// The connection ids the coordinator mints are 128 random bits; here the n-th is sixteen bytes of value n.
const nodeCrypto = createRequire(import.meta.url)('node:crypto');
let minted = 0;
nodeCrypto.randomBytes = (size) => Buffer.alloc(size, (minted += 1));
syncBuiltinESMExports();

const shared = await importFrom(tree, 'apps/desktop/src/shared/remote-transport.ts');
const e2ee = await importFrom(tree, 'apps/desktop/src/shared/remote-e2ee.ts');
const { createRemoteTransportCoordinator, RemoteTransportEndedError, RemoteTransportOversizeError } = await importFrom(tree, 'apps/desktop/src/main/remote-transport/coordinator.ts');

const SESSION = 'S'.repeat(43);
const START = 10_000;
const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(':');
const SDP = `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:sha-256 ${FINGERPRINT}\r\n`;
const FINGERPRINTS = [{ algorithm: 'sha-256', value: FINGERPRINT }];
const ICE = [{ urls: ['turn:turn.example.org:3478'], username: 'user-secret-name', credential: 'credential-secret' }];
const HOST_CANDIDATE = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' };

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
// Control messages are boxed as canonical JSON (keys sorted), so the box bytes do not depend on construction order.
const canon = (v) => JSON.stringify(sortKeys(v));
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const connectionIdOf = (n) => Buffer.alloc(16, n).toString('base64url');
const laneKey = (lane) => (lane.kind === 'relay' ? 'relay' : `direct:${lane.epoch}:${lane.connectionId}`);
const bytesRecord = (bytes) => {
  const buffer = Buffer.from(bytes);
  return buffer.length > 256 ? { len: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') } : { hex: buffer.toString('hex') };
};

// ---- the boxes ------------------------------------------------------------------------------------------------
const APP_MAGIC = Buffer.from([0x4d, 0x58, 0x45, 0x01]);
const CONTROL_MAGIC = Buffer.from([0x4d, 0x58, 0x43, 0x01]);
function makeBox(magic, sequence, text) {
  const body = Buffer.from(text);
  const out = Buffer.alloc(24 + body.length + 16);
  magic.copy(out, 0);
  out.writeBigUInt64BE(BigInt(sequence), 4);
  body.copy(out, 24);
  return new Uint8Array(out);
}
function openBox(box, magic) {
  const buffer = Buffer.from(box);
  if (buffer.length < 40 || !buffer.subarray(0, 4).equals(magic)) throw new Error('not a box');
  if (buffer.subarray(buffer.length - 16).some((byte) => byte !== 0)) throw new Error('authentication failed');
  return { sequence: Number(buffer.readBigUInt64BE(4)), text: buffer.subarray(24, buffer.length - 16).toString() };
}

// ---- the scenario harness ---------------------------------------------------------------------------------------
const flush = () => new Promise((resolve) => setImmediate(resolve));
const scenarios = [];

async function scenario(name, options, script) {
  minted = 0;
  const clock = { t: START };
  let effects = [];
  let results = [];
  const fake = { buffered: 0, refuse: false, encrypt: null, sealControl: null };
  const pendingRelay = [];
  const pendingDeliver = [];
  const peers = [];
  const lanes = new Map(); // key -> { state: 'registered' | 'active' | 'retired', highWater }
  let encryptSequence = 0;
  let controlSequence = 0;
  let creates = 0;
  let sendIds = 0;
  const log = (entry) => effects.push(entry);
  const laneState = (lane) => {
    if (lane.kind === 'relay') return { state: 'active', highWater: lanes.get('relay')?.highWater ?? 0 };
    return lanes.get(laneKey(lane));
  };

  const channel = {
    encryptBinary: async (piece) => {
      if (fake.encrypt === 'range') throw new RangeError('plaintext too large');
      if (fake.encrypt === 'broken') throw new Error('stream broken');
      const text = JSON.stringify(piece);
      if (Buffer.byteLength(text) > 1024 * 1024) throw new RangeError('plaintext too large');
      encryptSequence += 1;
      return makeBox(APP_MAGIC, encryptSequence, text);
    },
    decryptJson: async (box) => JSON.parse(openBox(box, APP_MAGIC).text),
    sealControl: async (message, lane) => {
      if (fake.sealControl === 'fail') throw new Error('seal failed');
      const known = lane.kind === 'relay' ? { state: 'active' } : lanes.get(laneKey(lane));
      if (!known || known.state === 'retired') throw new Error('unknown lane');
      controlSequence += 1;
      log({ e: 'seal-control', lane: laneKey(lane), message: clone(message) });
      return makeBox(CONTROL_MAGIC, controlSequence, canon(message));
    },
    openControl: async (box, lane) => {
      const known = lane.kind === 'relay' ? lanes.get('relay') ?? { state: 'active', highWater: 0 } : lanes.get(laneKey(lane));
      if (!known) throw new Error('unknown lane');
      const opened = openBox(box, CONTROL_MAGIC);
      if (known.state === 'retired' || opened.sequence <= known.highWater) return { value: null, sequence: opened.sequence, stale: true };
      known.highWater = opened.sequence;
      if (lane.kind === 'relay') lanes.set('relay', known);
      return { value: JSON.parse(opened.text), sequence: opened.sequence, stale: false };
    },
    registerControlLane: (lane) => {
      if (lane.kind === 'relay') return;
      if (lanes.has(laneKey(lane))) throw new Error('lane exists');
      lanes.set(laneKey(lane), { state: 'registered', highWater: 0 });
      log({ e: 'lane', op: 'register', lane: laneKey(lane) });
    },
    activateControlLane: (lane) => {
      const known = lanes.get(laneKey(lane));
      if (!known || known.state === 'retired') throw new Error('unknown lane');
      known.state = 'active';
      log({ e: 'lane', op: 'activate', lane: laneKey(lane) });
    },
    retireControlLane: (lane) => {
      const known = lanes.get(laneKey(lane));
      if (!known) throw new Error('unknown lane');
      known.state = 'retired';
      log({ e: 'lane', op: 'retire', lane: laneKey(lane) });
    },
  };

  const peerHost = options.peerHost
    ? {
        create(init, events) {
          creates += 1;
          if ((options.createThrows ?? []).includes(creates)) throw new Error('peer host unavailable');
          log({ e: 'peer-create', init: clone(init) });
          const peer = {
            init,
            events,
            offer: async () => {
              log({ e: 'peer-offer' });
              if (options.offer === 'reject') throw new Error('offer refused');
              return { sdp: SDP, fingerprints: FINGERPRINTS };
            },
            answer: async (sdp, fingerprints) => {
              log({ e: 'peer-answer', sdp, fingerprints: clone(fingerprints) });
              if (options.answer === 'reject') throw new Error('answer refused');
            },
            candidate: async (candidate) => {
              log({ e: 'peer-candidate', candidate: clone(candidate) });
            },
            send: (channelName, message) => {
              if (fake.refuse) return false;
              log({ e: 'peer-send', channel: channelName, ...bytesRecord(message) });
              return true;
            },
            bufferedAmount: () => fake.buffered,
            close: (reason) => log({ e: 'peer-close', reason }),
          };
          peers.push(peer);
          return peer;
        },
      }
    : null;

  const links = [];
  const media = options.media
    ? (link) => {
        links.push(link);
        const unsubscribe = link.onWritable(() => log({ e: 'media-writable' }));
        return {
          receive(payload) {
            if (payload && payload.type === 'stub-media') {
              log({ e: 'media', payload: clone(payload) });
              return true;
            }
            return false;
          },
          close() {
            log({ e: 'media-close' });
            unsubscribe();
          },
        };
      }
    : null;

  const coordinator = createRemoteTransportCoordinator({
    sessionId: SESSION,
    channel,
    relay: {
      send: (message) => {
        log({ e: 'relay', ...bytesRecord(message) });
        if (options.relay === 'held') return new Promise((resolve) => pendingRelay.push({ resolve, bytes: message.byteLength }));
        return Promise.resolve();
      },
    },
    deliver: (payload, bytes) => {
      log({ e: 'deliver', payload: clone(payload), bytes });
      if (options.deliver === 'held') return new Promise((resolve) => pendingDeliver.push(resolve));
      return undefined;
    },
    ended: (value) => log({ e: 'ended', reason: value.reason, ambiguousCallIds: value.ambiguousCallIds }),
    authenticated: () => log({ e: 'authenticated' }),
    suspended: () => log({ e: 'suspended' }),
    peerHost,
    media,
    resolveIceServers: async () => {
      log({ e: 'ice' });
      if (options.ice === 'reject') throw new Error('ice refused');
      if (options.ice === 'invalid') return [{ urls: 'http://not-ice' }];
      return ICE;
    },
    now: () => clock.t,
    schedule: () => () => {},
    log: (line) => log({ e: 'log', line }),
  });

  // The phone: its own sequences, the same box convention.
  const phone = { sequence: 0, control: 0 };
  const h = {
    steps: [],
    coordinator,
    clock,
    phone,
    pending: { relay: pendingRelay, deliver: pendingDeliver },
    peer: (n = 0) => peers[n],
    connection: (n = 1) => connectionIdOf(n),
    direct: (n = 1) => `direct:${connectionIdOf(n)}`,
    /** Carrier messages of one phone → desktop application record. */
    record(payload, { sequence } = {}) {
      phone.sequence = sequence ?? phone.sequence + 1;
      return shared.encodeRemoteTransportRecord(makeBox(APP_MAGIC, phone.sequence, JSON.stringify(payload))).map((m) => Buffer.from(m).toString('hex'));
    },
    /** A record whose box has a corrupted tag: it fails authentication when opened. */
    corruptRecord(payload) {
      phone.sequence += 1;
      const box = makeBox(APP_MAGIC, phone.sequence, JSON.stringify(payload));
      box[box.length - 1] = 1;
      return shared.encodeRemoteTransportRecord(box).map((m) => Buffer.from(m).toString('hex'));
    },
    /** One phone → desktop control message (any lane: the lane is the carrier it arrives on). */
    control(message, { corrupt = false } = {}) {
      phone.control += 1;
      const box = makeBox(CONTROL_MAGIC, phone.control, JSON.stringify(message));
      if (corrupt) box[box.length - 1] = 1;
      return [Buffer.from(shared.encodeRemoteTransportControl(box)).toString('hex')];
    },
    ref(connection = 1, generation = connection) {
      return { v: 1, sessionId: SESSION, connectionId: connectionIdOf(connection), generation };
    },
    ack: (through, ranges) => ({ v: 1, t: 'ack', through, ...(ranges ? { ranges } : {}) }),
    lastPing(lane) {
      for (const step of [...h.steps].reverse()) {
        for (const entry of [...step.effects].reverse()) if (entry.e === 'seal-control' && entry.lane === lane && entry.message.t === 'ping') return entry.message;
      }
      throw new Error(`no ping on ${lane}`);
    },
    /** Runs one step: sets the clock, performs `act`, lets every continuation run, records it all. */
    async step(op, act) {
      if (op.at !== undefined) clock.t = op.at;
      effects = [];
      results = [];
      act();
      await flush();
      const record = { ...op, at: clock.t, effects, results, diagnostics: coordinator.diagnostics() };
      h.steps.push(record);
      return record;
    },
    receive(carrier, hex, at) {
      return h.step({ op: 'receive', carrier, hex, ...(at === undefined ? {} : { at }) }, () => {
        for (const text of hex) coordinator.receive(carrier, Buffer.from(text, 'hex'));
      });
    },
    tick(at) {
      return h.step({ op: 'tick', ...(at === undefined ? {} : { at }) }, () => coordinator.tick());
    },
    send(payload, extra = {}, at) {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const id = (sendIds += 1);
      const sendOptions = {};
      if (extra.droppable) sendOptions.droppable = true;
      if (extra.stream) sendOptions.stream = extra.stream;
      if (extra.meter) sendOptions.onRelayWrite = (bytes) => log({ e: 'meter', name: extra.meter, bytes });
      return h.step({ op: 'send', id, ...(extra.fill ? {} : { payload: text }), ...extra, ...(at === undefined ? {} : { at }) }, () => {
        const object = typeof payload === 'string' ? JSON.parse(payload) : payload;
        coordinator.send(object, sendOptions).then(
          (bytes) => results.push({ id, ok: bytes }),
          (error) =>
            results.push({
              id,
              error: error instanceof RemoteTransportEndedError ? 'ended' : error instanceof RemoteTransportOversizeError ? 'oversize' : error instanceof RangeError ? 'range' : 'other',
              ...(error instanceof RemoteTransportEndedError ? { reason: error.reason } : {}),
              ...(error instanceof RemoteTransportOversizeError ? { bytes: error.bytes } : {}),
            })
        );
      });
    },
    /** A payload of `length` UTF-8 bytes of JSON: `{"id":N,"pad":"aaa…"}`, generated the same way by the replay. */
    padded(callId, length) {
      const head = `{"id":${callId},"pad":"`;
      const tail = '"}';
      return { fill: { callId, length }, text: head + 'a'.repeat(Math.max(0, length - head.length - tail.length)) + tail };
    },
    close(reason, at) {
      return h.step({ op: 'close', ...(reason === undefined ? {} : { reason }), ...(at === undefined ? {} : { at }) }, () => {
        const ended = coordinator.close(reason);
        log({ e: 'close-result', reason: ended.reason, ambiguousCallIds: ended.ambiguousCallIds });
      });
    },
    peerEvent(event, extra = {}, at) {
      const peer = peers.at(-1);
      return h.step({ op: 'peer', event, ...extra, ...(at === undefined ? {} : { at }) }, () => {
        if (event === 'candidate') peer.events.candidate(extra.candidate ?? null);
        else if (event === 'open') peer.events.open({ maxMessageSize: extra.maxMessageSize === 'Infinity' ? Infinity : extra.maxMessageSize, relayed: extra.relayed === true });
        else if (event === 'message') peer.events.message(new Uint8Array(Buffer.from(extra.hex, 'hex')));
        else if (event === 'drain') peer.events.drain();
        else if (event === 'closed') peer.events.closed(extra.reason);
      });
    },
    set(key, value) {
      return h.step({ op: 'set', key, value }, () => {
        if (key === 'buffered') fake.buffered = value;
        else if (key === 'refuse') fake.refuse = value;
        else if (key === 'encrypt') fake.encrypt = value;
        else if (key === 'sealControl') fake.sealControl = value;
      });
    },
    releaseRelay(count = 1) {
      return h.step({ op: 'relay-release', count }, () => {
        for (let i = 0; i < count; i += 1) pendingRelay.shift()?.resolve();
      });
    },
    releaseDeliver(count = 1) {
      return h.step({ op: 'deliver-release', count }, () => {
        for (let i = 0; i < count; i += 1) pendingDeliver.shift()?.();
      });
    },
    mediaSend(message, stream, at) {
      return h.step({ op: 'media-send', message, text: JSON.stringify(message), ...(stream ? { stream } : {}), ...(at === undefined ? {} : { at }) }, () => {
        const link = links[0];
        const pending = stream ? link.send(message, { stream }) : link.send(message);
        pending.then(
          (sent) => results.push({ media: sent }),
          (error) => results.push({ media: 'rejected', reason: error.reason ?? error.message })
        );
      });
    },
    mediaCanAdmit(stream, at) {
      return h.step({ op: 'media-can-admit', stream, ...(at === undefined ? {} : { at }) }, () => {
        results.push({ canAdmit: links[0].canAdmit(stream) });
      });
    },
    mediaProtocolError() {
      return h.step({ op: 'media-protocol-error' }, () => links[0].protocolError('media streams'));
    },
    /** Ticks until the desktop offers, then answers and opens and validates the direct path: promoted. */
    async promote(connection = 1) {
      await h.tick();
      const lane = `direct:${connection}:${connectionIdOf(connection)}`;
      await h.receive('relay', h.control({ ...h.ref(connection), t: 'answer', sdp: SDP, fingerprints: FINGERPRINTS }));
      await h.peerEvent('open', { maxMessageSize: 'Infinity', relayed: false });
      const ping = h.lastPing(lane);
      await h.receive(h.direct(connection), h.control({ v: 1, t: 'pong', id: ping.id }));
    },
  };
  await script(h);
  scenarios.push({ name, options, sessionId: SESSION, start: START, steps: h.steps });
}

// ---- the scenarios --------------------------------------------------------------------------------------------------
await scenario('a payload goes out on the relay and an ack releases it', {}, async (h) => {
  await h.send({ id: 7, method: 'x', args: [1, 2] }, { meter: 'first' });
  await h.send({ event: 'e', payload: { n: 1 } });
  await h.tick(10_100);
  await h.receive('relay', h.control(h.ack(1)));
  await h.tick(10_200);
  await h.receive('relay', h.control(h.ack(2)));
  await h.tick(10_300);
});

await scenario('a droppable message is dropped when the window is full, a call is refused when the session ends', {}, async (h) => {
  for (let i = 1; i <= 140; i += 1) await h.send({ id: i, n: i });
  await h.send({ event: 'drop-me' }, { droppable: true });
  await h.send({ id: 999, n: 999 });
  await h.close('revoked');
  await h.send({ id: 1000 });
});

await scenario('a large message is split into fragments and one over the ceiling is refused', {}, async (h) => {
  const big = h.padded(5, 2_500_000);
  await h.send(big.text, { fill: big.fill });
  await h.tick(10_100);
  await h.receive('relay', h.control(h.ack(4)));
  const over = h.padded(6, 64 * 1024 * 1024 + 100);
  await h.send(over.text, { fill: over.fill });
  await h.send({ id: 8, after: true });
});

await scenario('a record that the channel refuses for size is refused alone; a broken channel ends the session', {}, async (h) => {
  await h.set('encrypt', 'range');
  await h.send({ id: 1 });
  await h.send({ id: 2 });
  await h.set('encrypt', null);
  await h.send({ id: 3 });
  await h.set('encrypt', 'broken');
  await h.send({ id: 4 });
  await h.send({ id: 5 });
});

await scenario('records arrive in order, out of order, twice and corrupted', {}, async (h) => {
  const one = h.record({ id: 1, hello: 1 }, { sequence: 1 });
  const two = h.record({ id: 2, hello: 2 }, { sequence: 2 });
  const three = h.record({ id: 3, hello: 3 }, { sequence: 3 });
  const four = h.record({ id: 4, hello: 4 }, { sequence: 4 });
  await h.receive('relay', one);
  await h.receive('relay', three, 10_010);
  await h.tick(10_050);
  await h.receive('relay', three, 10_060);
  await h.receive('relay', two, 10_070);
  await h.tick(10_100);
  await h.receive('relay', h.corruptRecord({ id: 5 }), 10_110);
  await h.tick(10_200);
  await h.receive('relay', four, 10_300);
  await h.tick(10_400);
  await h.tick(10_800);
  await h.tick(12_500);
});

await scenario('a lost record is repaired when its successor is acked past a gap', {}, async (h) => {
  const records = [1, 2, 3, 4, 5].map((n) => h.record({ id: n }, { sequence: n }));
  await h.receive('relay', records[0]);
  await h.receive('relay', records[2], 10_010);
  await h.receive('relay', records[3], 10_020);
  await h.tick(10_100);
  await h.tick(10_400);
  await h.tick(10_900);
  await h.receive('relay', records[1], 11_000);
  await h.tick(11_100);
  await h.receive('relay', records[4], 11_200);
  await h.tick(11_300);
});

await scenario('control boxes that fail, repeat or cannot be meant end an attempt or the session', {}, async (h) => {
  await h.receive('relay', h.control(h.ack(0), { corrupt: true }));
  await h.receive('relay', ['4d58540100']);
  await h.receive('relay', ['00']);
  await h.receive('relay', h.control({ v: 1, t: 'ping', id: 4, sent: 0 }));
  await h.receive('relay', h.control({ v: 1, t: 'pong', id: 99 }));
  await h.receive('relay', h.control({ v: 1, t: 'repair', sequences: [3, 4] }));
  await h.receive('relay', h.control({ v: 1, t: 'nope' }));
  await h.receive('relay', h.control({ v: 2, t: 'ack', through: 0 }));
  await h.receive('relay', h.control(h.ack(5)));
});

await scenario('an ack for a record never sent ends the session', {}, async (h) => {
  await h.send({ id: 1 });
  await h.receive('relay', h.control(h.ack(9)));
  await h.send({ id: 2 });
});

await scenario('records unacked for a minute end the session and name the ambiguous calls', {}, async (h) => {
  await h.send({ id: 11 });
  await h.send({ id: 12 });
  await h.send({ event: 'e' });
  await h.receive('relay', h.control(h.ack(1)));
  await h.tick(40_000);
  await h.tick(80_000);
  await h.tick(80_100);
});

await scenario('a large message that stops arriving ends the session', {}, async (h) => {
  // The first fragment of a three-fragment message, split by Node's own splitter.
  const first = shared.splitRemoteTransportPayload({ id: 1, pad: 'a'.repeat(2_000_000) }, 1)[0];
  await h.receive('relay', h.record(first, { sequence: 1 }));
  await h.tick(10_100);
  await h.tick(50_000);
  await h.tick(80_000);
});

await scenario('a delivery that takes time holds the stream; a held relay write limits the carrier', { relay: 'held', deliver: 'held' }, async (h) => {
  await h.receive('relay', h.record({ id: 1, a: 1 }, { sequence: 1 }));
  await h.receive('relay', h.record({ id: 2, a: 2 }, { sequence: 2 }));
  await h.send({ id: 21, out: 1 });
  await h.releaseDeliver(1);
  await h.tick(10_100);
  await h.releaseDeliver(1);
  await h.releaseRelay(5);
  await h.tick(10_200);
});

await scenario('the direct path is offered, answered, validated and carries the stream', { peerHost: true }, async (h) => {
  await h.promote();
  await h.peerEvent('candidate', { candidate: HOST_CANDIDATE });
  await h.peerEvent('candidate', { candidate: null });
  await h.receive('relay', h.control({ ...h.ref(), t: 'candidate', candidate: HOST_CANDIDATE }));
  await h.send({ id: 31, direct: true }, { meter: 'direct' });
  await h.set('buffered', 4_000_000);
  await h.send({ id: 32, direct: true });
  await h.set('buffered', 0);
  await h.peerEvent('drain');
  await h.receive(h.direct(), h.record({ id: 33, from: 'phone' }, { sequence: 1 }));
  await h.receive(h.direct(), h.control(h.ack(2)));
  await h.receive(h.direct(), h.control({ v: 1, t: 'ping', id: 77, sent: 0 }));
  await h.receive('relay', h.control({ v: 1, t: 'ping', id: 78, sent: 0 }));
  await h.tick(10_500);
  await h.tick(13_000);
});

await scenario('the direct path stalls, falls back to the relay and tries again one window later', { peerHost: true }, async (h) => {
  await h.promote();
  await h.send({ id: 41 });
  await h.tick(12_000);
  await h.tick(20_000);
  await h.tick(30_000);
  await h.tick(49_000);
  await h.tick(49_600);
  await h.tick(60_000);
});

await scenario('a path that never opens times out', { peerHost: true }, async (h) => {
  await h.tick();
  await h.receive('relay', h.control({ ...h.ref(), t: 'answer', sdp: SDP, fingerprints: FINGERPRINTS }));
  await h.tick(30_000);
  await h.tick(49_600);
  await h.tick(60_000);
});

await scenario('a path whose message size is too small is never offered again', { peerHost: true }, async (h) => {
  await h.tick();
  await h.peerEvent('open', { maxMessageSize: 1000, relayed: false });
  await h.tick(60_000);
  await h.tick(90_000);
});

await scenario('a missing peer host or a refused offer retries once per window', { peerHost: true, createThrows: [1], offer: 'reject' }, async (h) => {
  await h.tick();
  await h.tick(10_100);
  await h.tick(49_600);
  await h.tick(50_000);
  await h.tick(100_000);
});

await scenario('the ICE set that cannot be resolved or parsed is offered empty', { peerHost: true, ice: 'reject' }, async (h) => {
  await h.tick();
});

await scenario('an ICE set that does not parse is offered empty', { peerHost: true, ice: 'invalid' }, async (h) => {
  await h.tick();
});

await scenario('a restart close names the newest offer; stale names are ignored; the previous offer is kept for one window', { peerHost: true }, async (h) => {
  await h.promote();
  await h.receive('relay', h.control({ ...h.ref(9, 9), t: 'close', reason: 'restart' }));
  await h.receive('relay', h.control({ ...h.ref(1, 5), t: 'close', reason: 'restart' }));
  await h.receive('relay', h.control({ ...h.ref(), t: 'close', reason: 'restart' }));
  await h.tick(49_600);
  await h.receive('relay', h.control({ ...h.ref(), t: 'close', reason: 'restart' }));
  await h.receive('relay', h.control({ ...h.ref(2, 2), t: 'close', reason: 'restart' }));
  await h.tick(49_700);
  await h.tick(100_000);
  await h.receive('relay', h.control({ ...h.ref(1), t: 'close', reason: 'channel-failed' }));
});

await scenario('a suspend close from the phone stops new peers until it asks for a restart', { peerHost: true }, async (h) => {
  await h.promote();
  await h.receive('relay', h.control({ ...h.ref(), t: 'close', reason: 'suspended' }));
  await h.tick(60_000);
  await h.receive('relay', h.control({ ...h.ref(), t: 'close', reason: 'restart' }));
  await h.tick(100_000);
});

await scenario('a peer that fails reports its reason; a TURN path is counted', { peerHost: true }, async (h) => {
  await h.tick();
  await h.peerEvent('open', { maxMessageSize: 262144, relayed: true });
  const ping = h.lastPing(`direct:1:${h.connection(1)}`);
  await h.receive(h.direct(1), h.control({ v: 1, t: 'pong', id: ping.id }));
  await h.send({ id: 51 });
  await h.peerEvent('closed', { reason: 'ice-failed' });
  await h.tick(60_000);
  await h.peerEvent('closed', { reason: 'dtls-failed' });
});

await scenario('an answer the peer refuses closes the attempt; a peer that refuses a send keeps the record', { peerHost: true, answer: 'reject' }, async (h) => {
  await h.tick();
  await h.receive('relay', h.control({ ...h.ref(), t: 'answer', sdp: SDP, fingerprints: FINGERPRINTS }));
  await h.receive('relay', h.control({ ...h.ref(), t: 'answer', sdp: SDP, fingerprints: FINGERPRINTS }));
});

await scenario('signals the coordinator cannot accept', { peerHost: true }, async (h) => {
  await h.tick();
  await h.receive('relay', h.control({ ...h.ref(), t: 'offer', sdp: SDP, fingerprints: FINGERPRINTS, iceServers: [] }));
  await h.receive('relay', h.control({ ...h.ref(), t: 'answer', sdp: SDP }));
  await h.receive(h.direct(), h.control({ ...h.ref(), t: 'answer', sdp: SDP, fingerprints: FINGERPRINTS }));
  await h.receive('relay', h.control({ ...h.ref(), sessionId: 'T'.repeat(43), t: 'close', reason: 'stall' }));
  await h.receive('relay', h.control({ ...h.ref(), t: 'close', reason: 'stall' }));
});

await scenario('a refused peer send keeps the record for the next flush', { peerHost: true }, async (h) => {
  await h.promote();
  await h.set('refuse', true);
  await h.send({ id: 61 });
  await h.set('refuse', false);
  await h.peerEvent('drain');
  await h.close();
});

await scenario('a media adapter takes its messages and sends bulk records', { peerHost: false, media: true }, async (h) => {
  await h.receive('relay', h.record({ type: 'stub-media', op: 'request', id: 'm1' }, { sequence: 1 }));
  await h.receive('relay', h.record({ id: 1, plain: true }, { sequence: 2 }));
  await h.mediaCanAdmit('m1');
  await h.mediaSend({ type: 'transport-media', op: 'head', id: 'm1', status: 200 }, 'm1');
  await h.mediaSend({ type: 'transport-media', op: 'error', id: 'm2' });
  await h.receive('relay', h.control(h.ack(2)));
  await h.mediaCanAdmit('m1');
  await h.mediaProtocolError();
  await h.mediaSend({ type: 'transport-media', op: 'end', id: 'm1' }, 'm1');
});

await scenario('a control box that cannot be sealed ends the session', {}, async (h) => {
  await h.set('sealControl', 'fail');
  await h.receive('relay', h.record({ id: 1 }, { sequence: 1 }));
  await h.tick(10_200);
});

writeJson(join(stage, 'scenarios.json'), {
  domain: 'remote-transport-coordinator',
  recorder,
  convention: 'application box = MXE\\x01 | u64 sequence | 12 zero bytes | JSON text | 16 zero bytes; control box = MXC\\x01 likewise; a nonzero tag fails authentication; control messages are boxed as canonical JSON (keys sorted)',
  scenarios,
});
writeSetManifest(stage, {
  set: 'remote-transport-coordinator',
  recorder,
  command: `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${recorder} --tree <exact archive> --commit ${identity.commit}`,
  identity,
});
commitStage(stage, finalDir);
console.log(`recorded ${scenarios.length} scenarios, ${scenarios.reduce((n, s) => n + s.steps.length, 0)} steps`);
