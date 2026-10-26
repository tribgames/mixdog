import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRemoteMethods, executeRemoteFrame } from './remote-methods.ts';
import { createRemoteControllerKeys } from './remote-controller-keys.ts';
import { loadRemoteClientCache } from './remote-client-cache.ts';
import { REMOTE_CONTROLLER_KEY_METHOD } from '../shared/remote-controller-key.ts';
import { generateSecureDesktopControllerKey } from '../shared/secure-desktop-grant.ts';

async function tempCache(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-controller-keys-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, cache: await loadRemoteClientCache(dir) };
}

/** One phone connection's RPC as the relay serves it: the method table bound
 *  to the credential the relay authenticated for that leg. */
const call = (keys, credentialId, params) =>
  executeRemoteFrame(
    createRemoteMethods({ host: {}, screenControllerKeys: keys }, { credentialId: () => credentialId }),
    JSON.stringify({ id: 1, method: REMOTE_CONTROLLER_KEY_METHOD, params })
  );

test('a paired connection’s key is kept with its paired-device record, bound to the credential the relay authenticated', async (t) => {
  const { dir, cache } = await tempCache(t);
  const announced = [];
  const keys = createRemoteControllerKeys(cache, (key) => announced.push(key));
  const { publicKey } = await generateSecureDesktopControllerKey();
  assert.deepEqual(await call(keys, 'phone-a', [publicKey]), { id: 1, ok: true, value: true });
  assert.deepEqual(keys.list(), [{ clientId: 'phone-a', publicKey, unpaired: false }]);
  assert.deepEqual(announced, [publicKey], 'the desktop app is told, to enroll it');

  // It survives a restart, and goes with the device's confirmed unpair.
  const reloaded = await loadRemoteClientCache(dir);
  assert.deepEqual(reloaded.controllerKeys(), [{ clientId: 'phone-a', publicKey, unpaired: false }]);
  await reloaded.queueRevoke('phone-a');
  assert.deepEqual(reloaded.controllerKeys(), [{ clientId: 'phone-a', publicKey, unpaired: true }]);
  await reloaded.applied('phone-a', reloaded.revocation('phone-a'));
  assert.deepEqual(reloaded.controllerKeys(), []);
  assert.doesNotMatch(await readFile(join(dir, 'remote-clients.json'), 'utf8'), /phone-a/);
});

test('a key from a connection with no paired credential, from an unpaired device, or not a key is refused', async (t) => {
  const { cache } = await tempCache(t);
  const announced = [];
  const keys = createRemoteControllerKeys(cache, (key) => announced.push(key));
  const { publicKey } = await generateSecureDesktopControllerKey();
  const refused = async (credentialId, params) => {
    const response = await call(keys, credentialId, params);
    assert.equal(response.ok, false, `${credentialId}: ${JSON.stringify(params).slice(0, 40)}`);
  };
  await refused('', [publicKey]);
  await cache.queueRevoke('phone-gone');
  await refused('phone-gone', [publicKey]);
  await refused('phone-a', ['not-a-key']);
  await refused('phone-a', [{ publicKey }]);
  assert.deepEqual(keys.list(), []);
  assert.deepEqual(announced, [], 'a refused key never reaches the enroll');
});

test('every pairing removal owes the PC access key in the same write that unpairs or forgets the device', async (t) => {
  const { dir, cache } = await tempCache(t);
  const keys = createRemoteControllerKeys(cache);
  const [a, b, c] = await Promise.all(
    [1, 2, 3].map(async () => (await generateSecureDesktopControllerKey()).publicKey)
  );
  await cache.setControllerKey('phone-a', a);
  await cache.setControllerKey('phone-b', b);
  await cache.setControllerKey('phone-c', c);
  const owedOnDisk = async () => JSON.parse(await readFile(join(dir, 'remote-clients.json'), 'utf8')).owedAccessKeys;

  // Single unpair: owed as it is queued, still owed once confirmed.
  await cache.queueRevoke('phone-a');
  assert.deepEqual(await owedOnDisk(), [a]);
  await cache.applied('phone-a', cache.revocation('phone-a'));
  assert.deepEqual(keys.owed(), { keys: [a], unknown: 0 });

  // Rotate / recovery: every mapped key owed (explicitly first, and again by the reset itself).
  await cache.oweAccess('all');
  assert.deepEqual(await owedOnDisk(), [a, b, c]);
  await cache.clear();
  assert.deepEqual(keys.list(), []);
  assert.deepEqual(await owedOnDisk(), [a, b, c], 'the reset keeps what is owed');
  await cache.settleOwedAccess([a, b, c], 0);
  await cache.setControllerKey('phone-b', b);
  await cache.clear();
  assert.deepEqual(await owedOnDisk(), [b], 'the reset owes what it forgets');

  // The app took them over: settled, across a restart too.
  await keys.settleOwed([[b], 0]);
  assert.deepEqual((await loadRemoteClientCache(dir)).owedAccess(), { keys: [], unknown: 0 });
  await assert.rejects(keys.settleOwed(['nope', 0]), TypeError);
});

test('a phone that delivers a new key owes the replaced one in the same write; the same key again owes nothing', async (t) => {
  const { dir, cache } = await tempCache(t);
  const keys = createRemoteControllerKeys(cache);
  const [a, b] = await Promise.all([1, 2].map(async () => (await generateSecureDesktopControllerKey()).publicKey));
  const onDisk = async () => JSON.parse(await readFile(join(dir, 'remote-clients.json'), 'utf8'));

  // Same key again: no debt.
  assert.deepEqual(await call(keys, 'phone-a', [a]), { id: 1, ok: true, value: true });
  assert.deepEqual(await call(keys, 'phone-a', [a]), { id: 1, ok: true, value: true });
  assert.deepEqual(keys.owed(), { keys: [], unknown: 0 });

  // Replaced (the phone cleared its app data): A owed with B's mapping, on disk together.
  assert.deepEqual(await call(keys, 'phone-a', [b]), { id: 1, ok: true, value: true });
  const written = await onDisk();
  assert.deepEqual([written.controllerKeys['phone-a'], written.owedAccessKeys], [b, [a]]);

  // Its unpair then leaves both owed.
  await cache.queueRevoke('phone-a');
  assert.deepEqual(keys.owed(), { keys: [a, b], unknown: 0 });
  assert.deepEqual((await loadRemoteClientCache(dir)).owedAccess(), { keys: [a, b], unknown: 0 });
});

test('a replacement that could not be written changes neither the mapping nor the debt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-controller-keys-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'user');
  await mkdir(dir);
  const cache = await loadRemoteClientCache(dir);
  const [a, b] = await Promise.all([1, 2].map(async () => (await generateSecureDesktopControllerKey()).publicKey));
  await cache.setControllerKey('phone-a', a);
  // A file where the profile directory goes: the next write fails.
  await rm(dir, { recursive: true, force: true });
  await writeFile(dir, 'not a directory');
  await assert.rejects(cache.setControllerKey('phone-a', b));
  assert.deepEqual(cache.controllerKeys(), [{ clientId: 'phone-a', publicKey: a, unpaired: false }]);
  assert.deepEqual(cache.owedAccess(), { keys: [], unknown: 0 });
  // Written next time: replaced and owed together.
  await rm(dir);
  await mkdir(dir);
  await cache.setControllerKey('phone-a', b);
  assert.deepEqual((await loadRemoteClientCache(dir)).owedAccess(), { keys: [a], unknown: 0 });
});

test('a damaged client record makes the owed access revocations unknown until the app settles that marker', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-controller-keys-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'remote-clients.json'), Buffer.alloc(64));
  const cache = await loadRemoteClientCache(dir);
  const owed = cache.owedAccess();
  assert.ok(owed.unknown > 0);
  await cache.clear();
  assert.deepEqual((await loadRemoteClientCache(dir)).owedAccess(), owed, 'the pairing reset keeps it');
  await cache.settleOwedAccess([], owed.unknown + 1);
  assert.equal(cache.owedAccess().unknown, owed.unknown, 'another marker never clears it');
  await cache.settleOwedAccess([], owed.unknown);
  assert.equal(cache.owedAccess().unknown, 0);

  // A wrong-shaped owed list is damage, not an empty one.
  await writeFile(join(dir, 'remote-clients.json'), JSON.stringify({ pendingRevokes: [], owedAccessKeys: ['x'] }));
  const damaged = await loadRemoteClientCache(dir);
  assert.equal(damaged.repairRequired(), true);
  assert.ok(damaged.owedAccess().unknown > 0);
});

test('only the relay leg serves the method: a table without the paired-device keys has none', async () => {
  const { publicKey } = await generateSecureDesktopControllerKey();
  const methods = createRemoteMethods({ host: {} }, { credentialId: () => 'phone-a' });
  assert.equal(Object.hasOwn(methods, REMOTE_CONTROLLER_KEY_METHOD), false);
  const response = await executeRemoteFrame(
    methods,
    JSON.stringify({ id: 2, method: REMOTE_CONTROLLER_KEY_METHOD, params: [publicKey] })
  );
  assert.equal(response.ok, false);
});
