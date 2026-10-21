import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, promises as fsp, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createRevocationDrain,
  loadOrCreateDevice,
  revocationQueueDamaged,
  rotateRemoteDevice,
} from './remote-relay-device';

const FILE = 'relay-device.json';
const REVOCATIONS = 'relay-device-revocations.json';
const queuedIds = (dir) =>
  JSON.parse(readFileSync(join(dir, REVOCATIONS), 'utf8')).map((identity) => identity.deviceId);

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-device-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const VALID = { deviceId: '11111111-2222-3333-4444-555555555555', deviceSecret: 'a'.repeat(48) };

test('absent file creates and persists an identity', async (t) => {
  const dir = tempDir(t);
  const created = await loadOrCreateDevice(dir);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, FILE), 'utf8')), created);
  assert.deepEqual(await loadOrCreateDevice(dir), created);
});

test('existing valid file loads unchanged', async (t) => {
  const dir = tempDir(t);
  const text = JSON.stringify(VALID, null, 2);
  writeFileSync(join(dir, FILE), text);
  assert.deepEqual(await loadOrCreateDevice(dir), VALID);
  assert.equal(readFileSync(join(dir, FILE), 'utf8'), text);
});

test('a readable file without a valid identity is kept aside and replaced', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, FILE), '{"deviceId":');
  const created = await loadOrCreateDevice(dir);
  assert.notEqual(created.deviceId, VALID.deviceId);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, FILE), 'utf8')), created);
  const kept = (await fsp.readdir(dir)).filter((name) => name.startsWith(`${FILE}.corrupt-`));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(dir, kept[0]), 'utf8'), '{"deviceId":');
});

test('lock error rethrows and leaves the file untouched', async (t) => {
  const dir = tempDir(t);
  const text = JSON.stringify(VALID, null, 2);
  writeFileSync(join(dir, FILE), text);
  const original = fsp.readFile;
  fsp.readFile = () => Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }));
  try {
    await assert.rejects(loadOrCreateDevice(dir), { code: 'EBUSY' });
  } finally {
    fsp.readFile = original;
  }
  assert.equal(readFileSync(join(dir, FILE), 'utf8'), text);
  assert.equal(existsSync(join(dir, `${FILE}.lock`)), false);
});

test('unpairing queues the replaced identity for revocation', async (t) => {
  const dir = tempDir(t);
  const first = await loadOrCreateDevice(dir);
  const second = await rotateRemoteDevice(dir);
  assert.notEqual(second.deviceId, first.deviceId);
  assert.deepEqual(queuedIds(dir), [first.deviceId]);
});

test('a NUL-filled revocation queue is kept aside and does not block unpairing', async (t) => {
  const dir = tempDir(t);
  const first = await loadOrCreateDevice(dir);
  writeFileSync(join(dir, REVOCATIONS), Buffer.alloc(200));
  await rotateRemoteDevice(dir);
  assert.deepEqual(queuedIds(dir), [first.deviceId]);
  const kept = (await fsp.readdir(dir)).filter((name) => name.startsWith(`${REVOCATIONS}.corrupt-`));
  assert.equal(kept.length, 1);
  assert.deepEqual(readFileSync(join(dir, kept[0])), Buffer.alloc(200));
});

test('a damaged queue is reported as damaged, never as empty', async (t) => {
  const dir = tempDir(t);
  assert.equal(await revocationQueueDamaged(dir), false, 'no queue was ever written');
  await loadOrCreateDevice(dir);
  await rotateRemoteDevice(dir);
  assert.equal(await revocationQueueDamaged(dir), false, 'a good queue');
  for (const content of [Buffer.alloc(200), '', '[{"deviceId":', '{}', 'null']) {
    writeFileSync(join(dir, REVOCATIONS), content);
    assert.equal(await revocationQueueDamaged(dir), true, JSON.stringify(String(content)));
  }
});

test('a queue holding any invalid identity is damaged, never a shorter or empty queue', async (t) => {
  const dir = tempDir(t);
  await loadOrCreateDevice(dir);
  for (const content of [
    '[{}]',
    '[1]',
    '[null]',
    JSON.stringify([VALID, {}]),
    JSON.stringify([{}, VALID]),
    JSON.stringify([VALID, { deviceId: 'zz', deviceSecret: 'short' }]),
  ]) {
    writeFileSync(join(dir, REVOCATIONS), content);
    assert.equal(await revocationQueueDamaged(dir), true, content);
  }
  writeFileSync(join(dir, REVOCATIONS), JSON.stringify([VALID]));
  assert.equal(await revocationQueueDamaged(dir), false, 'a queue of valid identities is whole');
});

test('an unreadable queue is an error, not a damaged or a good one', async (t) => {
  const dir = tempDir(t);
  await loadOrCreateDevice(dir);
  await rotateRemoteDevice(dir);
  const original = fsp.readFile;
  fsp.readFile = (path, ...rest) =>
    String(path).endsWith(REVOCATIONS)
      ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }))
      : original(path, ...rest);
  try {
    await assert.rejects(revocationQueueDamaged(dir), { code: 'EBUSY' });
  } finally {
    fsp.readFile = original;
  }
});

test('an older backup only adds revocations to attempt; the damage stays reported until unpairing rewrites the queue', async (t) => {
  const dir = tempDir(t);
  const id0 = await loadOrCreateDevice(dir);
  const id1 = await rotateRemoteDevice(dir); // queue [id0]
  const id2 = await rotateRemoteDevice(dir); // queue [id0, id1]; the backup holds [id0]
  writeFileSync(join(dir, REVOCATIONS), '[{"deviceId":');
  assert.equal(await revocationQueueDamaged(dir), true, 'the backup does not make the queue whole');
  await rotateRemoteDevice(dir); // replaces id2
  // id1 was only in the damaged file: it cannot be recovered, which is why the
  // damage itself (reported above) has to trigger a pairing reset.
  assert.deepEqual(queuedIds(dir), [id0.deviceId, id2.deviceId]);
  assert.notEqual(id1.deviceId, id0.deviceId);
  assert.equal(await revocationQueueDamaged(dir), false, 'the rewritten queue is whole again');
});

test('a damaged queue is rewritten on unpairing even when its backup already names the replaced identity', async (t) => {
  const dir = tempDir(t);
  await loadOrCreateDevice(dir);
  const current = await rotateRemoteDevice(dir); // queue [id0]
  // The backup is a copy of a queue that already names the identity about to be replaced.
  writeFileSync(join(dir, `${REVOCATIONS}.bak`), JSON.stringify([current]));
  writeFileSync(join(dir, REVOCATIONS), Buffer.alloc(50));
  await rotateRemoteDevice(dir);
  assert.deepEqual(queuedIds(dir), [current.deviceId]);
  assert.equal(await revocationQueueDamaged(dir), false);
});

test('the revocation drain leaves a damaged queue untouched instead of emptying it', async (t) => {
  const dir = tempDir(t);
  const identity = await loadOrCreateDevice(dir);
  writeFileSync(join(dir, REVOCATIONS), Buffer.alloc(120));
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const sockets = new Set();
  const drain = createRevocationDrain({
    relayUrl: 'ws://127.0.0.1:9',
    userDataPath: dir,
    deviceId: identity.deviceId,
    sockets,
    maxPayload: 1024,
    closed: () => false,
  });
  await drain();
  assert.deepEqual(readFileSync(join(dir, REVOCATIONS)), Buffer.alloc(120));
  assert.equal(sockets.size, 0);
  assert.equal(warnings.length, 1, 'the failure is logged, not thrown');
});

test('an unreadable revocation queue fails the unpair instead of being overwritten as empty', async (t) => {
  const dir = tempDir(t);
  await loadOrCreateDevice(dir);
  await rotateRemoteDevice(dir);
  const text = readFileSync(join(dir, REVOCATIONS), 'utf8');
  const original = fsp.readFile;
  fsp.readFile = (path, ...rest) =>
    String(path).endsWith(REVOCATIONS)
      ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }))
      : original(path, ...rest);
  try {
    await assert.rejects(rotateRemoteDevice(dir), { code: 'EBUSY' });
  } finally {
    fsp.readFile = original;
  }
  assert.equal(readFileSync(join(dir, REVOCATIONS), 'utf8'), text);
});

test('permission-check failure rethrows and leaves the file untouched', {
  skip: process.platform === 'win32',
}, async (t) => {
  const dir = tempDir(t);
  const text = JSON.stringify(VALID, null, 2);
  writeFileSync(join(dir, FILE), text);
  const original = fsp.chmod;
  fsp.chmod = () => Promise.reject(Object.assign(new Error('denied'), { code: 'EPERM' }));
  try {
    await assert.rejects(loadOrCreateDevice(dir), { code: 'EPERM' });
  } finally {
    fsp.chmod = original;
  }
  assert.equal(readFileSync(join(dir, FILE), 'utf8'), text);
});
