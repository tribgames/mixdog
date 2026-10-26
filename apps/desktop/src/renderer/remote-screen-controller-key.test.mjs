import assert from 'node:assert/strict';
import test from 'node:test';

import { isSecureDesktopControllerKey, secureDesktopGrantPayload, signSecureDesktopGrant } from '../shared/secure-desktop-grant.ts';
import {
  clearControllerKey,
  controllerKeyScopeFor,
  createControllerKeys,
  ensureControllerKey,
  loadControllerKey,
} from './remote-screen-controller-key.ts';
import { remotePairingKeys } from './remote-pairing-recovery.ts';
import { fakeIndexedDB } from './test-support/fake-indexeddb.mjs';

const SCOPE = remotePairingKeys('https://relay.example', 'abcdef01-2345').token;
const nonce = (byte) => Buffer.alloc(16, byte).toString('base64');

/** Whether `signature` (base64) over the grant payload verifies under `publicKey`. */
async function verifies(publicKey, signature, challenge, epoch) {
  const raw = Buffer.from(publicKey, 'base64url');
  const key = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(signature, 'base64'),
    secureDesktopGrantPayload(challenge.nonce, challenge.challenge, epoch)
  );
}

test('the key is made once per pairing, stored, and reused by every later session', async () => {
  const factory = fakeIndexedDB();
  assert.equal(await loadControllerKey(SCOPE, factory), null, 'loading never creates one');
  assert.equal(factory.databases.get('mixdog-remote-screen-controller')?.get('keys').size, 0);

  const first = await ensureControllerKey(SCOPE, factory);
  assert.ok(isSecureDesktopControllerKey(first.publicKey));
  assert.equal(first.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', first.privateKey), 'its bytes can never be read back');

  // A later session (a new page, a new store object) gets the same key back out of IndexedDB.
  const later = await loadControllerKey(SCOPE, factory);
  assert.equal(later.publicKey, first.publicKey);
  assert.equal((await ensureControllerKey(SCOPE, factory)).publicKey, first.publicKey);
  const challenge = { nonce: nonce(1), challenge: nonce(2) };
  const signature = await signSecureDesktopGrant(later.privateKey, challenge, 7);
  assert.equal(await verifies(first.publicKey, signature, challenge, 7), true, 'the stored private key still signs');
});

test('each pairing has its own key, and clearing one leaves the others', async () => {
  const factory = fakeIndexedDB();
  const other = remotePairingKeys('https://relay.example', 'ffffffff-0000').token;
  const a = await ensureControllerKey(SCOPE, factory);
  const b = await ensureControllerKey(other, factory);
  assert.notEqual(a.publicKey, b.publicKey);

  await clearControllerKey(SCOPE, factory);
  assert.equal(await loadControllerKey(SCOPE, factory), null);
  assert.equal((await loadControllerKey(other, factory)).publicKey, b.publicKey);
  // Pairing again mints a new key; the old enrollment cannot be answered with it.
  assert.notEqual((await ensureControllerKey(SCOPE, factory)).publicKey, a.publicKey);
});

test('two pages racing to create the key end up sharing the first one stored', async () => {
  const factory = fakeIndexedDB();
  const [a, b] = await Promise.all([ensureControllerKey(SCOPE, factory), ensureControllerKey(SCOPE, factory)]);
  assert.equal(a.publicKey, b.publicKey);
  assert.equal((await loadControllerKey(SCOPE, factory)).publicKey, a.publicKey);
});

test('a stored value that is not a usable key counts as absent', async () => {
  const factory = fakeIndexedDB();
  await ensureControllerKey('other', factory);
  const store = factory.databases.get('mixdog-remote-screen-controller').get('keys');
  const exportable = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = Buffer.from(await crypto.subtle.exportKey('raw', exportable.publicKey)).toString('base64url');
  for (const bad of [
    'garbage',
    { publicKey: 'short', privateKey: exportable.privateKey },
    { publicKey: raw, privateKey: exportable.privateKey },
    { publicKey: raw },
  ]) {
    store.set(SCOPE, bad);
    assert.equal(await loadControllerKey(SCOPE, factory), null);
  }
  const replaced = await ensureControllerKey(SCOPE, factory);
  assert.equal(replaced.privateKey.extractable, false, 'a key that could be read out is replaced, not trusted');
});

test('the store keeps the key for the page and clears it with the pairing', async () => {
  const factory = fakeIndexedDB();
  let scope = SCOPE;
  const keys = createControllerKeys(() => scope, factory);
  assert.equal(await keys.load(), null);
  const [a, b] = await Promise.all([keys.ensure(), keys.ensure()]);
  assert.equal(a, b, 'one creation in flight is shared');
  const opens = factory.stats.opens;
  assert.equal(await keys.load(), a);
  assert.equal(await keys.ensure(), a);
  assert.equal(factory.stats.opens, opens, 'a kept key costs no database read');

  // Another pairing (a PC switch) is not served the kept key.
  scope = remotePairingKeys('https://relay.example', 'ffffffff-0000').token;
  assert.equal(await keys.load(), null);
  scope = SCOPE;
  await keys.clear();
  assert.equal(await keys.load(), null);
  assert.equal(await loadControllerKey(SCOPE, factory), null);
});

test('a pairing keeps only its key: no automatic-request mark is stored beside it', async () => {
  const factory = fakeIndexedDB();
  const keys = createControllerKeys(() => SCOPE, factory);
  await keys.ensure();
  const store = factory.databases.get('mixdog-remote-screen-controller').get('keys');
  assert.deepEqual([...store.keys()], [SCOPE]);
  await keys.clear();
  assert.equal(store.size, 0);
});

test('the pairing scope is the key the shim stores the credential under', () => {
  const device = 'abcdef01-2345';
  const expected = remotePairingKeys('https://relay.example', device).token;
  const page = { origin: 'https://relay.example', pathname: `/d/${device}/`, cookie: '', deviceLabel: '' };
  assert.equal(controllerKeyScopeFor(page), expected, 'from the route');
  assert.equal(controllerKeyScopeFor({ ...page, pathname: '/', cookie: `mixdog_device=${device}` }), expected, 'from the cookie');
  assert.equal(controllerKeyScopeFor({ ...page, pathname: '/', deviceLabel: device }), expected, 'from the stored label');
  assert.equal(controllerKeyScopeFor({ ...page, pathname: '/d/11111111-2222/', deviceLabel: device }), remotePairingKeys('https://relay.example', '11111111-2222').token, 'the route wins');
  assert.equal(controllerKeyScopeFor({ ...page, pathname: '/' }), remotePairingKeys('https://relay.example', '').token, 'unrouted');
});
