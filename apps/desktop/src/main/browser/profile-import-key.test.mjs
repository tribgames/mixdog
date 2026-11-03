// The saved Chrome App-Bound key: encrypted at rest, bound to the exact
// app_bound_encrypted_key it was unwrapped from, and never stored without OS
// encryption. Fixture Local State files and fake keys only.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  APP_BOUND_KEY_FILE,
  AppBoundKeyStore,
  appBoundBlobSha256,
  base64Bytes,
  readAppBoundBlobSha256,
} from './profile-import-key.ts';

const BLOB_A = 'QVBQQgEAAADQjJ3fARXREYx6AMBPwpfr';
const BLOB_B = 'QVBQQgEAAAAAAAAAAAAAAAAAAAAAAAAA';
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Reversible and unreadable at a glance, standing in for the OS user-scope encryption. */
function fakeEncryption(available = true) {
  const scramble = (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x5a).reverse());
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => scramble(Buffer.from(text, 'utf8')),
    decryptString: (sealed) => scramble(sealed).toString('utf8'),
  };
}

function fixture(t, encryption = fakeEncryption()) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-app-bound-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, APP_BOUND_KEY_FILE);
  return { dir, file, store: new AppBoundKeyStore(file, encryption) };
}

test('the binding is the SHA-256 of the exact app_bound_encrypted_key text from Local State', async (t) => {
  const { dir } = fixture(t);
  assert.equal(appBoundBlobSha256(BLOB_A), sha256(BLOB_A));
  const localState = join(dir, 'Local State');
  writeFileSync(
    localState,
    JSON.stringify({ os_crypt: { encrypted_key: 'REBBUEkAAQID', app_bound_encrypted_key: BLOB_A } })
  );
  assert.equal(await readAppBoundBlobSha256(localState), sha256(BLOB_A));
  // No App-Bound key (older Chrome), unreadable or malformed Local State: no binding, never a throw.
  writeFileSync(localState, JSON.stringify({ os_crypt: { encrypted_key: 'REBBUEkAAQID' } }));
  assert.equal(await readAppBoundBlobSha256(localState), undefined);
  writeFileSync(localState, 'not json');
  assert.equal(await readAppBoundBlobSha256(localState), undefined);
  assert.equal(await readAppBoundBlobSha256(join(dir, 'missing')), undefined);
});

test('base64Bytes matches standard base64 for every tail length without making a string', () => {
  for (const length of [0, 1, 2, 3, 31, 32, 33]) {
    const bytes = randomBytes(length);
    assert.equal(base64Bytes(bytes).toString('latin1'), bytes.toString('base64'), `length ${length}`);
  }
});

test('a saved key is encrypted at rest and returned only for the blob it was bound to', async (t) => {
  const { file, store } = fixture(t);
  const key = randomBytes(32);
  assert.equal(await store.save(sha256(BLOB_A), key), true);
  const onDisk = readFileSync(file);
  assert.equal(onDisk.includes(key.toString('base64')), false, 'the key is not on disk in the clear');
  assert.equal(onDisk.includes(sha256(BLOB_A)), false, 'nor is the plaintext record');
  assert.equal(await store.exists(), true);
  const loaded = await store.load(sha256(BLOB_A));
  assert.deepEqual(loaded, key);
});

test('a key bound to a blob Chrome rotated away is discarded, not returned', async (t) => {
  const { file, store } = fixture(t);
  await store.save(sha256(BLOB_A), randomBytes(32));
  assert.equal(await store.load(sha256(BLOB_B)), null);
  assert.equal(existsSync(file), false, 'the stale key is deleted');
  assert.equal(await store.load(sha256(BLOB_A)), null, 'and does not come back for the old blob');
});

test('a key file that cannot be decrypted or parsed is discarded', async (t) => {
  const { file, store } = fixture(t);
  writeFileSync(file, Buffer.from('garbage'));
  assert.equal(await store.load(sha256(BLOB_A)), null);
  assert.equal(existsSync(file), false);
  // Decrypts, but is not a record of this version with a 32-byte key.
  const encryption = fakeEncryption();
  const wrongSize = new AppBoundKeyStore(file, encryption);
  writeFileSync(
    file,
    encryption.encryptString(JSON.stringify({ version: 1, blobSha256: sha256(BLOB_A), key: 'AAAA' }))
  );
  assert.equal(await wrongSize.load(sha256(BLOB_A)), null);
  assert.equal(existsSync(file), false);
});

test('without OS encryption nothing is stored and an existing file is left untouched', async (t) => {
  const { file, store } = fixture(t, fakeEncryption(false));
  assert.equal(store.available(), false);
  assert.equal(await store.save(sha256(BLOB_A), randomBytes(32)), false);
  assert.equal(existsSync(file), false);
  // A file written while encryption worked is not damaged just because it cannot be read now.
  writeFileSync(file, Buffer.from('written earlier'));
  assert.equal(await store.load(sha256(BLOB_A)), null);
  assert.equal(existsSync(file), true);
});

test('malformed keys or bindings are refused and forgetting removes the file', async (t) => {
  const { file, store } = fixture(t);
  assert.equal(await store.save(sha256(BLOB_A), randomBytes(16)), false);
  assert.equal(await store.save('not-a-hash', randomBytes(32)), false);
  assert.equal(existsSync(file), false);
  await store.save(sha256(BLOB_A), randomBytes(32));
  await store.forget();
  assert.equal(existsSync(file), false);
  await store.forget();
});
