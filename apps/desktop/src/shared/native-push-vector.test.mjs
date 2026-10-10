import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NATIVE_PUSH_TEST_VECTOR as vector, decryptNativePush } from './native-push-crypto.ts';

// The phone decrypts `mx` natively (Swift CryptoKit / Java JCA); this pins the
// shared contract and the published native cross-check vector to the reference.
test('the shared vector decrypts with the device key', () => {
  const content = decryptNativePush(Buffer.from(vector.devicePrivateKey, 'base64url'), vector.mx);
  assert.deepEqual(content, vector.content);
});

test('the mobile cross-check vector mirrors the shared vector', () => {
  const published = JSON.parse(
    readFileSync(new URL('../../../mobile/test-vectors/native-push-v1.json', import.meta.url), 'utf8')
  );
  assert.equal(published.mx, vector.mx);
  assert.equal(published.devicePublicKey, vector.devicePublicKey);
  assert.deepEqual(published.plaintext, vector.content);
  assert.deepEqual(
    decryptNativePush(Buffer.from(published.devicePrivateKey, 'base64url'), published.mx),
    published.plaintext
  );
});
