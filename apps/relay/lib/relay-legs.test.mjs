import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { runClientLeg, runDesktopLeg } from './relay-legs.mjs';
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
});
