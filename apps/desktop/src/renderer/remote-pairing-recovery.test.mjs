import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REMOTE_PAIRING_STORAGE_KEYS,
  clearStoredRemotePairing,
  isInvalidRemotePairingClose,
} from './remote-pairing-recovery';

test('recognizes only close reasons that invalidate a stored remote pairing', () => {
  assert.equal(isInvalidRemotePairingClose({
    code: 4004,
    reason: 'relay encryption handshake required',
  }), true);
  assert.equal(isInvalidRemotePairingClose({
    code: 4004,
    reason: 'relay encryption authentication failed',
  }), true);
  assert.equal(isInvalidRemotePairingClose({ code: 4003, reason: 'pairing revoked' }), true);
  assert.equal(isInvalidRemotePairingClose({ code: 4002, reason: 'desktop offline' }), false);
  assert.equal(isInvalidRemotePairingClose({ code: 1006, reason: '' }), false);
});

test('clears every persisted remote pairing credential', () => {
  const values = new Map(
    Object.values(REMOTE_PAIRING_STORAGE_KEYS).map((key) => [key, 'stale']),
  );
  clearStoredRemotePairing({ removeItem: (key) => values.delete(key) });
  assert.deepEqual([...values], []);
});
