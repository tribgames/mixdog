import assert from 'node:assert/strict';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { startRelay } from '../server.mjs';
import {
  SUBSCRIPTIONS_FILE,
  VAPID_FILE,
  createWebPushRegistry,
  createWebPushSender,
  loadOrCreateVapidKeys,
  vapidAuthorization,
  validWebPushEndpoint,
} from './web-push.mjs';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
const tempDir = (t) => {
  const dir = makeTempDirSync('relay-webpush');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** The uncompressed point back to a KeyObject, as a push service reads `k=`. */
function publicKeyFromRaw(raw) {
  const bytes = Buffer.from(raw, 'base64url');
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: bytes.subarray(1, 33).toString('base64url'),
      y: bytes.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
}

/** Verifies an `Authorization: vapid t=…, k=…` header the way a push service does. */
function verifyVapid(header, endpoint) {
  const match = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/u.exec(header);
  assert.ok(match, header);
  const [jwtHeader, claims, signature] = match[1].split('.');
  assert.deepEqual(JSON.parse(Buffer.from(jwtHeader, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const body = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(body.aud, new URL(endpoint).origin);
  assert.ok(body.exp > Date.now() / 1000 && body.exp <= Date.now() / 1000 + 24 * 3600);
  assert.match(body.sub, /^mailto:/u);
  assert.equal(
    verify(
      'sha256',
      Buffer.from(`${jwtHeader}.${claims}`),
      { key: publicKeyFromRaw(match[2]), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url')
    ),
    true
  );
  return match[2];
}

test('the relay mints its VAPID identity once, keeps it, and signs with it', (t) => {
  const dir = tempDir(t);
  const first = loadOrCreateVapidKeys(dir);
  assert.match(first.publicKey, /^[A-Za-z0-9_-]{87}$/u);
  assert.equal(Buffer.from(first.publicKey, 'base64url')[0], 0x04);
  const stored = JSON.parse(readFileSync(join(dir, VAPID_FILE), 'utf8'));
  assert.equal(stored.publicKey, first.publicKey);
  // A restart reads the same identity: rotating it would strand every subscription.
  const second = loadOrCreateVapidKeys(dir);
  assert.equal(second.publicKey, first.publicKey);
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
  assert.equal(verifyVapid(vapidAuthorization({ endpoint, keys: second }), endpoint), first.publicKey);
});

test('an unreadable identity disables web push instead of being replaced', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, VAPID_FILE), '{"publicKey":"x","privateKeyJwk":{}}');
  assert.equal(loadOrCreateVapidKeys(dir, { log: () => {} }), null);
  assert.equal(readFileSync(join(dir, VAPID_FILE), 'utf8'), '{"publicKey":"x","privateKeyJwk":{}}');
});

test('only endpoints on a known push service are accepted, in one canonical spelling', () => {
  for (const good of [
    'https://fcm.googleapis.com/fcm/send/a',
    'https://fcm.googleapis.com/wp/a',
    'https://updates.push.services.mozilla.com/wpush/v2/a',
    'https://web.push.apple.com/a',
    'https://wns2-par02p.notify.windows.com/w/?token=a',
  ]) {
    assert.equal(validWebPushEndpoint(good), good, good);
  }
  // Case and trailing root dots name the same host: matched and stored canonical.
  assert.equal(validWebPushEndpoint('https://FCM.googleapis.com./fcm/send/a'), 'https://fcm.googleapis.com/fcm/send/a');
  for (const bad of [
    'http://fcm.googleapis.com/a',
    'https://127.0.0.1/a',
    'https://[::1]/a',
    'https://localhost/a',
    'https://localhost./x',
    'https://service.internal./x',
    'https://intranet/a',
    // Public names resolve wherever their owner points them.
    'https://push.example.com/a',
    'https://evil.example/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.example/a',
    'https://evilpush.apple.com/a',
    'https://push.apple.com.evil.example./a',
    'https://user:pw@fcm.googleapis.com/a',
    'https://fcm.googleapis.com:8443/a',
  ]) {
    assert.equal(validWebPushEndpoint(bad), '', bad);
  }
});

test('the sender re-checks the endpoint and never posts outside the push services', async (t) => {
  const posted = [];
  const sender = createWebPushSender({
    keys: loadOrCreateVapidKeys(tempDir(t)),
    fetchImpl: async (url) => {
      posted.push(url);
      return new Response(null, { status: 201 });
    },
  });
  for (const endpoint of ['https://service.internal./x', 'https://localhost./x', 'https://fcm.googleapis.com./x']) {
    const result = await sender.send({ endpoint, body: Buffer.from('x') });
    assert.deepEqual(result, { ok: false, status: 0, error: 'endpoint-not-allowed' }, endpoint);
  }
  assert.deepEqual(posted, []);
  assert.equal((await sender.send({ endpoint: 'https://fcm.googleapis.com/x', body: Buffer.from('x') })).ok, true);
  assert.deepEqual(posted, ['https://fcm.googleapis.com/x']);
});

// ---- two PCs, one browser subscription -------------------------------------

const SECRET = '0123456789abcdef';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/subscription-1';
const sealed = (tag = 'a') => ({
  version: 1,
  ephemeralPublicKey: `B${tag.repeat(86)}`.slice(0, 87),
  nonce: 'n'.repeat(16),
  ciphertext: `${tag}`.repeat(40),
});

async function desktopLeg(relay, deviceId, { ready = true } = {}) {
  const messages = [];
  const waiters = [];
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
    headers: { Authorization: `Basic ${Buffer.from(`${deviceId}:${SECRET}`).toString('base64')}` },
  });
  socket.on('message', (raw) => {
    messages.push(JSON.parse(String(raw)));
    for (const waiter of [...waiters]) waiter();
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  /** The next message of `type` after the first `skip` of them. */
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
  const count = (type) => messages.filter((message) => message.type === type).length;
  const send = (payload) => socket.send(JSON.stringify(payload));
  const announce = async () => {
    // What a current desktop says once it learns the relay delivers for it.
    send({ type: 'webpush-ready' });
    const capable = () => {
      try {
        return JSON.parse(readFileSync(join(relay.dataDir, SUBSCRIPTIONS_FILE), 'utf8')).devices.includes(deviceId);
      } catch {
        return false;
      }
    };
    for (let attempt = 0; attempt < 100 && !capable(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(capable(), true);
  };
  if (ready) await announce();
  return { socket, next, count, send, announce };
}

function pushServiceMock() {
  const requests = [];
  let status = 201;
  return {
    requests,
    respond: (next) => {
      status = next;
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(null, { status });
    },
  };
}

async function twoPcRelay(t) {
  const dir = tempDir(t);
  const pushService = pushServiceMock();
  const relay = await startRelay({ port: 0, dataDir: join(dir, 'data'), webPushFetch: pushService.fetchImpl });
  relay.dataDir = join(dir, 'data');
  t.after(() => relay.close());
  const pcA = randomUUID();
  const pcB = randomUUID();
  relay.store.authenticate(pcA, SECRET);
  relay.store.authenticate(pcB, SECRET);
  // One browser, paired with both PCs: one credential per PC.
  const browserA = relay.store.registerClient(pcA, 'aaaaaaaa', {});
  const browserB = relay.store.registerClient(pcB, 'bbbbbbbb', {});
  const http = (path, token, body) =>
    fetch(`http://127.0.0.1:${relay.port}${path}`, {
      method: 'POST',
      headers: {
        Origin: `http://127.0.0.1:${relay.port}`,
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  return { relay, dir, pushService, pcA, pcB, tokenA: browserA.token, tokenB: browserB.token, http };
}

test('the web app reads the relay key, the same one after a restart', async (t) => {
  const { relay, dir } = await twoPcRelay(t);
  const response = await fetch(`http://127.0.0.1:${relay.port}/webpush/key`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { publicKey } = await response.json();
  assert.match(publicKey, /^[A-Za-z0-9_-]{87}$/u);
  await relay.close();
  const restarted = await startRelay({ port: 0, dataDir: join(dir, 'data') });
  t.after(() => restarted.close());
  const again = await (await fetch(`http://127.0.0.1:${restarted.port}/webpush/key`)).json();
  assert.equal(again.publicKey, publicKey);
});

test('each PC delivers through its own association; unauthorized senders are refused', async (t) => {
  const { relay, pushService, pcA, pcB, tokenA, tokenB, http } = await twoPcRelay(t);
  const legA = await desktopLeg(relay, pcA);
  const legB = await desktopLeg(relay, pcB);
  const capabilities = await legA.next('relay-capabilities');
  assert.equal(capabilities.webPush, 1);
  assert.deepEqual((await legA.next('webpush-subscriptions')).subscriptions, []);

  // No credential, a wrong credential, a cross-site page: nothing is bound.
  assert.equal((await http('/webpush/register', '', { endpoint: ENDPOINT, sealed: sealed() })).status, 401);
  assert.equal((await http('/webpush/register', 'f'.repeat(64), { endpoint: ENDPOINT, sealed: sealed() })).status, 401);
  const crossSite = await fetch(`http://127.0.0.1:${relay.port}/webpush/register`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ endpoint: ENDPOINT, sealed: sealed() }),
  });
  assert.equal(crossSite.status, 403);

  // The browser registers ONE subscription with BOTH PCs, each with its own credential.
  assert.equal((await http('/webpush/register', tokenA, { endpoint: ENDPOINT, sealed: sealed('a') })).status, 200);
  assert.equal((await http('/webpush/register', tokenB, { endpoint: ENDPOINT, sealed: sealed('b') })).status, 200);
  const setA = (await legA.next('webpush-subscriptions', 1)).subscriptions;
  const setB = (await legB.next('webpush-subscriptions', 1)).subscriptions;
  // Each PC sees only its own association, with the box sealed for it.
  assert.deepEqual(setA, [{ endpoint: ENDPOINT, clientId: 'aaaaaaaa', sealed: sealed('a') }]);
  assert.deepEqual(setB, [{ endpoint: ENDPOINT, clientId: 'bbbbbbbb', sealed: sealed('b') }]);
  assert.equal((await (await http('/webpush/status', tokenA, { endpoint: ENDPOINT })).json()).registered, true);

  // Both PCs deliver; the relay signs and forwards ciphertext verbatim.
  const payloadA = Buffer.from('ciphertext-from-a').toString('base64url');
  legA.send({ type: 'webpush-send', endpoint: ENDPOINT, clientId: 'aaaaaaaa', payload: payloadA });
  assert.equal((await legA.next('webpush-result')).ok, true);
  legB.send({ type: 'webpush-send', endpoint: ENDPOINT, clientId: 'bbbbbbbb', payload: payloadA });
  assert.equal((await legB.next('webpush-result')).ok, true);
  assert.equal(pushService.requests.length, 2);
  const [first] = pushService.requests;
  assert.equal(first.url, ENDPOINT);
  assert.equal(first.init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(Buffer.from(first.init.body).toString(), 'ciphertext-from-a');
  const key = verifyVapid(first.init.headers.Authorization, ENDPOINT);
  assert.equal(key, (await (await fetch(`http://127.0.0.1:${relay.port}/webpush/key`)).json()).publicKey);

  // A PC cannot borrow another PC's association.
  legA.send({ type: 'webpush-send', endpoint: ENDPOINT, clientId: 'bbbbbbbb', payload: payloadA });
  assert.equal((await legA.next('webpush-result', 1)).error, 'unbound-subscription');
  assert.equal(pushService.requests.length, 2);

  // Revoking the browser on PC A removes only A's association.
  legA.send({ type: 'revoke-client', requestId: 'r1', clientId: 'aaaaaaaa' });
  assert.equal((await legA.next('client-revoked')).ok, true);
  assert.deepEqual((await legA.next('webpush-subscriptions', 2)).subscriptions, []);
  legA.send({ type: 'webpush-send', endpoint: ENDPOINT, clientId: 'aaaaaaaa', payload: payloadA });
  assert.equal((await legA.next('webpush-result', 2)).error, 'unbound-subscription');
  // The revoked credential cannot re-bind either.
  assert.equal((await http('/webpush/register', tokenA, { endpoint: ENDPOINT, sealed: sealed('a') })).status, 401);
  legB.send({ type: 'webpush-send', endpoint: ENDPOINT, clientId: 'bbbbbbbb', payload: payloadA });
  assert.equal((await legB.next('webpush-result', 1)).ok, true);
  assert.equal(pushService.requests.length, 3);

  // Unregistering with PC B's credential removes B's association.
  assert.deepEqual(await (await http('/webpush/unregister', tokenB, { endpoint: ENDPOINT })).json(), { removed: true });
  assert.deepEqual((await legB.next('webpush-subscriptions', 2)).subscriptions, []);
  legA.socket.close();
  legB.socket.close();
});

test('associations are persisted, and a retired subscription (410) is dropped for every PC', async (t) => {
  const { relay, dir, pushService, pcA, pcB, tokenA, tokenB, http } = await twoPcRelay(t);
  const legA = await desktopLeg(relay, pcA);
  const legB = await desktopLeg(relay, pcB);
  await http('/webpush/register', tokenA, { endpoint: ENDPOINT, sealed: sealed('a') });
  await http('/webpush/register', tokenB, { endpoint: ENDPOINT, sealed: sealed('b') });
  await legA.next('webpush-subscriptions', 1);
  await legB.next('webpush-subscriptions', 1);

  // Persisted, owner-only beside devices.json: both associations are on disk.
  const saved = JSON.parse(readFileSync(join(dir, 'data', 'webpush-subscriptions.json'), 'utf8'));
  assert.equal(saved.subscriptions[0].associations.length, 2);

  pushService.respond(410);
  legA.send({
    type: 'webpush-send',
    endpoint: ENDPOINT,
    clientId: 'aaaaaaaa',
    payload: Buffer.from('x').toString('base64url'),
  });
  const result = await legA.next('webpush-result');
  assert.equal(result.ok, false);
  assert.equal(result.expired, true);
  assert.deepEqual((await legA.next('webpush-subscriptions', 2)).subscriptions, []);
  assert.deepEqual((await legB.next('webpush-subscriptions', 2)).subscriptions, []);
  legA.socket.close();
  legB.socket.close();
});

test('a browser registers only with PCs that deliver through the relay', async (t) => {
  const { relay, dir, pcA, pcB, tokenA, tokenB, http } = await twoPcRelay(t);
  const legA = await desktopLeg(relay, pcA);
  // PC B is an older desktop: it never says `webpush-ready`.
  const legB = await desktopLeg(relay, pcB, { ready: false });
  assert.deepEqual(await (await http('/webpush/status', tokenA, {})).json(), { registered: false, supported: true });
  assert.deepEqual(await (await http('/webpush/status', tokenB, {})).json(), { registered: false, supported: false });
  const refused = await http('/webpush/register', tokenB, { endpoint: ENDPOINT, sealed: sealed('b') });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'unsupported' });
  assert.equal((await http('/webpush/register', tokenA, { endpoint: ENDPOINT, sealed: sealed('a') })).status, 200);
  // Once B updates, it says so and the browser's next sync registers it.
  await legB.announce();
  assert.equal((await http('/webpush/register', tokenB, { endpoint: ENDPOINT, sealed: sealed('b') })).status, 200);
  // Remembered across a restart: a browser registers while its PCs are offline.
  const reloaded = createWebPushRegistry({ dataDir: join(dir, 'data') });
  assert.equal(reloaded.isCapable(pcA), true);
  assert.equal(reloaded.isCapable(pcB), true);
  legA.socket.close();
  legB.socket.close();
});

/** Every later write of the registry fails: its path becomes a directory. */
function blockRegistryWrites(dir) {
  const path = join(dir, 'data', SUBSCRIPTIONS_FILE);
  rmSync(path, { force: true });
  mkdirSync(path);
  return () => rmSync(path, { recursive: true, force: true });
}

test('an unregister that cannot be stored is refused and kept, never resurrected', async (t) => {
  const { relay, dir, pcA, tokenA, http } = await twoPcRelay(t);
  const legA = await desktopLeg(relay, pcA);
  assert.equal((await http('/webpush/register', tokenA, { endpoint: ENDPOINT, sealed: sealed('a') })).status, 200);
  await legA.next('webpush-subscriptions', 1);

  const unblock = blockRegistryWrites(dir);
  const failed = await http('/webpush/unregister', tokenA, { endpoint: ENDPOINT });
  assert.equal(failed.status, 503);
  assert.ok(failed.headers.get('retry-after'));
  // Memory still agrees with what a restart would read: nothing changed.
  assert.equal((await (await http('/webpush/status', tokenA, { endpoint: ENDPOINT })).json()).registered, true);
  assert.equal(legA.count('webpush-subscriptions'), 2);
  // A new box that cannot be stored is refused the same way.
  assert.equal((await http('/webpush/register', tokenA, { endpoint: ENDPOINT, sealed: sealed('z') })).status, 503);
  unblock();

  assert.deepEqual(await (await http('/webpush/unregister', tokenA, { endpoint: ENDPOINT })).json(), { removed: true });
  assert.equal(createWebPushRegistry({ dataDir: join(dir, 'data') }).has(pcA, 'aaaaaaaa', ENDPOINT), false);
  legA.socket.close();
});

test('re-stating an unchanged registration writes and announces nothing, and mutations are rate limited', async (t) => {
  const { relay, dir, pcA, pcB, tokenA, tokenB, http } = await twoPcRelay(t);
  const legA = await desktopLeg(relay, pcA);
  await desktopLeg(relay, pcB);
  assert.equal((await http('/webpush/register', tokenA, { endpoint: ENDPOINT, sealed: sealed('a') })).status, 200);
  await legA.next('webpush-subscriptions', 1);

  // Writes would fail now, so a re-register that wrote anything would 503.
  const unblock = blockRegistryWrites(dir);
  t.after(unblock);
  assert.equal((await http('/webpush/register', tokenA, { endpoint: ENDPOINT, sealed: sealed('a') })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(legA.count('webpush-subscriptions'), 2, 'no republish for an unchanged association');
  unblock();

  // 2 mutations so far on A's credential; the rest of the window, then 429.
  const statuses = [];
  for (let index = 0; index < 20; index += 1) {
    statuses.push((await http('/webpush/register', tokenA, { endpoint: ENDPOINT, sealed: sealed('a') })).status);
  }
  assert.deepEqual(statuses.slice(0, 18), Array(18).fill(200));
  assert.deepEqual(statuses.slice(18), [429, 429]);
  assert.equal((await http('/webpush/unregister', tokenA, { endpoint: ENDPOINT })).status, 429);
  // Another PC's credential, on the same browser, has its own budget.
  assert.equal((await http('/webpush/register', tokenB, { endpoint: ENDPOINT, sealed: sealed('b') })).status, 200);
  legA.socket.close();
});
