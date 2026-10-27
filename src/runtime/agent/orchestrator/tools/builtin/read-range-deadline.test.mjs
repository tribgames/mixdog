import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-range-deadline-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const indexes = await import('./read-range-index.mjs');
const { streamReadRange, countLogicalLinesBytesSync } = await import('./read-streaming.mjs');
const { readSourceWindows } = await import('./read-source-windows.mjs');
const { READ_STREAM_TIMEOUT_MS } = await import('./read-constants.mjs');
const { hashText } = await import('./hash-utils.mjs');
const { getReadRangeIndex, publishReadRangeIndex, maybeRecordReadRangeAnchor, flushReadRangeIndexesSync } = indexes;
const rows = Array.from({ length: 12000 }, (_, i) => `r${i.toString(36).padStart(3, '0')}`);
const body = rows.join('\n') + '\n';
const largeBody = Array.from({ length: 12000 }, (_, i) => `line-${i}-${'x'.repeat(30)}`).join('\n') + '\n';
let sequence = 0;
test.after(async () => {
  flushReadRangeIndexesSync();
  await fs.rm(root, { recursive: true, force: true });
});
const diskPath = (path) => join(root, 'data', 'read-range-index', `${hashText(indexes.canonicalCachePath(path))}.json`);
async function fixture(seed, large = false) {
  const path = join(root, `${sequence++}.txt`);
  await fs.writeFile(path, large ? largeBody : body);
  const st = await fs.stat(path);
  if (seed) await streamReadRange(path, 4500, 1, st);
  flushReadRangeIndexesSync();
  const before = existsSync(diskPath(path)) ? await fs.readFile(diskPath(path), 'utf8') : null;
  const draft = await getReadRangeIndex(path, st);
  assert.equal(draft.anchors.has(4096), !!seed && !large, 'only successful small scans reuse anchors');
  return { path, st, before, anchors: [...draft.anchors] };
}
async function assertUnpublished(f) {
  flushReadRangeIndexesSync();
  if (f.before === null) assert.equal(existsSync(diskPath(f.path)), false, 'no failed-scan disk publication');
  else assert.equal(await fs.readFile(diskPath(f.path), 'utf8'), f.before, 'the committed disk row is preserved');
  const next = await getReadRangeIndex(f.path, f.st);
  assert.deepEqual([...next.anchors], f.anchors, 'prior successful anchors survive, but no new ones are reusable');
  assert.equal(next.totalLines, undefined, 'a failed count is not published');
}
function mockFs(t, name, impl) {
  const mocked = t.mock.method(fs, name, impl(fs[name]));
  syncBuiltinESMExports();
  return () => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  };
}
const routes = [
  {
    name: 'source',
    run: (f) => readSourceWindows(f.path, [{ start: 9001, end: 9001 }]),
    finalStat: 4,
    finalPathStat: 2,
  },
  { name: 'range', run: (f) => streamReadRange(f.path, 9000, 1, f.st), finalStat: 3, finalPathStat: 1 },
  { name: 'count', run: (f) => countLogicalLinesBytesSync(f.path, f.st.size, f.st), finalStat: 3, finalPathStat: 1 },
];

for (const route of routes)
  for (const seed of [false, true])
    for (const large of [false, true])
      for (const stage of ['descriptor', 'path']) {
        test(`${route.name}: expiry during final ${stage} validation cannot publish (${large ? 'large private' : 'small cached'}, ${seed ? 'prior read' : 'fresh'})`, async (t) => {
          const f = await fixture(seed, large);
          let now = 1000;
          let expired = false;
          let pathStats = 0;
          t.mock.method(Date, 'now', () => now);
          const expire = () => {
            expired = true;
            now += READ_STREAM_TIMEOUT_MS + 1;
          };
          const restore =
            stage === 'path'
              ? mockFs(t, 'stat', (original) => async (path, ...args) => {
                  const st = await original(path, ...args);
                  if (path === f.path && ++pathStats === route.finalPathStat) expire();
                  return st;
                })
              : mockFs(t, 'open', (original) => async (path, ...args) => {
                  const handle = await original(path, ...args);
                  if (path === f.path) {
                    const stat = handle.stat.bind(handle);
                    let calls = 0;
                    handle.stat = async (...options) => {
                      const st = await stat(...options);
                      if (++calls === route.finalStat - Number(large)) expire();
                      return st;
                    };
                  }
                  return handle;
                });
          t.after(restore);
          await assert.rejects(route.run(f), /timed out/);
          assert.equal(expired, true, 'the final validation barrier was reached');
          restore();
          await assertUnpublished(f);
        });
      }

for (const route of routes) {
  test(`${route.name}: expired validation IO failure still checks the unpublished return path`, async (t) => {
    const f = await fixture(true);
    let now = 1000;
    let pathStats = 0;
    t.mock.method(Date, 'now', () => now);
    const restore = mockFs(t, 'stat', (original) => async (path, ...args) => {
      if (path !== f.path || ++pathStats < route.finalPathStat) return original(path, ...args);
      now += READ_STREAM_TIMEOUT_MS + 1;
      throw Object.assign(new Error('final stat unavailable'), { code: 'EIO' });
    });
    t.after(restore);
    await assert.rejects(route.run(f), /timed out/);
    restore();
    await assertUnpublished(f);
  });
}

test('successful source publication is the terminal deadline decision', async (t) => {
  const f = await fixture(false);
  let now = 1000;
  let crossedAfterCommit = false;
  t.mock.method(Date, 'now', () => now);
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms === 750) {
      // Persistence scheduling occurs after the synchronous shared-state commit.
      // Run before the awaiting source reader resumes, without timing a real race.
      queueMicrotask(() => {
        now += READ_STREAM_TIMEOUT_MS + 1;
        crossedAfterCommit = true;
      });
    }
    return timer(fn, ms, ...args);
  });
  assert.equal((await routes[0].run(f)).get(9001), rows[9000]);
  assert.equal(crossedAfterCommit, true);
  flushReadRangeIndexesSync();
  assert.equal(
    JSON.parse(await fs.readFile(diskPath(f.path), 'utf8')).anchors.some(([line]) => line === 8192),
    true
  );
});

test('a synchronous publication guard failure propagates without erasing committed anchors', async () => {
  const f = await fixture(true);
  const handle = await fs.open(f.path, 'r');
  try {
    const draft = await getReadRangeIndex(f.path, f.st, handle);
    maybeRecordReadRangeAnchor(draft, 8192, 42);
    const failure = new Error('publication guard refused');
    await assert.rejects(
      publishReadRangeIndex(draft, handle, null, () => {
        throw failure;
      }),
      (error) => error === failure
    );
    assert.equal(await publishReadRangeIndex(draft, handle), false, 'a refused draft is consumed');
    await assertUnpublished(f);
  } finally {
    await handle.close();
  }
});
