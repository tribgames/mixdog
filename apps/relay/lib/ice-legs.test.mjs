import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { startRelay } from '../server.mjs';
import { createIceService, requestIceServers } from './ice-legs.mjs';
import { RateLimiter } from './rate-limit.mjs';
import { turnConfigFromEnv, verifyTurnCredential } from './turn-credentials.mjs';

const TURN_SECRET = 'c'.repeat(64);
// The request limit is a deploy-time decision; the tests pick one.
const ISSUE_LIMIT = 3;
const TURN_ENV = {
  TURN_AUTH_SECRET: TURN_SECRET,
  TURN_HOST: 'relay.example.com',
  TURN_TLS_PORT: '5349',
  TURN_ISSUE_LIMIT: String(ISSUE_LIMIT),
};
const NOW = Date.UTC(2030, 0, 1, 12, 0, 0);
/** Request ids as the desktop mints them (randomUUID). */
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The slice of the device store the handler reads. */
const storeWith = (pairings) => ({ listClients: (deviceId) => (pairings[deviceId] ?? []).map((id) => ({ id })) });

function iceService(now = () => NOW, lines = []) {
  return createIceService(turnConfigFromEnv(TURN_ENV), { now, log: (line) => lines.push(line) });
}

function legFor(deviceId, { store, ice = iceService() } = {}) {
  const sent = [];
  return { leg: { ice, store, deviceId, socket: {}, sendJson: (_socket, payload) => sent.push(payload) }, sent };
}

test('an unpaired device is refused: no credential, only the public STUN URL', () => {
  const { leg, sent } = legFor('device-a', { store: storeWith({}) });
  requestIceServers(leg, { type: 'ice-servers-request', requestId: id(1) });
  assert.deepEqual(sent, [
    { type: 'ice-servers', requestId: id(1), ok: false, error: 'not-paired', stun: ['stun:relay.example.com:3478'] },
  ]);
  assert.equal(JSON.stringify(sent).includes('credential'), false);
  assert.equal(JSON.stringify(sent).includes('username'), false);
});

test('a device with a paired phone gets a credential coturn would accept, until it expires', () => {
  const { leg, sent } = legFor('device-a', { store: storeWith({ 'device-a': ['phone-1'] }) });
  requestIceServers(leg, { type: 'ice-servers-request', requestId: id(1) });
  const [reply] = sent;
  assert.equal(reply.type, 'ice-servers');
  assert.equal(reply.requestId, id(1));
  assert.equal(reply.ok, true);
  assert.equal(reply.ttlSeconds, 86_400);
  assert.equal(reply.expiresAt, NOW / 1000 + 86_400);
  assert.equal(reply.remainingMs, 86_400_000);
  const [stun, turn] = reply.servers;
  assert.deepEqual(stun, { urls: ['stun:relay.example.com:3478'] });
  assert.deepEqual(turn.urls, [
    'turn:relay.example.com:3478?transport=udp',
    'turn:relay.example.com:3478?transport=tcp',
    'turns:relay.example.com:5349?transport=tcp',
  ]);
  const check = (nowMs) =>
    verifyTurnCredential({ secret: TURN_SECRET, username: turn.username, credential: turn.credential, nowMs });
  assert.equal(check(NOW), true);
  assert.equal(check(NOW + 86_400_000), false);
  // The device's routing id never travels in the STUN username.
  assert.equal(turn.username.includes('device-a'), false);
});

test('credentials are per device; issuance is limited per device to the configured count, with the wait named', () => {
  const store = storeWith({ 'device-a': ['phone-1'], 'device-b': ['phone-2'] });
  const lines = [];
  const ice = iceService(() => NOW, lines);
  const a = legFor('device-a', { store, ice });
  const b = legFor('device-b', { store, ice });
  for (let index = 0; index < ISSUE_LIMIT; index += 1) {
    requestIceServers(a.leg, { requestId: id(index) });
  }
  assert.equal(a.sent.every((reply) => reply.ok === true), true);
  requestIceServers(a.leg, { requestId: id(99) });
  const refusal = a.sent.at(-1);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.error, 'rate-limited');
  assert.deepEqual(refusal.stun, ['stun:relay.example.com:3478']);
  // The limit is per credential lifetime (86 400 s): the wait is under that and above zero.
  assert.ok(refusal.retryAfterMs > 0 && refusal.retryAfterMs <= 86_400_000, String(refusal.retryAfterMs));
  requestIceServers(b.leg, { requestId: id(50) });
  assert.equal(b.sent[0].ok, true);
  assert.notEqual(b.sent[0].servers[1].username, a.sent[0].servers[1].username);
  // Issued and refused requests are logged by device prefix only, for sizing the limit.
  assert.equal(lines.filter((line) => line.startsWith('[relay] ice-servers issued device=device-a')).length, ISSUE_LIMIT);
  assert.ok(lines.includes('[relay] ice-servers refused cause=rate-limited device=device-a'));
  assert.equal(lines.some((line) => line.includes(TURN_SECRET) || line.includes('credential')), false);
});

test('the limiter reports when a limited key is admitted again', () => {
  const limiter = new RateLimiter(2, 60_000);
  assert.equal(limiter.retryAfterMs('k'), 0);
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.retryAfterMs('k'), 0, 'under the limit');
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.allow('k'), false);
  const wait = limiter.retryAfterMs('k');
  assert.ok(wait > 59_000 && wait <= 60_000, String(wait));
  assert.equal(limiter.retryAfterMs('other'), 0);
  // Hits that have aged out no longer hold the key back.
  limiter.hits.set('k', [Date.now() - 61_000, Date.now() - 60_500]);
  assert.equal(limiter.retryAfterMs('k'), 0);
});

test('a request id that is not a routing id is dropped, never truncated or echoed', () => {
  const { leg, sent } = legFor('device-a', { store: storeWith({ 'device-a': ['phone-1'] }) });
  requestIceServers(leg, { type: 'ice-servers-request' });
  requestIceServers(leg, { requestId: 7 });
  requestIceServers(leg, { requestId: 'r1' });
  requestIceServers(leg, { requestId: `${'a'.repeat(64)}0` });
  requestIceServers(leg, { requestId: 'A'.repeat(36) });
  assert.deepEqual(sent, []);
  // 64 characters is the shared routing-id bound (lib/ids.mjs) and is still answered whole.
  requestIceServers(leg, { requestId: 'a'.repeat(64) });
  assert.equal(sent[0].requestId, 'a'.repeat(64));
});

test('a relay without TURN settings gets no answer', () => {
  const none = legFor('device-a', { store: storeWith({}), ice: null });
  requestIceServers(none.leg, { requestId: id(1) });
  assert.deepEqual(none.sent, []);
  assert.equal(createIceService(null), null);
});

// ---- the real relay: capability, wiring, authorization over a desktop leg ----

const DEVICE_SECRET = '0123456789abcdef';

async function desktopLeg(relay, deviceId) {
  const messages = [];
  const waiters = [];
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
    headers: { Authorization: `Basic ${Buffer.from(`${deviceId}:${DEVICE_SECRET}`).toString('base64')}` },
  });
  socket.on('message', (raw) => {
    messages.push(JSON.parse(String(raw)));
    for (const waiter of [...waiters]) waiter();
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const next = (type, skip = 0) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${type} after ${skip}`)), 2000);
      const check = () => {
        const found = messages.filter((message) => message.type === type);
        if (found.length > skip) {
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(found[skip]);
        }
      };
      waiters.push(check);
      check();
    });
  return {
    socket,
    next,
    count: (type) => messages.filter((message) => message.type === type).length,
    send: (payload) => socket.send(JSON.stringify(payload)),
  };
}

async function relayWith(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-ice-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), ...options });
  t.after(() => relay.close());
  return relay;
}

test('over a real desktop leg: the relay advertises ice, refuses until a phone is paired, then issues', async (t) => {
  const relay = await relayWith(t, { turnEnv: TURN_ENV });
  const deviceId = randomUUID();
  relay.store.authenticate(deviceId, DEVICE_SECRET);
  const desktop = await desktopLeg(relay, deviceId);
  t.after(() => desktop.socket.terminate());
  assert.equal((await desktop.next('relay-capabilities')).ice, 1);

  desktop.send({ type: 'ice-servers-request', requestId: id(1) });
  const refused = await desktop.next('ice-servers', 0);
  assert.equal(refused.requestId, id(1));
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'not-paired');

  assert.ok(relay.store.registerClient(deviceId, 'aaaaaaaa', {}));
  desktop.send({ type: 'ice-servers-request', requestId: id(2) });
  const issued = await desktop.next('ice-servers', 1);
  assert.equal(issued.requestId, id(2));
  assert.equal(issued.ok, true);
  assert.ok(issued.remainingMs > 86_399_000 && issued.remainingMs <= 86_400_000, String(issued.remainingMs));
  const turn = issued.servers[1];
  assert.equal(
    verifyTurnCredential({ secret: TURN_SECRET, username: turn.username, credential: turn.credential, nowMs: Date.now() }),
    true
  );
  assert.equal(JSON.stringify(issued).includes(TURN_SECRET), false);

  // Revoking the last phone ends eligibility.
  assert.equal(relay.store.revokeClient(deviceId, 'aaaaaaaa'), true);
  desktop.send({ type: 'ice-servers-request', requestId: id(3) });
  assert.equal((await desktop.next('ice-servers', 2)).error, 'not-paired');
});

test('a relay without usable TURN settings advertises nothing and never answers', async (t) => {
  const { TURN_ISSUE_LIMIT: _limit, ...withoutLimit } = TURN_ENV;
  for (const turnEnv of [{}, { ...TURN_ENV, TURN_AUTH_SECRET: 'short' }, withoutLimit]) {
    const relay = await relayWith(t, { turnEnv });
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, DEVICE_SECRET);
    relay.store.registerClient(deviceId, 'aaaaaaaa', {});
    const desktop = await desktopLeg(relay, deviceId);
    t.after(() => desktop.socket.terminate());
    assert.equal((await desktop.next('relay-capabilities')).ice, undefined);
    desktop.send({ type: 'ice-servers-request', requestId: id(1) });
    // `list-clients` is answered in order on the same leg: once it has come
    // back, the ice request before it has been handled and produced nothing.
    desktop.send({ type: 'list-clients', requestId: 'barrier' });
    await desktop.next('clients-list');
    assert.equal(desktop.count('ice-servers'), 0);
  }
});
