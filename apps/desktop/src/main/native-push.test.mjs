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
import { waitUntil } from './bounded-wait.mjs';
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
  envelope.ct = Buffer.from(envelope.ct, 'base64url')
    .map((byte, i) => (i === 0 ? byte ^ 1 : byte))
    .toString('base64url');
  assert.throws(() => decryptNativePush(a.privateKey, Buffer.from(JSON.stringify(envelope)).toString('base64url')));
});

test('public key validation', () => {
  assert.equal(isNativePushPublicKey(device().publicKey), true);
  assert.equal(isNativePushPublicKey('AAAA'), false);
  assert.equal(isNativePushPublicKey(Buffer.alloc(65, 4).toString('base64url')), false, 'off-curve point');
  assert.equal(isNativePushPublicKey(42), false);
});

const HOST_ID = '0123456789abcdef0123456789abcdef';

/** The notifier reports how each notification ended (sent or suppressed): waiting for that report is waiting for the delivery to finish. */
const diagnosed = (diagnostics, event) =>
  waitUntil(() => diagnostics.some(([name]) => name === event), `a '${event}' push diagnostic`);
const approval = (id) => ({ sessionId: 's1', frameSource: 'live', snapshot: { toolApproval: id ? { id } : null } });
