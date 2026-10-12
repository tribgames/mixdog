import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createNativePushStore } from './native-push-store.ts';

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const publicKey = ecdh.getPublicKey().toString('base64url');
const row = (clientId, token) => ({ clientId, platform: 'fcm', token, publicKey });

test('concurrent mutations are serialized and none is lost', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-push-race-'));
  try {
    const store = createNativePushStore(dir);
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const c = 'c'.repeat(40);
    await Promise.all([
      store.register(row('c1', a)),
      store.register(row('c2', b)),
      store.register(row('c3', c)),
      store.removeByClient('c2'),
    ]);
    const expected = ['c1', 'c3'];
    assert.deepEqual((await store.list()).map((r) => r.clientId).sort(), expected);
    assert.deepEqual((await createNativePushStore(dir).list()).map((r) => r.clientId).sort(), expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('state is published only after persistence succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-push-fail-'));
  try {
    const blocker = join(dir, 'not-a-directory');
    await writeFile(blocker, 'x');
    const store = createNativePushStore(blocker);
    await assert.rejects(store.register(row('c1', 'a'.repeat(40))));
    // Linux reports ENOTDIR (fail-closed read rejection) where Windows reports ENOENT (empty);
    // either way nothing may be published.
    assert.deepEqual(await store.list().catch(() => []), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
