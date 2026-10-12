import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REMOTE_PAIRING_STORAGE_KEYS,
  migrateLegacyRemotePairing,
  remotePairingKeys,
} from './remote-pairing-recovery.ts';

const ORIGIN = 'https://relay.example';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const TOKEN_A = 'a'.repeat(64);
const SECRET = 'c'.repeat(43);

const memoryStorage = (seed = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
};

const legacySeed = (device) => ({
  [REMOTE_PAIRING_STORAGE_KEYS.token]: TOKEN_A,
  [REMOTE_PAIRING_STORAGE_KEYS.paired]: '1',
  [REMOTE_PAIRING_STORAGE_KEYS.browserId]: 'browser-a',
  [REMOTE_PAIRING_STORAGE_KEYS.e2eePublicKey]: 'pub',
  [REMOTE_PAIRING_STORAGE_KEYS.e2eeSecret]: SECRET,
  [REMOTE_PAIRING_STORAGE_KEYS.server]: ORIGIN,
  ...(device ? { [REMOTE_PAIRING_STORAGE_KEYS.device]: device } : {}),
});

const loadContext = async ({ pathname, storage }) => {
  const saved = ['location', 'document', 'localStorage'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]);
  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('location', { origin: ORIGIN, pathname });
  define('document', { cookie: '', visibilityState: 'visible' });
  define('localStorage', storage);
  try {
    const { createRemoteShimContext } = await import('./remote-shim-state.ts');
    return createRemoteShimContext();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
};

test('pairing keys differ per device and per relay origin', () => {
  const a = remotePairingKeys(ORIGIN, A);
  const b = remotePairingKeys(ORIGIN, B);
  const other = remotePairingKeys('https://other.example', A);
  for (const name of ['token', 'e2eePublicKey', 'e2eeSecret', 'claim', 'paired', 'browserId', 'server']) {
    assert.notEqual(a[name], b[name]);
    assert.notEqual(a[name], other[name]);
    assert.notEqual(a[name], REMOTE_PAIRING_STORAGE_KEYS[name]);
  }
  assert.equal(a.device, REMOTE_PAIRING_STORAGE_KEYS.device);
});

test('legacy credentials migrate only to the device they were stored for', () => {
  const storage = memoryStorage(legacySeed(A));
  migrateLegacyRemotePairing(storage, ORIGIN);
  const a = remotePairingKeys(ORIGIN, A);
  assert.equal(storage.getItem(a.token), TOKEN_A);
  assert.equal(storage.getItem(a.e2eeSecret), SECRET);
  assert.equal(storage.getItem(a.paired), '1');
  assert.equal(storage.getItem(REMOTE_PAIRING_STORAGE_KEYS.token), null);
  assert.equal(storage.getItem(remotePairingKeys(ORIGIN, B).token), null);
  assert.equal(storage.getItem(REMOTE_PAIRING_STORAGE_KEYS.device), A);
});

test('legacy credentials with no device label are not handed to any device', () => {
  const storage = memoryStorage(legacySeed(''));
  migrateLegacyRemotePairing(storage, ORIGIN);
  assert.equal(storage.getItem(remotePairingKeys(ORIGIN, A).token), null);
  assert.equal(storage.getItem(REMOTE_PAIRING_STORAGE_KEYS.token), TOKEN_A);
});

test('an existing single-PC user keeps working after migration', async () => {
  const storage = memoryStorage(legacySeed(A));
  const ctx = await loadContext({ pathname: `/d/${A}/`, storage });
  assert.equal(ctx.deviceId, A);
  assert.equal(ctx.token, TOKEN_A);
  assert.equal(ctx.e2eePairing?.pairingSecret, SECRET);
  assert.equal(ctx.everPaired, true);
  assert.equal(ctx.clientRegistered, true);
  assert.equal(ctx.browserId, 'browser-a');
});

test("opening PC B after pairing A uses none of A's credentials and starts B's own claim", async () => {
  const storage = memoryStorage(legacySeed(A));
  const first = await loadContext({ pathname: `/d/${A}/`, storage });
  assert.equal(first.token, TOKEN_A);

  const ctx = await loadContext({ pathname: `/d/${B}/`, storage });
  assert.equal(ctx.deviceId, B);
  assert.equal(ctx.token, '');
  assert.equal(ctx.e2eePairing, null);
  assert.equal(ctx.everPaired, false);
  assert.equal(ctx.clientRegistered, false);
  assert.notEqual(ctx.browserId, 'browser-a');
  assert.equal(ctx.pairingKeys.claim, remotePairingKeys(ORIGIN, B).claim);
  assert.notEqual(ctx.pairingKeys.claim, first.pairingKeys.claim);

  // A is untouched and returns to its own pairing.
  const back = await loadContext({ pathname: `/d/${A}/`, storage });
  assert.equal(back.token, TOKEN_A);
  assert.equal(back.everPaired, true);
});
