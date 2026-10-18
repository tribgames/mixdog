import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, promises as fsp, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadOrCreateDevice } from './remote-relay-device';

const FILE = 'relay-device.json';

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
