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

import fs from 'node:fs';
import { SAFETY_RECHECK_MS } from '../../../shared/watched-file-cache.mjs';
import {
  eventually,
  gateFirstAsyncStat,
  settle,
  spySyncFs,
  trackWatchers,
} from '../../../shared/watched-file-cache.test-helpers.mjs';
import { createGoalRuntime } from './goal-runtime.mjs';
import { GOAL_LIVE_HEARTBEAT_MS } from './goal-state.mjs';
import { createGoalStorage, deleteStoredGoalFile } from './goal-storage.mjs';

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
  test(`a removed record reads as no Goal even with an epoch timestamp=${epochTimestamp}`, async (t) => {
    const { path, storage } = fixture(t, async () => {});
    writeFileSync(path, JSON.stringify({ version: 1, goal: { id: 'g1', status: 'active' } }));
    if (epochTimestamp) utimesSync(path, new Date(0), new Date(0));
    assert.equal(storage.read('s').goal.id, 'g1');
    unlinkSync(path);
    await eventually(() => storage.read('s').goal === null);
  });
}

test('a NUL-filled or unsupported record reads as no Goal, kept aside; a good .bak is restored', async (t) => {
  const { dir, path, storage } = fixture(t, async () => {});
  writeFileSync(path, '\0'.repeat(32));
  assert.equal(storage.read('s').goal, null);
  writeFileSync(path, JSON.stringify({ version: 99, goal: { id: 'future' } }));
  await eventually(() => readdirSync(dir).filter((name) => name.includes('.corrupt-')).length >= 1);
  assert.equal(storage.read('s').goal, null);
  writeFileSync(`${path}.bak`, JSON.stringify({ version: 1, goal: { id: 'backup' } }));
  writeFileSync(path, '\0'.repeat(32));
  await eventually(() => storage.read('s').goal?.id === 'backup');
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

test('an atomic replacement with the same size and modification time invalidates the Goal cache', async (t) => {
  const { dir, path, storage } = fixture(t, async () => {});
  const replacement = join(dir, 'replacement.json');
  writeFileSync(path, JSON.stringify({ version: 1, goal: { id: 'old' } }));
  utimesSync(path, new Date(0), new Date(0));
  assert.equal(storage.read('s').goal.id, 'old');
  writeFileSync(replacement, JSON.stringify({ version: 1, goal: { id: 'new' } }));
  utimesSync(replacement, new Date(0), new Date(0));
  renameSync(replacement, path);
  await eventually(() => storage.read('s').goal.id === 'new');
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
  await eventually(() => storage.read('s').goal.id === 'newer');
  assert.deepEqual(storage.read('s'), replacement);
});

test('warm Goal reads touch no filesystem; our own write is visible at once', async (t) => {
  const { path, storage } = fixture(t, async (target, value) => writeFileSync(target, JSON.stringify(value)));
  writeFileSync(path, JSON.stringify({ version: 1, goal: { id: 'g1', status: 'active' } }));
  assert.equal(storage.read('s').goal.id, 'g1');
  const calls = spySyncFs(t);
  for (let i = 0; i < 5; i += 1) assert.equal(storage.read('s').goal.id, 'g1');
  assert.deepEqual(calls.splice(0), []);
  calls.paused = true;
  await storage.write('s', { version: 1, goal: { id: 'g2', status: 'active' } });
  calls.paused = false;
  assert.equal(storage.read('s').goal.id, 'g2');
  assert.deepEqual([...calls], [], 'the write-through value, not a disk read');
});

test('another process’s Goal write is seen through the directory watch', async (t) => {
  const { path, storage } = fixture(t, async () => {});
  writeFileSync(path, JSON.stringify({ version: 1, goal: { id: 'g1' } }));
  assert.equal(storage.read('s').goal.id, 'g1');
  writeFileSync(path, JSON.stringify({ version: 1, goal: { id: 'foreign' } }));
  await eventually(() => storage.read('s').goal.id === 'foreign');
});

test('without watch events the safety re-check sees another process’s write, and a late re-check never clobbers a newer local write', async (t) => {
  t.mock.method(fs, 'watch', () => {
    throw Object.assign(new Error('no watch'), { code: 'ENOSYS' });
  });
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { path, storage } = fixture(t, async (target, value) => writeFileSync(target, JSON.stringify(value)));
  writeFileSync(path, JSON.stringify({ version: 1, goal: { id: 'g1' } }));
  assert.equal(storage.read('s').goal.id, 'g1');
  writeFileSync(path, JSON.stringify({ version: 1, goal: { id: 'foreign' } }));
  await settle();
  assert.equal(storage.read('s').goal.id, 'g1', 'no re-check before its interval');
  t.mock.timers.tick(SAFETY_RECHECK_MS);
  await eventually(() => storage.read('s').goal.id === 'foreign');

  // A re-check whose stat is still in flight when we write locally.
  t.mock.timers.tick(SAFETY_RECHECK_MS);
  const releaseStat = gateFirstAsyncStat(t);
  assert.equal(storage.read('s').goal.id, 'foreign');
  await storage.write('s', { version: 1, goal: { id: 'local' } });
  assert.equal(storage.read('s').goal.id, 'local');
  await settle();
  assert.equal(storage.read('s').goal.id, 'local');
  releaseStat();
  await settle();
  const calls = spySyncFs(t);
  assert.equal(storage.read('s').goal.id, 'local', 'the late re-check did not replace the newer local write');
  assert.deepEqual([...calls], [], 'nor forced a reload');
});

const SESSION = 'sess_goal_storage_cache';

async function runtimeFixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-runtime-cache-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const clock = 1_800_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock, deadlineWarningMs: [], generateTitle: null });
  t.after(() => runtime.close());
  await runtime.control(SESSION, { action: 'create', objective: 'Ship the cache', duration: '1h' });
  // Our own write's verification has settled: the cache holds the disk's record.
  await settle();
  assert.equal(runtime.snapshot(SESSION).status, 'active');
  return { dataDir, runtime, clock, file: join(dataDir, 'goals', `${SESSION}.json`) };
}

test('a heartbeat on a warm cache modifies the record on disk, never a cached copy another writer replaced', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { runtime, clock, file } = await runtimeFixture(t);
  // Another process completes the Goal; its watch event has not arrived yet.
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(
    file,
    JSON.stringify({ ...stored, goal: { ...stored.goal, status: 'complete', completedAt: clock, updatedAt: clock } })
  );
  t.mock.timers.tick(GOAL_LIVE_HEARTBEAT_MS);
  await settle();
  await runtime.close();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).goal.status, 'complete');
});

test('a Goal file deleted in this process is gone from the runtime cache at once', async (t) => {
  const { dataDir, runtime, file } = await runtimeFixture(t);
  assert.equal(deleteStoredGoalFile(dataDir, SESSION), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(runtime.snapshot(SESSION), null);
});

test('closing the Goal runtime releases its storage watch', async (t) => {
  const watching = trackWatchers(t);
  const { dataDir, runtime } = await runtimeFixture(t);
  assert.deepEqual(watching(), [join(dataDir, 'goals')]);
  await runtime.close();
  assert.deepEqual(watching(), []);
});
