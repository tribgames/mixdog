import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGoalStorage } from './goal-storage.mjs';

const normalize = (goal) => goal;

function fixture(t, writeRecord) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-goal-storage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'session.json');
  const storage = createGoalStorage({
    pathFor: () => path,
    normalizeGoal: normalize,
    now: () => 1_000,
    writeRecord,
  });
  return { dir, path, storage };
}

test('a read inside our own in-flight write answers from the committed cache', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { path, storage } = fixture(t, async (target, value) => {
    await gate;
    writeFileSync(target, JSON.stringify(value));
  });
  writeFileSync(path, JSON.stringify({ version: 1, goal: { id: 'g1', status: 'active' } }));
  assert.equal(storage.read('s').goal.id, 'g1');

  const pending = storage.write('s', { version: 1, goal: { id: 'g1', status: 'complete' } });
  // The file is mid-replace: on disk it can be momentarily absent or refused.
  unlinkSync(path);
  assert.equal(storage.read('s').goal.status, 'active', 'the last durable record, never "no Goal"');

  release();
  await pending;
  assert.equal(storage.read('s').goal.status, 'complete');
});

for (const epochTimestamp of [false, true]) {
  test(`a removed record reads as no Goal even with an epoch timestamp=${epochTimestamp}`, (t) => {
    const { path, storage } = fixture(t, async () => {});
    writeFileSync(path, JSON.stringify({ version: 1, goal: { id: 'g1', status: 'active' } }));
    if (epochTimestamp) utimesSync(path, new Date(0), new Date(0));
    assert.equal(storage.read('s').goal.id, 'g1');
    unlinkSync(path);
    assert.equal(storage.read('s').goal, null);
  });
}

test('a NUL-filled or unsupported record reads as no Goal, kept aside; a good .bak is restored', (t) => {
  const { dir, path, storage } = fixture(t, async () => {});
  writeFileSync(path, '\0'.repeat(32));
  assert.equal(storage.read('s').goal, null);
  writeFileSync(path, JSON.stringify({ version: 99, goal: { id: 'future' } }));
  assert.equal(storage.read('s').goal, null);
  assert.equal(readdirSync(dir).filter((name) => name.includes('.corrupt-')).length >= 1, true);
  writeFileSync(`${path}.bak`, JSON.stringify({ version: 1, goal: { id: 'backup' } }));
  writeFileSync(path, '\0'.repeat(32));
  assert.equal(storage.read('s').goal.id, 'backup');
});

test('a write refuses to replace a record from a newer build, keeping it and its backup', async (t) => {
  let writes = 0;
  const { dir, path, storage } = fixture(t, async (target, value) => {
    writes += 1;
    writeFileSync(target, JSON.stringify(value));
  });
  const future = JSON.stringify({ version: 99, goal: { id: 'future' } });
  writeFileSync(path, future);
  writeFileSync(`${path}.bak`, JSON.stringify({ version: 1, goal: { id: 'older' } }));
  await assert.rejects(
    storage.write('s', { version: 1, goal: { id: 'mine' } }),
    (error) => error.code === 'EGOALNEWERVERSION' && /newer build/.test(error.message)
  );
  assert.equal(writes, 0, 'the writer was never reached');
  assert.equal(readFileSync(path, 'utf8'), future);
  assert.equal(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).goal.id, 'older');
  assert.equal(
    readdirSync(dir).some((name) => name.includes('.corrupt-')),
    false
  );
  // Current-version, damaged and absent records stay writable.
  for (const before of [JSON.stringify({ version: 1, goal: null }), '\0'.repeat(16), null]) {
    if (before === null) unlinkSync(path);
    else writeFileSync(path, before);
    await storage.write('s', { version: 1, goal: { id: 'mine' } });
  }
  assert.equal(writes, 3);
});

test('an atomic replacement with the same size and modification time invalidates the Goal cache', (t) => {
  const { dir, path, storage } = fixture(t, async () => {});
  const replacement = join(dir, 'replacement.json');
  writeFileSync(path, JSON.stringify({ version: 1, goal: { id: 'old' } }));
  utimesSync(path, new Date(0), new Date(0));
  assert.equal(storage.read('s').goal.id, 'old');
  writeFileSync(replacement, JSON.stringify({ version: 1, goal: { id: 'new' } }));
  utimesSync(replacement, new Date(0), new Date(0));
  renameSync(replacement, path);
  assert.equal(storage.read('s').goal.id, 'new');
});

test('post-write caching cannot attribute another writer’s file to our older snapshot', async (t) => {
  const replacement = { version: 1, goal: { id: 'newer' } };
  const { storage } = fixture(t, async (path, record) => {
    writeFileSync(path, JSON.stringify(record));
    // Another owner publishes after our durable write, before its promise
    // continuation can observe filesystem metadata.
    writeFileSync(path, JSON.stringify(replacement));
  });
  await storage.write('s', { version: 1, goal: { id: 'older' } });
  assert.deepEqual(storage.read('s'), replacement);
});
