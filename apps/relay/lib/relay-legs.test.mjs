import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { decodeRelayBinaryFrame, encodeRelayBinaryFrame } from './relay-binary-frame.mjs';
import { DESKTOP_HANDSHAKE_STALLED_CLOSE, isTransportFrame, runClientLeg, runDesktopLeg } from './relay-legs.mjs';
import { newUplinkLeg } from './relay-transport.mjs';

function fakeSocket() {
  const socket = new EventEmitter();
  socket.OPEN = 1;
  socket.readyState = 1;
  socket.send = (data, callback) => {
    socket.sent.push(data);
    callback?.();
  };
  socket.close = (code, reason) => {
    socket.closed = { code, reason };
    socket.emit('close', code, reason);
  };
  socket.sent = [];
  socket.closed = null;
  return socket;
}

test('runClientLeg announces client-open and removes the socket on close', () => {
  const sent = [];
  const desktop = fakeSocket();
  const entry = { socket: desktop, clients: new Map() };
  const sendJson = (_socket, payload) => sent.push(payload);
  const phone = fakeSocket();
  runClientLeg(entry, sendJson, phone, 'browser-1', { maxFrameBytes: 1024 });
  assert.equal(entry.clients.size, 1);
  assert.equal(sent[0].type, 'client-open');
  assert.equal(typeof sent[0].clientId, 'string');
  assert.equal(phone.browserClientId, 'browser-1');
  // The authenticated credential rides along so the desktop can key trust on it.
  assert.equal(sent[0].browserClientId, 'browser-1');
  phone.emit('close', 1000, 'background');
  assert.equal(entry.clients.size, 0);
  assert.equal(sent[1].type, 'client-close');
  assert.equal(sent[1].clientId, sent[0].clientId);
});

test('runDesktopLeg publishes capabilities and replays live phone ids', () => {
  const sent = [];
  const existing = fakeSocket();
  existing.browserClientId = 'browser-1';
  const desktop = fakeSocket();
  desktop.uplinkLeg = newUplinkLeg(64 * 1024);
  const entry = { socket: desktop, clients: new Map([['live-client', existing]]), media: new Map(), mediaLane: false };
  const sendJson = (_socket, payload) => sent.push(payload);
  runDesktopLeg(
    {
      store: {},
      sendJson,
      attachDesktop: () => entry,
      liveDesktops: new Map([['dev', entry]]),
      claims: new Map(),
      maxFrameBytes: 1024,
    },
    'dev',
    desktop
  );
  assert.equal(sent[0].type, 'relay-capabilities');
  assert.equal(sent[1].type, 'client-open');
  assert.equal(sent[1].clientId, 'live-client');
  assert.equal(sent[1].browserClientId, 'browser-1');
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A desktop leg wired the way server.mjs wires it, over fake sockets. */
function desktopLeg(entry, socket, options = {}) {
  socket.uplinkLeg = newUplinkLeg(64 * 1024);
  socket.ping = () => {
    socket.pings = (socket.pings || 0) + 1;
  };
  runDesktopLeg(
    {
      store: {},
      sendJson: (target, payload) => target.send(JSON.stringify(payload)),
      attachDesktop: () => {
        entry.socket = socket;
        return entry;
      },
      liveDesktops: new Map([['dev', entry]]),
      claims: new Map(),
      maxFrameBytes: 1024,
      handshakeStallMs: 30,
      livenessProbeMs: 30,
      ...options,
    },
    'dev',
    socket
  );
}

const sentTypes = (socket) => socket.sent.map((raw) => JSON.parse(raw).type);

test('a phone the PC rejected never holds the PC to a handshake turn, even if it withholds its close', async () => {
  const desktop = fakeSocket();
  const entry = { socket: desktop, clients: new Map(), media: new Map(), mediaLane: false };
  desktopLeg(entry, desktop);
  const phone = fakeSocket();
  // A phone that never acknowledges the relay's close: no 'close' event, so
  // it stays in the client map, CLOSING.
  phone.close = (code, reason) => {
    phone.closed = { code, reason };
    phone.readyState = 2;
  };
  runClientLeg(entry, (target, payload) => target.send(JSON.stringify(payload)), phone, 'browser-1', {
    maxFrameBytes: 1024,
  });
  const clientId = JSON.parse(desktop.sent.find((raw) => JSON.parse(raw).type === 'client-open')).clientId;
  desktop.emit('message', Buffer.from(JSON.stringify({ type: 'close-client', clientId, reason: 'limit' })), false);
  assert.equal(phone.closed.code, 4004);
  await sleep(150);
  assert.equal(desktop.closed, null, 'the PC answered the phone with a rejection; its leg stays up');
  assert.equal(desktop.pings || 0, 0, 'no liveness probe for a turn that was answered');

  // A replacement leg is not told about the closing phone, and owes it nothing.
  const replacement = fakeSocket();
  desktopLeg(entry, replacement);
  assert.ok(!sentTypes(replacement).includes('client-open'), 'a closing phone is never replayed');
  await sleep(150);
  assert.equal(replacement.closed, null);
});

test('a missed handshake turn closes the PC leg only when the leg is also silent through a probe', (t) => {
  const sendJson = (target, payload) => target.send(JSON.stringify(payload));
  // Deterministic time: the relay's turn timers are mocked, and so is the
  // monotonic clock it compares "heard since" against. Time passes in 5 ms
  // steps; `each` is what happens on the wire after every step.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1_000;
  t.mock.method(performance, 'now', () => clock);
  const pass = (ms, each) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 5) {
      clock += 5;
      t.mock.timers.tick(5);
      each?.();
    }
  };
  // Live PC: busy with other traffic while one phone's challenge is late.
  {
    const desktop = fakeSocket();
    const entry = { socket: desktop, clients: new Map(), media: new Map(), mediaLane: false };
    desktopLeg(entry, desktop);
    runClientLeg(entry, sendJson, fakeSocket(), 'browser-1', { maxFrameBytes: 1024 });
    pass(150, () => {
      desktop.emit('message', Buffer.from(JSON.stringify({ type: 'desktop-name', name: 'PC' })), false);
    });
    assert.equal(desktop.closed, null, 'a slow handshake on a responsive PC never costs the shared leg');
  }
  // Quiet but alive PC: it answers the probe.
  {
    const desktop = fakeSocket();
    const entry = { socket: desktop, clients: new Map(), media: new Map(), mediaLane: false };
    desktopLeg(entry, desktop);
    desktop.ping = () => {
      desktop.pings = (desktop.pings || 0) + 1;
      setTimeout(() => desktop.emit('pong'), 5);
    };
    runClientLeg(entry, sendJson, fakeSocket(), 'browser-1', { maxFrameBytes: 1024 });
    pass(150);
    assert.equal(desktop.pings, 1, 'the silent leg is probed once');
    assert.equal(desktop.closed, null, 'a leg that answers its probe stays up');
  }
  // Dead PC: silent through the turn and the probe.
  {
    const desktop = fakeSocket();
    const entry = { socket: desktop, clients: new Map(), media: new Map(), mediaLane: false };
    desktopLeg(entry, desktop);
    runClientLeg(entry, sendJson, fakeSocket(), 'browser-1', { maxFrameBytes: 1024 });
    pass(150);
    assert.equal(desktop.pings, 1);
    assert.equal(desktop.closed?.code, DESKTOP_HANDSHAKE_STALLED_CLOSE);
  }
});

test('parked phones are told once when the PC leg closes, then once a second per phone while calls go nowhere', (t) => {
  const sendJson = (target, payload) => target.send(JSON.stringify(payload));
  const desktop = fakeSocket();
  const entry = { socket: desktop, clients: new Map(), media: new Map(), mediaLane: false };
  desktopLeg(entry, desktop);
  const first = fakeSocket();
  const second = fakeSocket();
  runClientLeg(entry, sendJson, first, 'browser-1', { maxFrameBytes: 1024 });
  runClientLeg(entry, sendJson, second, 'browser-2', { maxFrameBytes: 1024 });
  const notice = JSON.stringify({ resync: 'desktop-gone' });

  // A live PC: calls are carried and nobody is told anything.
  first.emit('message', Buffer.from('{"call":1}'), false);
  assert.deepEqual(first.sent, []);

  // The PC leg closes: every parked phone hears it, in the cleartext resync shape.
  desktop.readyState = 3;
  desktop.emit('close', 1006, '');
  assert.deepEqual(first.sent, [notice]);
  assert.deepEqual(second.sent, [notice]);

  // Calls into the gap are told again, but never more than once a second.
  let now = Date.now() + 5_000;
  t.mock.method(Date, 'now', () => now);
  first.emit('message', Buffer.from('{"call":2}'), false);
  first.emit('message', Buffer.from('{"call":3}'), false);
  first.emit('message', Buffer.from([1, 2, 3]), true);
  assert.deepEqual(first.sent, [notice, notice]);
  assert.deepEqual(second.sent, [notice], 'a quiet phone is not told again');
  now += 1_000;
  first.emit('message', Buffer.from('{"call":4}'), false);
  assert.deepEqual(first.sent, [notice, notice, notice]);

  // Pings are still answered by the relay and are not calls.
  now += 5_000;
  first.emit('message', Buffer.from('{"ping":1}'), false);
  assert.equal(first.sent.at(-1), '{"pong":1}');
  assert.equal(first.sent.length, 4);
});

test('a superseded PC leg closing does not tell phones the PC is gone', () => {
  const sendJson = (target, payload) => target.send(JSON.stringify(payload));
  const old = fakeSocket();
  const entry = { socket: old, clients: new Map(), media: new Map(), mediaLane: false };
  desktopLeg(entry, old);
  const phone = fakeSocket();
  runClientLeg(entry, sendJson, phone, 'browser-1', { maxFrameBytes: 1024 });
  const replacement = fakeSocket();
  desktopLeg(entry, replacement);
  old.readyState = 3;
  old.emit('close', 1006, '');
  assert.deepEqual(phone.sent, []);
});

// --- Direct-transport frames are never dropped the way pushes are -----------

const MIB = 1024 * 1024;
const TRANSPORT_BYTES = Buffer.concat([Buffer.from([0x4d, 0x58, 0x54, 0x01, 0x01]), Buffer.alloc(64, 7)]);
// A legacy E2EE binary box (`MXE\x01`): a pushed state frame, recoverable by resync.
const LEGACY_BYTES = Buffer.concat([Buffer.from([0x4d, 0x58, 0x45, 0x01]), Buffer.alloc(64, 9)]);

/** A PC leg with one attached phone; `phone.bufferedAmount` is the phone's queue. */
function routedPhone(bufferedAmount = 0, maxFrameBytes = 4096) {
  const entry = { socket: null, clients: new Map(), media: new Map(), mediaLane: false };
  const desktop = fakeSocket();
  desktopLeg(entry, desktop, { handshakeStallMs: 60_000, maxFrameBytes });
  const phone = fakeSocket();
  runClientLeg(entry, (target, payload) => target.send(JSON.stringify(payload)), phone, 'browser-1', {
    maxFrameBytes,
  });
  phone.bufferedAmount = bufferedAmount;
  const clientId = [...entry.clients.keys()][0];
  return {
    desktop,
    phone,
    entry,
    clientId,
    binary: (data, droppable) => desktop.emit('message', encodeRelayBinaryFrame({ clientId, data, droppable }), true),
    text: (data, droppable) =>
      desktop.emit('message', Buffer.from(JSON.stringify({ type: 'frame', clientId, data, droppable })), false),
    broadcast: (data, critical) =>
      desktop.emit('message', Buffer.from(JSON.stringify({ type: 'broadcast', data, critical })), false),
  };
}

const delivered = (phone, data) => phone.sent.some((sent) => Buffer.isBuffer(sent) && sent.equals(data));
const resyncHints = (phone) => phone.sent.filter((sent) => sent === '{"resync":1}').length;

test('isTransportFrame recognises MXT\\x01 in clear and nothing else', () => {
  assert.equal(isTransportFrame(TRANSPORT_BYTES), true);
  assert.equal(isTransportFrame(new Uint8Array(TRANSPORT_BYTES)), true);
  assert.equal(isTransportFrame(LEGACY_BYTES), false);
  assert.equal(isTransportFrame(Buffer.from([0x4d, 0x58, 0x54, 0x02])), false);
  assert.equal(isTransportFrame(Buffer.from([0x4d, 0x58, 0x54])), false);
  assert.equal(isTransportFrame('MXT\x01 text'), false);
});

test('a transport frame marked droppable is still delivered to a phone past the push-skip mark', () => {
  const { phone, binary } = routedPhone(2 * MIB);
  binary(TRANSPORT_BYTES, true);
  assert.equal(delivered(phone, TRANSPORT_BYTES), true);
  assert.equal(resyncHints(phone), 0);
  assert.equal(phone.closed, null);
});

test('a full phone queue cuts the leg for a transport frame instead of silently dropping it', () => {
  const { phone, binary } = routedPhone(9 * MIB);
  binary(TRANSPORT_BYTES, true);
  assert.equal(delivered(phone, TRANSPORT_BYTES), false);
  // Not a drop: no resync hint stands in for it, and the phone is told by the cut.
  assert.equal(resyncHints(phone), 0);
  assert.deepEqual(phone.closed, { code: 4008, reason: 'slow consumer' });
});

test('a box that cannot carry a transport frame cuts the leg, never defers or drops it', () => {
  const { phone, binary } = routedPhone();
  phone.inflightCeiling = 8;
  binary(TRANSPORT_BYTES, true);
  assert.equal(delivered(phone, TRANSPORT_BYTES), false);
  assert.equal(resyncHints(phone), 0);
  assert.deepEqual(phone.closed, { code: 4009, reason: 'relay busy' });
});

test('legacy droppable frames keep dropping: skipped past 1 MiB, dropped at a full queue, with a resync hint', () => {
  for (const buffered of [2 * MIB, 9 * MIB]) {
    const { phone, binary } = routedPhone(buffered);
    binary(LEGACY_BYTES, true);
    assert.equal(delivered(phone, LEGACY_BYTES), false);
    assert.equal(resyncHints(phone), 1);
    assert.equal(phone.closed, null);
  }
});

test('legacy non-droppable frames keep their behavior: delivered when queued, cut at a full queue', () => {
  const queued = routedPhone(2 * MIB);
  queued.binary(LEGACY_BYTES, false);
  assert.equal(delivered(queued.phone, LEGACY_BYTES), true);
  const full = routedPhone(9 * MIB);
  full.binary(LEGACY_BYTES, false);
  assert.deepEqual(full.phone.closed, { code: 4008, reason: 'slow consumer' });
});

test('legacy text frames and broadcasts keep their droppable behavior', () => {
  const textDrop = routedPhone(2 * MIB);
  textDrop.text('{"legacy":1}', true);
  assert.deepEqual(textDrop.phone.sent, ['{"resync":1}']);
  const textKeep = routedPhone(2 * MIB);
  textKeep.text('{"legacy":2}', false);
  assert.deepEqual(textKeep.phone.sent, ['{"legacy":2}']);
  const cast = routedPhone(2 * MIB);
  cast.broadcast('{"state":1}', false);
  assert.deepEqual(cast.phone.sent, ['{"resync":1}']);
  const critical = routedPhone(2 * MIB);
  critical.broadcast('{"state":2}', true);
  assert.deepEqual(critical.phone.sent, ['{"state":2}']);
});

// --- A leg's transport frames are forwarded FIFO in both directions ----------

/** Transport frame number `n` (`MXT\x01`, u16 n, padding up to `size` bytes). */
function numbered(n, size) {
  const frame = Buffer.alloc(size, n & 0xff);
  frame.set([0x4d, 0x58, 0x54, 0x01, n >> 8, n & 0xff], 0);
  return frame;
}
const numberOf = (frame) => frame.readUInt16BE(4);
const transportNumbers = (sent) => sent.filter((data) => Buffer.isBuffer(data) && isTransportFrame(data)).map(numberOf);

/** Hold every flush callback of `socket`'s sends, as a congested peer does.
 *  `bufferedAmount` is what is held; `flush(count)` releases the oldest first. */
function holdFlushes(socket) {
  const held = [];
  socket.bufferedAmount = 0;
  socket.send = (data, callback) => {
    socket.sent.push(data);
    const size = Buffer.byteLength(data);
    socket.bufferedAmount += size;
    held.push({ size, callback });
  };
  return {
    pending: () => held.length,
    flush: (count = held.length) => {
      for (const { size, callback } of held.splice(0, count)) {
        socket.bufferedAmount -= size;
        callback?.();
      }
    },
  };
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

test('downstream: transport frames reach a pressured phone in the order the PC sent them, flush by flush', () => {
  const { phone, binary } = routedPhone(0, 2 * MIB);
  const wire = holdFlushes(phone);
  const frame = (n) => numbered(n, 700 * 1024);
  // The sender's droppable flag varies; a legacy droppable frame sent while
  // the phone is past the push-skip mark is dropped, and never lands between
  // transport frames or moves them.
  binary(frame(1), true);
  binary(frame(2), false);
  binary(LEGACY_BYTES, true);
  binary(frame(3), true);
  binary(frame(4), false);
  assert.ok(phone.bufferedAmount > MIB, 'the phone is under real pressure');
  assert.deepEqual(transportNumbers(phone.sent), [1, 2, 3, 4]);
  assert.equal(delivered(phone, LEGACY_BYTES), false);
  // Flushes release oldest first; frames sent meanwhile queue behind the rest.
  wire.flush(2);
  binary(frame(5), true);
  binary(frame(6), false);
  wire.flush(1);
  binary(frame(7), true);
  assert.deepEqual(transportNumbers(phone.sent), range(1, 7));
  wire.flush();
  binary(frame(8), false);
  assert.deepEqual(transportNumbers(phone.sent), range(1, 8));
  wire.flush();
  assert.equal(phone.closed, null);
  assert.equal(phone.bufferedAmount, 0);
});

test('upstream: transport frames reach the PC in the order the phone sent them, flush by flush', () => {
  const { desktop, phone, clientId, entry } = routedPhone(0, 128 * 1024);
  const base = desktop.sent.length;
  const wire = holdFlushes(desktop);
  const arrived = () =>
    desktop.sent
      .slice(base)
      .filter(Buffer.isBuffer)
      .map((raw) => decodeRelayBinaryFrame(raw))
      .map((decoded) => {
        assert.equal(decoded.clientId, clientId);
        return decoded.data;
      });
  const up = (n) => phone.emit('message', numbered(n, 60_000), true);
  for (const n of range(1, 6)) up(n);
  assert.deepEqual(arrived().map(numberOf), range(1, 6));
  wire.flush(4);
  for (const n of range(7, 9)) up(n);
  assert.deepEqual(arrived().map(numberOf), range(1, 9));
  wire.flush();
  up(10);
  assert.deepEqual(arrived().map(numberOf), range(1, 10));
  wire.flush();
  assert.equal(phone.closed, null);
  assert.equal(entry.clients.size, 1);
});

test('upstream: an exhausted queue cuts the phone leg after a contiguous prefix, never a silent loss', () => {
  const { desktop, phone, entry } = routedPhone(0, 128 * 1024);
  const base = desktop.sent.length;
  const wire = holdFlushes(desktop);
  let sentCount = 0;
  // The PC does not drain: nothing flushes. The phone keeps sending until the
  // relay refuses; it must refuse by cutting the leg.
  while (phone.closed === null && sentCount < 400) {
    sentCount += 1;
    phone.emit('message', numbered(sentCount, 60_000), true);
  }
  assert.deepEqual(phone.closed, { code: 4008, reason: 'slow consumer' });
  const arrived = desktop.sent
    .slice(base)
    .filter(Buffer.isBuffer)
    .map((raw) => decodeRelayBinaryFrame(raw).data);
  const numbers = arrived.map(numberOf);
  // What the PC got is exactly frames 1..k, in order, no hole; the frame that
  // met the full queue (and anything after it) was not delivered, and the
  // leg was cut at that very frame.
  assert.ok(numbers.length > 100 && numbers.length < sentCount, `delivered ${numbers.length} of ${sentCount}`);
  assert.deepEqual(numbers, range(1, numbers.length));
  assert.equal(sentCount, numbers.length + 1);
  assert.ok(wire.pending() >= numbers.length, 'every delivered frame was still unflushed when the leg was cut');
  assert.ok(arrived.reduce((sum, data) => sum + data.length, 0) <= 8 * MIB);
  // Only this phone is cut; the shared PC leg stays up and is told the phone left.
  assert.equal(desktop.closed, null);
  assert.equal(entry.clients.size, 0);
  const closes = desktop.sent
    .slice(base)
    .filter((raw) => typeof raw === 'string' && JSON.parse(raw).type === 'client-close');
  assert.equal(closes.length, 1);
  wire.flush();
});

test('client-open omits the credential when the leg has none (older desktops)', () => {
  const sent = [];
  const entry = { socket: fakeSocket(), clients: new Map() };
  runClientLeg(entry, (_socket, payload) => sent.push(payload), fakeSocket(), null, { maxFrameBytes: 1024 });
  assert.equal(sent[0].type, 'client-open');
  assert.equal('browserClientId' in sent[0], false);
});
