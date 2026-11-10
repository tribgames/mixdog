import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-source-share-test-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const { readSourceWindows } = await import('./read-source-windows.mjs');
const { invalidateBuiltinResultCache } = await import('./cache-layers.mjs');
const { flushReadRangeIndexesSync } = await import('./read-range-index.mjs');

after(async () => {
  flushReadRangeIndexesSync();
  await fs.rm(root, { recursive: true, force: true });
});

const T = { timeout: 30_000 };

// Wraps fs.open: counts opens/reads/closes; reads block until released.
// `opens` counts at open start, `reads` when a read arrives (before the gate),
// `closes` after the real close has completed. `waitFor(kind, n)` resolves
// once the counter reaches n. Held I/O is always released in cleanup.
function instrument(t) {
  const realOpen = fs.open;
  const stats = { opens: 0, reads: 0, closes: 0 };
  const waiters = [];
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const bump = (kind) => {
    stats[kind]++;
    for (const w of [...waiters]) {
      if (w.kind === kind && stats[kind] >= w.n) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };
  t.mock.method(fs, 'open', async (...args) => {
    bump('opens');
    const handle = await realOpen(...args);
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    handle.read = async (...a) => {
      bump('reads');
      await gate;
      return read(...a);
    };
    handle.close = async () => {
      try {
        return await close();
      } finally {
        bump('closes');
      }
    };
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {
    release();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return {
    stats,
    release: () => release(),
    waitFor: (kind, n) =>
      stats[kind] >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ kind, n, resolve })),
  };
}

async function makeFile(name, text) {
  const p = join(root, name);
  await fs.writeFile(p, text);
  return p;
}

test('concurrent identical calls share one file scan with isolated maps', T, async (t) => {
  const file = await makeFile('a.txt', 'one\r\ntwo\nthree');
  const io = instrument(t);
  const intervals = [{ start: 2, end: 3 }];
  const p1 = readSourceWindows(file, intervals);
  const p2 = readSourceWindows(file, [{ start: 2, end: 3 }]);
  await io.waitFor('reads', 1);
  intervals[0].start = 1; // caller mutation must not affect shared work
  io.release();
  const [m1, m2] = await Promise.all([p1, p2]);
  await io.waitFor('closes', 1);
  assert.equal(io.stats.opens, 1);
  // The fixture's final line has no newline: one data read plus one EOF
  // read completes that line. Two independent scans would do four reads.
  assert.equal(io.stats.reads, 2);
  assert.equal(io.stats.closes, 1);
  assert.deepEqual(
    [...m1],
    [
      [2, 'two'],
      [3, 'three'],
    ]
  );
  assert.notEqual(m1, m2);
  m1.set(99, 'x');
  m1.delete(2);
  assert.deepEqual(
    [...m2],
    [
      [2, 'two'],
      [3, 'three'],
    ]
  );
});

test('distinct windows and files start independently', T, async (t) => {
  const f1 = await makeFile('b1.txt', 'a\nb\nc\n');
  const f2 = await makeFile('b2.txt', 'x\ny\nz\n');
  const io = instrument(t);
  const ps = [
    readSourceWindows(f1, [{ start: 1, end: 1 }]),
    readSourceWindows(f1, [{ start: 2, end: 2 }]),
    readSourceWindows(f2, [{ start: 1, end: 1 }]),
  ];
  await io.waitFor('reads', 3);
  assert.equal(io.stats.opens, 3);
  io.release();
  const [r1, r2, r3] = await Promise.all(ps);
  assert.deepEqual([...r1], [[1, 'a']]);
  assert.deepEqual([...r2], [[2, 'b']]);
  assert.deepEqual([...r3], [[1, 'x']]);
});

test('completed reads are not cached', T, async (t) => {
  const file = await makeFile('c.txt', 'a\nb\n');
  const io = instrument(t);
  io.release();
  await readSourceWindows(file, [{ start: 1, end: 2 }]);
  await readSourceWindows(file, [{ start: 1, end: 2 }]);
  await io.waitFor('closes', 2);
  assert.equal(io.stats.opens, 2);
  assert.equal(io.stats.closes, 2);
});

test('mutation invalidation stops new readers joining an in-flight read', T, async (t) => {
  const file = await makeFile('d.txt', 'a\nb\n');
  const io = instrument(t);
  const p1 = readSourceWindows(file, [{ start: 1, end: 2 }]);
  await io.waitFor('reads', 1);
  invalidateBuiltinResultCache([file]);
  const p2 = readSourceWindows(file, [{ start: 1, end: 2 }]);
  await io.waitFor('reads', 2);
  assert.equal(io.stats.opens, 2);
  io.release();
  const [m1, m2] = await Promise.all([p1, p2]);
  assert.deepEqual(
    [...m1],
    [
      [1, 'a'],
      [2, 'b'],
    ]
  );
  assert.deepEqual(
    [...m2],
    [
      [1, 'a'],
      [2, 'b'],
    ]
  );
});

test('one subscriber abort keeps the read; last abort closes the handle', T, async (t) => {
  const file = await makeFile('e.txt', 'a\nb\n');
  const io = instrument(t);
  const c1 = new AbortController();
  const c2 = new AbortController();
  const p1 = readSourceWindows(file, [{ start: 1, end: 2 }], { signal: c1.signal });
  const p2 = readSourceWindows(file, [{ start: 1, end: 2 }], { signal: c2.signal });
  const r1 = assert.rejects(p1, { name: 'AbortError' });
  await io.waitFor('reads', 1);
  c1.abort();
  await r1;
  assert.equal(io.stats.closes, 0);
  const r2 = assert.rejects(p2, { name: 'AbortError' });
  c2.abort();
  await r2;
  io.release();
  await io.waitFor('closes', 1);
  assert.equal(io.stats.opens, 1);
  assert.equal(io.stats.closes, 1);
});

test('remaining reader completes after another subscriber aborts', T, async (t) => {
  const file = await makeFile('f.txt', 'a\nb\n');
  const io = instrument(t);
  const c1 = new AbortController();
  const p1 = readSourceWindows(file, [{ start: 2, end: 2 }], { signal: c1.signal });
  const p2 = readSourceWindows(file, [{ start: 2, end: 2 }]);
  const r1 = assert.rejects(p1, { name: 'AbortError' });
  await io.waitFor('reads', 1);
  c1.abort();
  await r1;
  io.release();
  assert.deepEqual([...(await p2)], [[2, 'b']]);
  await io.waitFor('closes', 1);
  assert.equal(io.stats.opens, 1);
  assert.equal(io.stats.closes, 1);
});

test('non-regular files are rejected without reading', T, async (t) => {
  const io = instrument(t);
  io.release();
  await assert.rejects(readSourceWindows(root, [{ start: 1, end: 1 }]));
  assert.equal(io.stats.reads, 0);
});
