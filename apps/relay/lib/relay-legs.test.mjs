import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { DESKTOP_HANDSHAKE_STALLED_CLOSE, runClientLeg, runDesktopLeg } from './relay-legs.mjs';
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

test('a missed handshake turn closes the PC leg only when the leg is also silent through a probe', async () => {
  const sendJson = (target, payload) => target.send(JSON.stringify(payload));
  // Live PC: busy with other traffic while one phone's challenge is late.
  {
    const desktop = fakeSocket();
    const entry = { socket: desktop, clients: new Map(), media: new Map(), mediaLane: false };
    desktopLeg(entry, desktop);
    runClientLeg(entry, sendJson, fakeSocket(), 'browser-1', { maxFrameBytes: 1024 });
    const chatter = setInterval(() => {
      desktop.emit('message', Buffer.from(JSON.stringify({ type: 'desktop-name', name: 'PC' })), false);
    }, 5);
    await sleep(150);
    clearInterval(chatter);
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
    await sleep(150);
    assert.equal(desktop.pings, 1, 'the silent leg is probed once');
    assert.equal(desktop.closed, null, 'a leg that answers its probe stays up');
  }
  // Dead PC: silent through the turn and the probe.
  {
    const desktop = fakeSocket();
    const entry = { socket: desktop, clients: new Map(), media: new Map(), mediaLane: false };
    desktopLeg(entry, desktop);
    runClientLeg(entry, sendJson, fakeSocket(), 'browser-1', { maxFrameBytes: 1024 });
    await sleep(150);
    assert.equal(desktop.pings, 1);
    assert.equal(desktop.closed?.code, DESKTOP_HANDSHAKE_STALLED_CLOSE);
  }
});

test('client-open omits the credential when the leg has none (older desktops)', () => {
  const sent = [];
  const entry = { socket: fakeSocket(), clients: new Map() };
  runClientLeg(entry, (_socket, payload) => sent.push(payload), fakeSocket(), null, { maxFrameBytes: 1024 });
  assert.equal(sent[0].type, 'client-open');
  assert.equal('browserClientId' in sent[0], false);
});
