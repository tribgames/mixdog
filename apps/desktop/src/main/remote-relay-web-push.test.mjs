import assert from 'node:assert/strict';
import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import { startRelay } from '../../../relay/server.mjs';
import {
  generateRelayE2EEServerIdentity,
  openRelayWebPushKeys,
  relayE2EEPairingMaterial,
  sealRelayWebPushKeys,
} from '../shared/remote-e2ee.ts';
import { createPushNotifier } from './push-notifier.ts';
import { createRelayConnectionCaps } from './remote-relay-capabilities.ts';
import { createRelayEnvelopeDispatcher } from './remote-relay-envelope.ts';
import { createRelayWebPush } from './remote-relay-web-push.ts';
import { generateWebPushKeys } from './web-push.ts';

const SECRET = '0123456789abcdef';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/browser-1';

/** Stands in for the browser: the keys a real PushSubscription reports, and
 *  the only party able to read what a PC sent. */
function createSubscriber() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.of(0x04), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const auth = randomBytes(16);
  return { privateKey, raw, authSecret: auth, keys: { p256dh: raw.toString('base64url'), auth: auth.toString('base64url') } };
}

/** RFC 8291 receiving half, independent of the sender. */
function decryptAsBrowser(subscriber, body) {
  const salt = body.subarray(0, 16);
  const keyLength = body.readUInt8(20);
  const senderPublicRaw = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);
  const senderPublic = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: senderPublicRaw.subarray(1, 33).toString('base64url'),
      y: senderPublicRaw.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  const shared = diffieHellman({ privateKey: subscriber.privateKey, publicKey: senderPublic });
  const hkdf = (hkdfSalt, ikm, info, length) => Buffer.from(new Uint8Array(hkdfSync('sha256', ikm, hkdfSalt, info, length)));
  const ikm = hkdf(subscriber.authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), subscriber.raw, senderPublicRaw]), 32);
  const key = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  return padded.subarray(0, padded.length - 1).toString('utf8');
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await settle(20);
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('the subscription keys open only for the desktop and endpoint they were sealed for', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const other = await generateRelayE2EEServerIdentity();
  const { keys } = createSubscriber();
  const sealed = await sealRelayWebPushKeys(relayE2EEPairingMaterial(identity), ENDPOINT, keys);
  assert.deepEqual(await openRelayWebPushKeys(identity, ENDPOINT, sealed), keys);
  assert.equal(await openRelayWebPushKeys(other, ENDPOINT, sealed), null);
  assert.equal(await openRelayWebPushKeys(identity, `${ENDPOINT}-other`, sealed), null);
  // Someone without the pairing secret (the relay) cannot make a box this PC accepts.
  const forged = await sealRelayWebPushKeys({ ...relayE2EEPairingMaterial(identity), pairingSecret: 'A'.repeat(43) }, ENDPOINT, keys);
  assert.equal(await openRelayWebPushKeys(identity, ENDPOINT, forged), null);
});

test('a PC encrypts for the browser and the relay forwards it with its own VAPID key', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-desktop-webpush-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pushed = [];
  const relay = await startRelay({
    port: 0,
    dataDir: join(dir, 'data'),
    webPushFetch: async (url, init) => {
      pushed.push({ url, init });
      return new Response(null, { status: 201 });
    },
  });
  t.after(() => relay.close());
  const deviceId = randomUUID();
  relay.store.authenticate(deviceId, SECRET);
  const browser = relay.store.registerClient(deviceId, 'cccccccc', {});
  const identity = await generateRelayE2EEServerIdentity();
  const subscriber = createSubscriber();

  const relayKey = (await (await fetch(`http://127.0.0.1:${relay.port}/webpush/key`)).json()).publicKey;
  const browserPost = (path, body) =>
    fetch(`http://127.0.0.1:${relay.port}${path}`, {
      method: 'POST',
      headers: {
        Origin: `http://127.0.0.1:${relay.port}`,
        Authorization: `Bearer ${browser.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  // Before this PC has ever said it delivers through the relay, a browser is
  // told to keep it on its legacy registration.
  assert.deepEqual(await (await browserPost('/webpush/status', {})).json(), { registered: false, supported: false });

  // The desktop half, wired as remote-relay.ts wires it.
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop`, {
    headers: { Authorization: `Basic ${Buffer.from(`${deviceId}:${SECRET}`).toString('base64')}` },
  });
  t.after(() => socket.close());
  const results = [];
  const caps = createRelayConnectionCaps({ clientCount: () => 0, broadcastEncrypted: () => {}, rebindNativePush: () => {} });
  const webPush = createRelayWebPush({
    identity,
    available: caps.relayWebPush,
    sendEnvelope: (payload) => {
      socket.send(JSON.stringify(payload));
      return true;
    },
    onDiagnostic: (event, details) => results.push({ event, ...details }),
  });
  let listed = 0;
  const dispatch = createRelayEnvelopeDispatcher({
    control: { settle: () => false },
    onCapabilities: caps.handleRelayCapabilities,
    onClientClaim() {},
    onClientOpen() {},
    onClientClose() {},
    onMedia() {},
    onWebPushSubscriptions: (envelope) => {
      listed += 1;
      webPush.update(envelope);
    },
    onWebPushResult: webPush.onResult,
  });
  socket.on('message', (raw) => dispatch(JSON.parse(String(raw))));
  await waitFor(() => listed > 0, 'the subscription set');
  assert.equal(caps.relayWebPush(), true);
  // The first set made this PC announce itself; now the browser registers
  // with this PC's own credential.
  let supported = false;
  for (let attempt = 0; attempt < 100 && !supported; attempt += 1) {
    supported = (await (await browserPost('/webpush/status', {})).json()).supported;
    if (!supported) await settle(10);
  }
  assert.equal(supported, true);
  const register = await browserPost('/webpush/register', {
    endpoint: ENDPOINT,
    sealed: await sealRelayWebPushKeys(relayE2EEPairingMaterial(identity), ENDPOINT, subscriber.keys),
  });
  assert.equal(register.status, 200);
  await waitFor(() => listed > 1, 'the updated subscription set');
  assert.deepEqual(await webPush.list(), [{ endpoint: ENDPOINT, clientId: 'cccccccc', ...subscriber.keys }]);

  const legacySends = [];
  const notifier = createPushNotifier({
    store: {
      keys: async () => generateWebPushKeys(),
      // The same browser's legacy subscription, from before it migrated.
      list: async () => [
        { endpoint: 'https://legacy.example.com/x', ...subscriber.keys, clientId: 'cccccccc', label: '', createdAt: 0 },
      ],
      remove: async () => true,
      removeByClient: async () => true,
    },
    hostId: deviceId,
    isEnabled: () => true,
    readFinalAnswer: async () => null,
    isClientForeground: () => false,
    relayWebPush: {
      available: () => webPush.available(),
      list: () => webPush.list(),
      isClientForeground: () => false,
      send: (target, body) => webPush.send(target, body),
    },
    fetchImpl: async (url) => {
      legacySends.push(url);
      return new Response(null, { status: 201 });
    },
  });
  t.after(() => notifier.dispose());
  notifier.onSessionState({ sessionId: 'session-7', frameSource: 'live', snapshot: { toolApproval: { id: 'a1' } } });
  await waitFor(() => results.some((row) => row.event === 'delivered'), 'the relay verdict');

  // The relay never posted to the push service from the desktop's own key, and
  // the legacy direct path stayed silent.
  assert.deepEqual(legacySends, []);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].url, ENDPOINT);
  assert.match(pushed[0].init.headers.Authorization, new RegExp(`, k=${relayKey}$`, 'u'));
  // Only the browser can read it, and it names the PC that sent it.
  const payload = JSON.parse(decryptAsBrowser(subscriber, Buffer.from(pushed[0].init.body)));
  assert.equal(payload.hostId, deviceId);
  assert.equal(payload.sessionId, 'session-7');
  assert.equal(payload.data.hostId, deviceId);
  assert.equal(payload.data.reason, 'approval-pending');
});

test('without the relay capability the PC keeps its legacy direct send', async (t) => {
  const subscriber = createSubscriber();
  const legacy = [];
  const relayed = [];
  const notifier = createPushNotifier({
    store: {
      keys: async () => generateWebPushKeys(),
      list: async () => [{ endpoint: 'https://legacy.example.com/x', ...subscriber.keys, clientId: 'b', label: '', createdAt: 0 }],
      remove: async () => true,
      removeByClient: async () => true,
    },
    hostId: 'host-a',
    isEnabled: () => true,
    readFinalAnswer: async () => null,
    isClientForeground: () => false,
    relayWebPush: {
      available: () => false,
      list: async () => [],
      isClientForeground: () => false,
      send: (target) => {
        relayed.push(target);
        return true;
      },
    },
    fetchImpl: async (url, init) => {
      legacy.push({ url, init });
      return new Response(null, { status: 201 });
    },
  });
  t.after(() => notifier.dispose());
  notifier.onSessionState({ sessionId: 's1', frameSource: 'live', snapshot: { toolApproval: { id: 'a1' } } });
  await settle(80);
  assert.equal(relayed.length, 0);
  assert.equal(legacy.length, 1);
  assert.equal(JSON.parse(decryptAsBrowser(subscriber, Buffer.from(legacy[0].init.body))).data.hostId, 'host-a');
});

test('on a capable relay each browser keeps the legacy send until it holds a relay association', async (t) => {
  const migrated = createSubscriber();
  const waiting = createSubscriber();
  const legacy = [];
  const relayed = [];
  const notifier = createPushNotifier({
    store: {
      keys: async () => generateWebPushKeys(),
      list: async () => [
        // Browser M already moved to the relay key; its old subscription is retired.
        { endpoint: 'https://legacy.example.com/m', ...migrated.keys, clientId: 'mmmmmmmm', label: '', createdAt: 0 },
        // Browser W has not relaunched since the update: this is its only subscription.
        { endpoint: 'https://legacy.example.com/w', ...waiting.keys, clientId: 'wwwwwwww', label: '', createdAt: 0 },
      ],
      remove: async () => true,
      removeByClient: async () => true,
    },
    hostId: 'host-a',
    isEnabled: () => true,
    readFinalAnswer: async () => null,
    isClientForeground: () => false,
    relayWebPush: {
      available: () => true,
      list: async () => [{ endpoint: ENDPOINT, clientId: 'mmmmmmmm', ...migrated.keys }],
      isClientForeground: () => false,
      send: (target) => {
        relayed.push(target.clientId);
        return true;
      },
    },
    fetchImpl: async (url, init) => {
      legacy.push({ url, init });
      return new Response(null, { status: 201 });
    },
  });
  t.after(() => notifier.dispose());
  notifier.onSessionState({ sessionId: 's1', frameSource: 'live', snapshot: { toolApproval: { id: 'a1' } } });
  await settle(80);
  assert.deepEqual(relayed, ['mmmmmmmm']);
  assert.deepEqual(
    legacy.map((row) => row.url),
    ['https://legacy.example.com/w']
  );
  assert.equal(JSON.parse(decryptAsBrowser(waiting, Buffer.from(legacy[0].init.body))).sessionId, 's1');
});

test('the PC announces once per relay connection that it delivers through the relay', () => {
  const sent = [];
  let available = true;
  const webPush = createRelayWebPush({
    identity: null,
    available: () => available,
    sendEnvelope: (payload) => {
      sent.push(payload);
      return true;
    },
  });
  webPush.update({ subscriptions: [] });
  webPush.update({ subscriptions: [] });
  assert.deepEqual(sent, [{ type: 'webpush-ready', version: 1 }]);
  webPush.reset();
  webPush.update({ subscriptions: [] });
  assert.equal(sent.length, 2);
  // A relay that never advertised the capability is never told.
  available = false;
  webPush.reset();
  webPush.update({ subscriptions: [] });
  assert.equal(sent.length, 2);
});
