import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-range-persist-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const cacheDir = join(process.env.MIXDOG_DATA_DIR, 'read-range-index');
const {
  getReadRangeIndex,
  publishReadRangeIndex,
  flushReadRangeIndexesSync,
  deleteReadRangeIndexForPath,
  readRangeIndexPersistStats: stats,
} = await import('./read-range-index.mjs');

after(async () => {
  flushReadRangeIndexesSync();
  await fs.rm(root, { recursive: true, force: true });
});

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(10);
  }
  assert.fail('condition not reached');
}

async function fixture(name) {
  const file = join(root, name);
  await fs.writeFile(file, 'a\nb\nc\n');
  return file;
}

async function publish(file, line) {
  const handle = await fs.open(file, 'r');
  try {
    const draft = await getReadRangeIndex(file, await handle.stat(), handle);
    draft.anchors.set(line, line * 10);
    assert.equal(await publishReadRangeIndex(draft, handle), true);
  } finally {
    await handle.close();
  }
}

async function cacheFiles() {
  try {
    return (await fs.readdir(cacheDir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
}

async function readAnchorLines(file) {
  const names = await cacheFiles();
  for (const name of names) {
    let row;
    try {
      row = JSON.parse(await fs.readFile(join(cacheDir, name), 'utf8'));
    } catch {
      continue; // removed (or mid-replace) between readdir and read
    }
    if (row.path === file) return row.anchors.map(([line]) => line);
  }
  return null;
}

// Holds cache-dir temp-file writes until release(); counts how many started.
function holdWrites(t) {
  const original = fs.writeFile;
  const gate = { entered: 0, open: false, waiters: [] };
  gate.release = () => {
    gate.open = true;
    for (const w of gate.waiters.splice(0)) w();
  };
  t.mock.method(fs, 'writeFile', async (path, ...rest) => {
    if (String(path).startsWith(cacheDir) && /\.json\.[0-9a-f]+\.tmp$/.test(String(path))) {
      gate.entered += 1;
      if (!gate.open) await new Promise((resolve) => gate.waiters.push(resolve));
    }
    return original(path, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => {
    gate.release();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return gate;
}

test('schedules during an in-flight write coalesce into one follow-up with the latest content', async (t) => {
  const file = await fixture('coalesce.txt');
  const gate = holdWrites(t);
  const before = stats.writes;
  await publish(file, 1);
  await until(() => gate.entered === 1);
  for (let line = 2; line <= 30; line += 1) await publish(file, line);
  gate.release();
  await until(async () => (await readAnchorLines(file))?.includes(30));
  await sleep(1000);
  assert.equal(gate.entered, 2);
  assert.equal(stats.writes - before, 2);
});

test('unchanged serialized content is not rewritten', async () => {
  const file = await fixture('unchanged.txt');
  const base = stats.writes;
  await publish(file, 5);
  // stats.writes ticks only after the atomic write (rename + lock release)
  // returns, so the cache file can be visible a few turns before the counter
  // moves. Wait on the counter itself, not on the file appearing.
  await until(() => stats.writes === base + 1);
  assert.ok((await readAnchorLines(file))?.includes(5));
  const before = stats.writes;
  await publish(file, 5);
  await sleep(1200);
  assert.equal(stats.writes, before);
});

test('concurrent cache-file writes across paths are capped', async (t) => {
  const gate = holdWrites(t);
  const files = [];
  for (let i = 0; i < 5; i += 1) files.push(await fixture(`cap-${i}.txt`));
  for (const file of files) await publish(file, 7);
  await until(() => gate.entered >= 2);
  await sleep(300);
  assert.equal(gate.entered, 2);
  gate.release();
  await until(async () => {
    for (const file of files) if (!(await readAnchorLines(file))) return false;
    return true;
  });
  assert.ok(stats.maxConcurrent <= 2);
});

test('delete cancels a pending write', async () => {
  const file = await fixture('del-pending.txt');
  const before = stats.writes;
  await publish(file, 3);
  deleteReadRangeIndexForPath(file);
  await sleep(1200);
  assert.equal(stats.writes, before);
  assert.equal(await readAnchorLines(file), null);
});

test('delete during an in-flight write leaves no cache file behind', async (t) => {
  const file = await fixture('del-inflight.txt');
  const gate = holdWrites(t);
  await publish(file, 4);
  await until(() => gate.entered === 1);
  deleteReadRangeIndexForPath(file);
  gate.release();
  await sleep(1000);
  assert.equal(await readAnchorLines(file), null);
  // A fresh index for the path persists normally afterwards.
  await publish(file, 9);
  await until(async () => (await readAnchorLines(file))?.includes(9));
});

test('a read after delete never observes the deleted index while a cancelled write lands', async (t) => {
  const file = await fixture('del-window.txt');
  const writes = holdWrites(t);
  const originalUnlink = fs.unlink;
  const unlinks = { open: false, waiters: [] };
  t.mock.method(fs, 'unlink', async (path, ...rest) => {
    if (/[0-9a-f]{64}\.json$/.test(String(path)) && !unlinks.open) {
      await new Promise((resolve) => unlinks.waiters.push(resolve));
    }
    return originalUnlink(path, ...rest);
  });
  syncBuiltinESMExports();
  const openUnlinks = () => {
    unlinks.open = true;
    for (const w of unlinks.waiters.splice(0)) w();
  };
  t.after(openUnlinks);

  await publish(file, 4);
  await until(() => writes.entered === 1);
  deleteReadRangeIndexForPath(file);
  writes.release();
  // The cancelled write has renamed its file into place; cleanup is still held.
  await until(async () => (await readAnchorLines(file))?.includes(4));
  const handle = await fs.open(file, 'r');
  try {
    const draft = await getReadRangeIndex(file, await handle.stat(), handle);
    assert.equal(draft.anchors.has(4), false);
    draft.anchors.set(11, 110);
    assert.equal(await publishReadRangeIndex(draft, handle), true);
  } finally {
    await handle.close();
  }
  openUnlinks();
  await until(async () => !(await readAnchorLines(file))?.includes(4));
  await until(async () => (await readAnchorLines(file))?.includes(11));
  assert.equal((await readAnchorLines(file)).includes(4), false);
  const again = await fs.open(file, 'r');
  try {
    const draft = await getReadRangeIndex(file, await again.stat(), again);
    assert.equal(draft.anchors.has(4), false);
  } finally {
    await again.close();
  }
});

test('exit flush keeps a job the sync write could not take so the async follow-up persists it', async (t) => {
  const file = await fixture('flush-contended.txt');
  const gate = holdWrites(t);
  await publish(file, 1);
  await until(() => gate.entered === 1);
  await publish(file, 2);
  flushReadRangeIndexesSync(); // async writer holds the lock: sync write is refused
  gate.release();
  await until(async () => (await readAnchorLines(file))?.includes(2));
});

test('exit flush persists a pending index synchronously', async () => {
  const file = await fixture('flush.txt');
  await publish(file, 6);
  assert.equal(await readAnchorLines(file), null);
  flushReadRangeIndexesSync();
  assert.ok((await readAnchorLines(file))?.includes(6));
});
