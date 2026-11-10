import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-large-range-freshness-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const indexes = await import('./read-range-index.mjs');
const { streamReadRange, countLogicalLinesBytesSync } = await import('./read-streaming.mjs');
const { readSourceWindows } = await import('./read-source-windows.mjs');
const { renderReadLine } = await import('./read-formatting.mjs');
const { fileVersion } = await import('./file-version.mjs');
const { hashText } = await import('./hash-utils.mjs');
const { READ_PREFIX_HASH_BYTES, canCacheReadFile } = await import('./read-cache-policy.mjs');
const rows = Array.from({ length: 16000 }, (_, i) => `row-${String(i).padStart(5, '0')}-${'x'.repeat(30)}`);
const original = Buffer.from(`${rows.join('\n')}\n`);
const width = Buffer.byteLength(`${rows[0]}\n`);
let sequence = 0;

test.after(async () => {
  indexes.flushReadRangeIndexesSync();
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture(t) {
  const path = join(root, `${sequence++}.txt`);
  await fs.writeFile(path, original);
  const st = await fs.stat(path);
  assert.equal(canCacheReadFile(st), false);
  const handle = await fs.open(path, 'r');
  t.after(() => handle.close());
  // All five observed version fields collide, not just mtime and size.
  t.mock.method(handle, 'stat', async () => st);
  const stat = fs.stat;
  const mocked = t.mock.method(fs, 'stat', (file, ...args) =>
    file === path ? Promise.resolve(st) : stat(file, ...args)
  );
  const open = fs.open;
  const mockedOpen = t.mock.method(fs, 'open', async (file, ...args) => {
    const opened = await open(file, ...args);
    if (file === path) t.mock.method(opened, 'stat', async () => st);
    return opened;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    mockedOpen.mock.restore();
    syncBuiltinESMExports();
  });
  const disk = join(root, 'data', 'read-range-index', `${hashText(indexes.canonicalCachePath(path))}.json`);
  return { path, st, handle, disk };
}

async function rewriteSuffix(path) {
  const newline = original.indexOf(10, READ_PREFIX_HASH_BYTES + 1000);
  assert.ok(newline > READ_PREFIX_HASH_BYTES);
  const writer = await fs.open(path, 'r+');
  try {
    assert.equal((await writer.write(Buffer.from(' '), 0, 1, newline)).bytesWritten, 1);
  } finally {
    await writer.close();
  }
  const actual = await fs.readFile(path);
  const expected = Buffer.from(original);
  expected[newline] = 32;
  assert.deepEqual(actual, expected, 'the adversarial rewrite changes real suffix bytes only');
  assert.equal(actual.length, original.length);
  assert.deepEqual(actual.subarray(0, READ_PREFIX_HASH_BYTES), original.subarray(0, READ_PREFIX_HASH_BYTES));
  return actual;
}

for (const staleDisk of [false, true]) {
  test(`deep same-version suffix newlines never reuse large anchors/counts (${staleDisk ? 'old disk row' : 'memory'})`, async (t) => {
    const { path, st, handle, disk } = await fixture(t);
    assert.equal(
      (await streamReadRange(path, 9000, 1, st, { fileHandle: handle })).text.split('\n')[0],
      renderReadLine(9001, rows[9000])
    );
    assert.equal(await countLogicalLinesBytesSync(path, st.size, st), rows.length);
    indexes.flushReadRangeIndexesSync();
    assert.equal(existsSync(disk), false, 'even successful large scans publish nothing to disk');
    let stored;
    if (staleDisk) {
      stored = JSON.stringify({
        version: 2,
        path,
        fileVersion: fileVersion(st),
        prefixHash: hashText(original.subarray(0, READ_PREFIX_HASH_BYTES)),
        anchors: [
          [0, 0],
          [4096, 4096 * width],
          [8192, 8192 * width],
        ],
        totalLines: rows.length,
      });
      await fs.mkdir(join(root, 'data', 'read-range-index'), { recursive: true });
      await fs.writeFile(disk, stored);
    }
    const actual = await rewriteSuffix(path);
    assert.deepEqual(fileVersion(await handle.stat()), fileVersion(st));
    assert.deepEqual(fileVersion(await fs.stat(path)), fileVersion(st));
    const readFile = fs.readFile;
    let diskReads = 0;
    const mocked = t.mock.method(fs, 'readFile', (file, ...args) => {
      if (file === disk) diskReads++;
      return readFile(file, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      mocked.mock.restore();
      syncBuiltinESMExports();
    });
    const reader = staleDisk ? await import(`./read-range-index.mjs?large-disk-${sequence++}`) : indexes;
    const draft = await reader.getReadRangeIndex(path, st, handle);
    assert.deepEqual([...draft.anchors], [[0, 0]]);
    assert.equal(draft.totalLines, undefined);
    assert.equal(draft.prefixHash, '', 'large lookup performs no cache-only prefix hash');
    let trace;
    const result = await streamReadRange(path, 9000, 2, st, {
      fileHandle: handle,
      ioTraceDone: (_event, _start, detail) => {
        trace = detail;
      },
    });
    const expectedRows = actual.toString('utf8').split('\n');
    assert.equal(
      result.text.split('\n').slice(0, 2).join('\n'),
      expectedRows
        .slice(9000, 9002)
        .map((row, i) => renderReadLine(9001 + i, row))
        .join('\n')
    );
    assert.equal(result.firstEmitted, 9001);
    assert.equal(result.lastEmitted, 9002);
    assert.equal(trace.anchorLine, 0);
    assert.equal(trace.anchorByte, 0);
    assert.equal(result.prefixHash, hashText(original.subarray(0, READ_PREFIX_HASH_BYTES)));
    assert.deepEqual(result.readSnapshotStat, fileVersion(st));
    assert.equal((await readSourceWindows(path, [{ start: 9001, end: 9002 }])).get(9001), expectedRows[9000]);
    assert.equal(await countLogicalLinesBytesSync(path, st.size, st), rows.length - 1);
    assert.equal(diskReads, 0, 'old large-file disk evidence is not even loaded');
    indexes.flushReadRangeIndexesSync();
    if (staleDisk) assert.equal(await readFile(disk, 'utf8'), stored, 'no new large-file disk publication');
    else assert.equal(existsSync(disk), false);
    const next = await indexes.getReadRangeIndex(path, st, handle);
    assert.deepEqual([...next.anchors], [[0, 0]]);
    assert.equal(next.totalLines, undefined);
    assert.ok((await handle.stat()).isFile(), 'all validation borrows the caller handle');
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, null);
    assert.equal(byte.toString(), 'r', 'positional scans preserve the borrowed cursor');
  });
}

test('unchanged large early windows read one bounded chunk with no prefix-validation IO or publication', async (t) => {
  const { path, st, handle, disk } = await fixture(t);
  const read = handle.read.bind(handle);
  let bytes = 0;
  let calls = 0;
  t.mock.method(handle, 'read', async (...args) => {
    const result = await read(...args);
    bytes += result.bytesRead;
    calls++;
    assert.equal(args[3], 0);
    return result;
  });
  for (let i = 0; i < 2; i++) {
    const result = await streamReadRange(path, 0, 2, st, { fileHandle: handle, maxOutputBytes: 1024 });
    assert.equal(
      result.text.split('\n').slice(0, 2).join('\n'),
      rows
        .slice(0, 2)
        .map((row, j) => renderReadLine(j + 1, row))
        .join('\n')
    );
    assert.ok(Buffer.byteLength(result.text) <= 1024);
    assert.deepEqual(result.readSnapshotStat, fileVersion(st));
    assert.notEqual(result.readSnapshotStat, st);
  }
  assert.equal(calls, 2);
  assert.equal(bytes, 2 * READ_PREFIX_HASH_BYTES);
  indexes.flushReadRangeIndexesSync();
  assert.equal(existsSync(disk), false);
});

for (const boundary of ['handle', 'path', 'handle-failure', 'path-failure']) {
  test(`large returned bytes are never relabelled by a later ${boundary} version`, async (t) => {
    const { path, st, handle, disk } = await fixture(t);
    const later = { ...st, ctimeMs: st.ctimeMs + 1 };
    const terminalStat = () => {
      if (boundary.endsWith('-failure')) throw Object.assign(new Error('terminal stat unavailable'), { code: 'EIO' });
      return later;
    };
    const read = handle.read.bind(handle);
    let readBody = false;
    t.mock.method(handle, 'read', async (...args) => {
      const result = await read(...args);
      readBody = true;
      return result;
    });
    if (boundary.startsWith('handle')) t.mock.method(handle, 'stat', async () => (readBody ? terminalStat() : st));
    else {
      const stat = fs.stat;
      const mocked = t.mock.method(fs, 'stat', async (file, ...args) =>
        file === path && readBody ? terminalStat() : stat(file, ...args)
      );
      syncBuiltinESMExports();
      t.after(() => {
        mocked.mock.restore();
        syncBuiltinESMExports();
      });
    }
    const result = await streamReadRange(path, 9000, 1, st, { fileHandle: handle });
    assert.equal(result.text.split('\n')[0], renderReadLine(9001, rows[9000]));
    assert.equal(result.readSnapshotStat, null);
    indexes.flushReadRangeIndexesSync();
    assert.equal(existsSync(disk), false);
  });
}
