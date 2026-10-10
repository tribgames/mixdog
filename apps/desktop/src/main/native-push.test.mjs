import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  NATIVE_PUSH_TEST_VECTOR as vector,
  decryptNativePush,
  encryptNativePush,
  isNativePushPublicKey,
} from '../shared/native-push-crypto.ts';
import { createNativePushStore } from './native-push-store.ts';
import { createPushNotifier, nativeCollapseKey } from './push-notifier.ts';
import { createRelayClientLifecycle } from './remote-relay-client-lifecycle.ts';
import { createRemoteMethods } from './remote-methods.ts';

const device = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey().toString('base64url') };
};
const APNS_TOKEN = 'cd'.repeat(32);

test('shared vector: encryption is deterministic for fixed inputs and decrypts', () => {
  const mx = encryptNativePush(vector.devicePublicKey, vector.content, {
    ephemeralPrivateKey: Buffer.from(vector.ephemeralPrivateKey, 'base64url'),
    iv: Buffer.from(vector.iv, 'base64url'),
  });
  assert.equal(mx, vector.mx);
  assert.deepEqual(decryptNativePush(Buffer.from(vector.devicePrivateKey, 'base64url'), vector.mx), vector.content);
  const envelope = JSON.parse(Buffer.from(vector.mx, 'base64url').toString());
  assert.deepEqual(Object.keys(envelope), ['v', 'epk', 'iv', 'ct']);
  assert.equal(envelope.v, 1);
  assert.equal(Buffer.from(envelope.epk, 'base64url').length, 65);
  assert.equal(Buffer.from(envelope.iv, 'base64url').length, 12);
});

test('round trip with random keys; wrong key and tampering fail', () => {
  const a = device();
  const content = { title: 'T', body: 'B', sessionId: 's1', reason: 'turn-finished' };
  const mx = encryptNativePush(a.publicKey, content);
  assert.notEqual(mx, encryptNativePush(a.publicKey, content));
  assert.deepEqual(decryptNativePush(a.privateKey, mx), content);
  assert.throws(() => decryptNativePush(device().privateKey, mx));
  const envelope = JSON.parse(Buffer.from(mx, 'base64url').toString());
  envelope.ct = Buffer.from(envelope.ct, 'base64url').map((byte, i) => (i === 0 ? byte ^ 1 : byte)).toString('base64url');
  assert.throws(() => decryptNativePush(a.privateKey, Buffer.from(JSON.stringify(envelope)).toString('base64url')));
});

test('public key validation', () => {
  assert.equal(isNativePushPublicKey(device().publicKey), true);
  assert.equal(isNativePushPublicKey('AAAA'), false);
  assert.equal(isNativePushPublicKey(Buffer.alloc(65, 4).toString('base64url')), false, 'off-curve point');
  assert.equal(isNativePushPublicKey(42), false);
});

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'native-push-'));
  try {
    await run(createNativePushStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('registration validation and per-client binding in the store', async () => {
  await withStore(async (store, dir) => {
    const { publicKey } = device();
    const ok = { clientId: 'c1', platform: 'apns', token: APNS_TOKEN, publicKey };
    await assert.rejects(store.register({ ...ok, platform: 'web' }), /platform/);
    await assert.rejects(store.register({ ...ok, token: 'short' }), /token/);
    await assert.rejects(store.register({ ...ok, publicKey: 'AAAA' }), /publicKey/);
    await assert.rejects(store.register({ ...ok, clientId: '' }), /paired client/);
    await assert.rejects(store.register({ ...ok, sandbox: 'yes' }), /sandbox/);
    await store.register({ ...ok, sandbox: true });
    await store.register({ clientId: 'c2', platform: 'fcm', token: 'f'.repeat(40), publicKey });
    // Re-registering replaces the client's row.
    await store.register({ ...ok, token: 'ef'.repeat(32) });
    const rows = await store.list();
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.clientId === 'c1').sandbox, false);
    // Persisted and reloadable.
    assert.equal((await createNativePushStore(dir).list()).length, 2);
    assert.equal(await store.removeByClient('c1'), true);
    assert.equal(await store.removeToken('f'.repeat(40)), true);
    assert.deepEqual(await store.list(), []);
  });
});

test('registerNativePush binds to the connection credential, never to a request field', async () => {
  const registered = [];
  const nativePush = {
    platforms: () => ['apns'],
    register: async (input) => registered.push(input),
    remove: async (clientId, token) => (registered.push(['remove', clientId, token]), true),
  };
  const { publicKey } = device();
  const input = { platform: 'apns', token: APNS_TOKEN, publicKey, clientId: 'spoofed' };
  const methods = createRemoteMethods({ host: {}, nativePush }, { credentialId: () => 'real-client' });
  assert.equal(await methods.registerNativePush([input]), true);
  assert.equal(registered[0].clientId, 'real-client');
  await methods.removeNativePush([APNS_TOKEN]);
  assert.deepEqual(registered[1], ['remove', 'real-client', APNS_TOKEN]);
  // fcm is not deliverable on this relay; an unnamed connection cannot register.
  await assert.rejects(async () => methods.registerNativePush([{ ...input, platform: 'fcm' }]), /unavailable/);
  const anonymous = createRemoteMethods({ host: {}, nativePush }, { credentialId: () => '' });
  await assert.rejects(async () => anonymous.registerNativePush([input]), /paired client/);
  // A host whose relay cannot deliver (or has no native push) refuses.
  const unable = createRemoteMethods({ host: {}, nativePush: { ...nativePush, platforms: () => [] } }, {});
  await assert.rejects(async () => unable.registerNativePush([input]), /unavailable/);
  await assert.rejects(async () => createRemoteMethods({ host: {} }, {}).registerNativePush([input]), /unavailable/);
});

test('nativePush is advertised in the handshake only when the relay can deliver', () => {
  const challengeFor = (supported) => {
    const sent = [];
    const lifecycle = createRelayClientLifecycle({
      clients: { open: () => true },
      e2eeIdentity: {},
      pairing: {},
      relayBinaryFrames: () => false,
      viewSyncSupported: () => false,
      ...(supported === undefined ? {} : { nativePushSupported: () => supported }),
      relayRoutingCapsPayload: () => ({}),
      sendEnvelope: (payload) => sent.push(payload),
      sendEncryptedFrame: async () => {},
      dispatchClientCall: async () => ({}),
      resyncClient: () => {},
    });
    lifecycle.open('route', 'cred');
    return JSON.parse(sent[0].data);
  };
  assert.equal(challengeFor(true).nativePush, 1);
  assert.equal(challengeFor(true).remoteParity, 1);
  assert.equal('nativePush' in challengeFor(false), false);
  assert.equal('nativePush' in challengeFor(undefined), false);
});

function notifierFixture({ foreground = false, enabled = true, accept = true } = {}) {
  const phone = device();
  const sent = [];
  const web = { keys: async () => ({}), list: async () => [], remove: async () => true, removeByClient: async () => true };
  const removed = [];
  const notifier = createPushNotifier({
    store: web,
    isEnabled: () => enabled,
    readFinalAnswer: async () => null,
    isClientForeground: () => false,
    native: {
      list: async () => [{ clientId: 'c1', platform: 'apns', token: APNS_TOKEN, publicKey: phone.publicKey, sandbox: true }],
      isClientForeground: () => foreground,
      send: (message) => (sent.push(message), accept),
      removeByClient: async (id) => (removed.push(id), true),
    },
  });
  return { notifier, sent, phone, removed };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const approval = (id) => ({ sessionId: 's1', frameSource: 'live', snapshot: { toolApproval: id ? { id } : null } });

test('native approval push: encrypted content only, same gates as web push', async (t) => {
  const f = notifierFixture();
  t.after(() => f.notifier.dispose());
  f.notifier.onSessions([{ id: 's1', title: 'Fix the build', preview: '' }]);
  f.notifier.onSessionState(approval('a1'));
  f.notifier.onSessionState(approval('a1'));
  await settle();
  assert.equal(f.sent.length, 1);
  const message = f.sent[0];
  assert.deepEqual(Object.keys(message).sort(), ['collapseKey', 'mx', 'platform', 'reason', 'sandbox', 'token']);
  assert.equal(message.reason, 'approval-pending');
  assert.equal(message.sandbox, true);
  assert.equal(message.collapseKey, nativeCollapseKey('s1', 'approval-pending'));
  assert.ok(message.collapseKey.length <= 64);
  assert.equal(JSON.stringify(message).includes('Fix the build'), false, 'no plaintext title on the wire');
  assert.deepEqual(decryptNativePush(f.phone.privateKey, message.mx), {
    title: 'Fix the build',
    body: '',
    sessionId: 's1',
    reason: 'approval-pending',
    approvalId: 'a1',
  });
});

test('native push is suppressed for a foreground client or when disabled', async (t) => {
  for (const options of [{ foreground: true }, { enabled: false }]) {
    const f = notifierFixture(options);
    t.after(() => f.notifier.dispose());
    f.notifier.onSessionState(approval('a2'));
    await settle();
    assert.equal(f.sent.length, 0);
  }
});

test('forgetting a client also drops its native registration', async (t) => {
  const f = notifierFixture();
  t.after(() => f.notifier.dispose());
  f.notifier.forgetClient('c1');
  await settle();
  assert.deepEqual(f.removed, ['c1']);
});

test('a notifier without native support (old relay) still works', async (t) => {
  const sent = [];
  const notifier = createPushNotifier({
    store: { keys: async () => ({}), list: async () => [], remove: async () => true, removeByClient: async () => true },
    isEnabled: () => true,
    readFinalAnswer: async () => null,
    isClientForeground: () => false,
  });
  t.after(() => notifier.dispose());
  notifier.onSessionState(approval('a3'));
  await settle();
  assert.equal(sent.length, 0);
});
