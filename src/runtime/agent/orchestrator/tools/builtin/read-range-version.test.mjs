import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { differentFieldValue } from './file-version-test-helpers.mjs';

const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-range-version-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const indexes = await import('./read-range-index.mjs');
const { streamReadRange, countLogicalLinesBytesSync } = await import('./read-streaming.mjs');
const { readSourceWindows } = await import('./read-source-windows.mjs');
const { renderReadLine } = await import('./read-formatting.mjs');
const { hashText } = await import('./hash-utils.mjs');
const { fileVersion } = await import('./file-version.mjs');
const {
  getReadRangeIndex,
  publishReadRangeIndex,
  maybeRecordReadRangeAnchor,
  flushReadRangeIndexesSync,
  deleteReadRangeIndexForPath,
} = indexes;
test.after(async () => {
  flushReadRangeIndexesSync();
  await fs.rm(root, { recursive: true, force: true });
});
let sequence = 0;
const rows = Array.from({ length: 12000 }, (_, i) => `row-${String(i).padStart(5, '0')}-${'x'.repeat(30)}`);
const text = `${rows.join('\n')}\n`;
const time = new Date('2020-01-01T00:00:00Z');
const first = (result) => result.text.split('\n')[0];
const rowFile = (path) => join(root, 'data', 'read-range-index', `${hashText(indexes.canonicalCachePath(path))}.json`);
async function fixture(body = text) {
  const path = join(root, `file-${sequence++}.txt`);
  await fs.writeFile(path, body);
  await fs.utimes(path, time, time);
  return { path, st: await fs.stat(path) };
}
async function borrowed(t, path) {
  const handle = await fs.open(path, 'r');
  t.after(() => handle.close());
  return handle;
}
function changed(st, field) {
  return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
    [field]: differentFieldValue(st[field], field),
  });
}
function mockFs(t, name, fn) {
  const mock = t.mock.method(fs, name, fn);
  syncBuiltinESMExports();
  const restore = () => {
    mock.mock.restore();
    syncBuiltinESMExports();
  };
  t.after(restore);
  return restore;
}
async function rewriteSuffix(path, st) {
  // Fixed initial mtime allows an exact restoration, rather than Date rounding.
  // Let real ctime advance even on coarser platform clocks; no race is timed.
  await delay(20);
  const newline = text.indexOf('\n', 70000);
  const replacement = `${text.slice(0, newline)} ${text.slice(newline + 1)}`;
  await fs.writeFile(path, replacement);
  await fs.utimes(path, time, time);
  const after = await fs.stat(path);
  assert.equal(after.mtimeMs, st.mtimeMs);
  assert.equal(after.size, st.size);
  assert.notEqual(after.ctimeMs, st.ctimeMs);
  assert.equal(hashText(Buffer.from(text).subarray(0, 65536)), hashText(Buffer.from(replacement).subarray(0, 65536)));
  return after;
}
async function noPublishedAnchors(path) {
  flushReadRangeIndexesSync();
  assert.equal(existsSync(rowFile(path)), false, 'unfinished/unstable drafts must not reach disk');
  const index = await getReadRangeIndex(path, await fs.stat(path));
  assert.deepEqual([...index.anchors], [[0, 0]], 'a subsequent lookup must start from byte zero');
  assert.equal(index.totalLines, undefined);
}

for (const route of ['range', 'source']) {
  test(`${route}: a same-size suffix newline rewrite invalidates anchors even with a restored mtime`, async () => {
    const { path, st } = await fixture();
    if (route === 'range') await streamReadRange(path, 9000, 1, st);
    else await readSourceWindows(path, [{ start: 9001, end: 9001 }]);
    await rewriteSuffix(path, st);
    if (route === 'range') {
      // Deliberately supply both the old stat and the old inspection prefix.
      const result = await streamReadRange(path, 9000, 1, st, { prefixBuffer: Buffer.from(text).subarray(0, 65536) });
      assert.equal(first(result), renderReadLine(9001, rows[9001]));
    } else {
      assert.equal((await readSourceWindows(path, [{ start: 9001, end: 9001 }])).get(9001), rows[9001]);
    }
  });
}

test('disk reload rejects a suffix rewrite outside the prefix hash', async (t) => {
  const { path, st } = await fixture();
  await streamReadRange(path, 9000, 1, st);
  flushReadRangeIndexesSync();
  const stored = JSON.parse(await fs.readFile(rowFile(path), 'utf8'));
  assert.equal(stored.version, 2);
  assert.deepEqual(stored.fileVersion, fileVersion(st));
  await rewriteSuffix(path, st);
  const fresh = await import(`./read-range-index.mjs?disk-suffix-${sequence++}`);
  const index = await fresh.getReadRangeIndex(path, st, await borrowed(t, path));
  assert.deepEqual([...index.anchors], [[0, 0]]);
});

test('version-1 rows are ignored, not relabelled with current file identity', async () => {
  const { path, st } = await fixture();
  await fs.mkdir(join(root, 'data', 'read-range-index'), { recursive: true });
  await fs.writeFile(
    rowFile(path),
    JSON.stringify({
      version: 1,
      path,
      size: st.size,
      mtimeMs: st.mtimeMs,
      prefixHash: hashText(Buffer.from(text).subarray(0, 65536)),
      anchors: [
        [0, 0],
        [8192, 0],
      ],
      totalLines: 99,
    })
  );
  assert.equal(first(await streamReadRange(path, 9000, 1, st)), renderReadLine(9001, rows[9000]));
  flushReadRangeIndexesSync();
  const stored = JSON.parse(await fs.readFile(rowFile(path), 'utf8'));
  assert.equal(stored.version, 2);
  assert.deepEqual(stored.fileVersion, fileVersion(st));
  assert.equal(stored.totalLines, undefined);
  assert.ok(stored.anchors.find(([line, byte]) => line === 8192 && byte > 0));
});

for (const location of ['memory', 'disk']) {
  for (const field of ['mtimeMs', 'ctimeMs', 'size', 'ino', 'dev']) {
    test(`${location}: every exact version field matters (${field})`, async (t) => {
      const { path, st } = await fixture();
      await streamReadRange(path, 9000, 1, st);
      flushReadRangeIndexesSync();
      const reader = location === 'memory' ? indexes : await import(`./read-range-index.mjs?version-${sequence++}`);
      const handle = await borrowed(t, path);
      // Only the file-handle stat is perturbed; real bytes and disk rows remain.
      t.mock.method(handle, 'stat', async () => changed(st, field));
      const index = await reader.getReadRangeIndex(path, st, handle);
      assert.deepEqual([...index.anchors], [[0, 0]]);
      assert.equal(index.totalLines, undefined);
    });
  }
}

for (const invalid of [undefined, NaN, Infinity]) {
  test(`incomplete/non-finite handle evidence (${String(invalid)}) cannot reuse or publish`, async (t) => {
    const { path, st } = await fixture();
    await streamReadRange(path, 9000, 1, st);
    const handle = await borrowed(t, path);
    t.mock.method(handle, 'stat', async () =>
      Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: invalid })
    );
    assert.equal(await getReadRangeIndex(path, st, handle), null);
  });
}

for (const route of ['range', 'count', 'source']) {
  test(`${route}: a change after fresh IO preserves the call but publishes no anchors or count`, async (t) => {
    const { path, st } = await fixture();
    const open = fs.open;
    const restore = mockFs(t, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (file === path) {
        const read = handle.read.bind(handle);
        const stat = handle.stat.bind(handle);
        let readBody = false;
        handle.read = async (...args) => {
          const result = await read(...args);
          readBody = true;
          return result;
        };
        handle.stat = async () => {
          const live = await stat();
          return readBody ? changed(live, 'ctimeMs') : live;
        };
      }
      return handle;
    });
    if (route === 'range')
      assert.equal(first(await streamReadRange(path, 9000, 1, st)), renderReadLine(9001, rows[9000]));
    if (route === 'count') assert.equal(await countLogicalLinesBytesSync(path, st.size, st), rows.length);
    if (route === 'source')
      assert.equal((await readSourceWindows(path, [{ start: 9001, end: 9001 }])).get(9001), rows[9000]);
    restore();
    await noPublishedAnchors(path);
  });
}

for (const boundary of ['handle', 'path']) {
  test(`failed post-read ${boundary} stat is not permission to publish`, async (t) => {
    const { path, st } = await fixture();
    const handle = await borrowed(t, path);
    const read = handle.read.bind(handle);
    const stat = handle.stat.bind(handle);
    let readBody = false;
    t.mock.method(handle, 'read', async (...args) => {
      const result = await read(...args);
      readBody = true;
      return result;
    });
    const failure = Object.assign(new Error('injected post-stat error'), { code: 'EIO' });
    let restore = () => {};
    if (boundary === 'handle')
      t.mock.method(handle, 'stat', async () => {
        if (readBody) throw failure;
        return stat();
      });
    else {
      const pathStat = fs.stat;
      restore = mockFs(t, 'stat', (file, ...args) =>
        file === path && readBody ? Promise.reject(failure) : pathStat(file, ...args)
      );
    }
    assert.equal(
      first(await streamReadRange(path, 9000, 1, st, { fileHandle: handle })),
      renderReadLine(9001, rows[9000])
    );
    restore();
    await noPublishedAnchors(path);
  });
}

test('a replacement path cannot certify offsets from the old borrowed handle', async (t) => {
  // Retarget a directory alias while its old file remains open. Unlike
  // rename-over-open-file, this exercises real replacement on Windows too.
  const directory = join(root, `replacement-${sequence++}`);
  const original = join(directory, 'original');
  const replacement = join(directory, 'replacement');
  const alias = join(directory, 'current');
  await fs.mkdir(original, { recursive: true });
  await fs.mkdir(replacement);
  await fs.writeFile(join(original, 'file.txt'), text);
  await fs.writeFile(join(replacement, 'file.txt'), text.replace('row-00000', 'new-00000'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(original, alias, linkType);
  const path = join(alias, 'file.txt');
  const st = await fs.stat(path);
  const handle = await borrowed(t, path);
  const read = handle.read.bind(handle);
  let replaced = false;
  t.mock.method(handle, 'read', async (...args) => {
    const result = await read(...args);
    if (!replaced) {
      replaced = true;
      await fs.unlink(alias);
      await fs.symlink(replacement, alias, linkType);
    }
    return result;
  });
  // Hold the descriptor evidence stable to isolate the required path check.
  t.mock.method(handle, 'stat', async () => st);
  assert.equal(
    first(await streamReadRange(path, 9000, 1, st, { fileHandle: handle })),
    renderReadLine(9001, rows[9000])
  );
  await noPublishedAnchors(path);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('partial anchors stay private while a scan waits, then a failed read publishes nothing', {
  timeout: 5000,
}, async (t) => {
  const { path, st } = await fixture();
  const handle = await borrowed(t, path);
  const read = handle.read.bind(handle);
  const entered = deferred();
  const release = deferred();
  t.after(release.resolve);
  let calls = 0;
  const failure = new Error('injected third-read failure');
  t.mock.method(handle, 'read', async (...args) => {
    if (++calls === 3) {
      entered.resolve();
      await release.promise;
      throw failure;
    }
    return read(...args);
  });
  const reading = streamReadRange(path, 9000, 1, st, { fileHandle: handle });
  const rejection = assert.rejects(reading, (error) => error === failure);
  try {
    await entered.promise; // the first two data chunks crossed the 4096 anchor
    await noPublishedAnchors(path);
  } finally {
    release.resolve();
  }
  await rejection;
  await noPublishedAnchors(path);
  assert.ok((await handle.stat()).isFile(), 'borrowed handles are still owned by the caller');
});

test('invalidation during a scan prevents its late completion from publishing', { timeout: 5000 }, async (t) => {
  const { path, st } = await fixture();
  const handle = await borrowed(t, path);
  const read = handle.read.bind(handle);
  const entered = deferred();
  const release = deferred();
  t.after(release.resolve);
  t.mock.method(handle, 'read', async (...args) => {
    const result = await read(...args);
    entered.resolve();
    await release.promise;
    return result;
  });
  const reading = streamReadRange(path, 9000, 1, st, { fileHandle: handle });
  try {
    await entered.promise;
    deleteReadRangeIndexForPath(path);
  } finally {
    release.resolve();
  }
  assert.equal(first(await reading), renderReadLine(9001, rows[9000]));
  await noPublishedAnchors(path);
});

test('a delayed disk lookup cannot resurrect an invalidated slot', { timeout: 5000 }, async (t) => {
  const { path, st } = await fixture();
  await streamReadRange(path, 9000, 1, st);
  flushReadRangeIndexesSync();
  const fresh = await import(`./read-range-index.mjs?late-load-${sequence++}`);
  const read = fs.readFile;
  const entered = deferred();
  const release = deferred();
  t.after(release.resolve);
  const restore = mockFs(t, 'readFile', async (file, ...args) => {
    const data = await read(file, ...args);
    if (file === rowFile(path)) {
      entered.resolve();
      await release.promise;
    }
    return data;
  });
  const loading = fresh.getReadRangeIndex(path, st, await borrowed(t, path));
  try {
    await entered.promise;
    fresh.deleteReadRangeIndexForPath(path);
  } finally {
    release.resolve();
  }
  assert.equal(await loading, null);
  restore();
});

test('concurrent same-version drafts merge only on success and never alias shared anchors', async (t) => {
  const { path, st } = await fixture();
  const handle = await borrowed(t, path);
  const a = await getReadRangeIndex(path, st, handle);
  const b = await getReadRangeIndex(path, st, handle);
  assert.notEqual(a.anchors, b.anchors);
  const width = Buffer.byteLength(`${rows[0]}\n`);
  maybeRecordReadRangeAnchor(a, 4096, 4096 * width);
  maybeRecordReadRangeAnchor(b, 8192, 8192 * width);
  assert.equal(await publishReadRangeIndex(a, handle), true);
  assert.equal(await publishReadRangeIndex(b, handle), true);
  a.anchors.set(4096, 0);
  const current = await getReadRangeIndex(path, st, handle);
  assert.equal(current.anchors.get(4096), 4096 * width);
  assert.equal(current.anchors.get(8192), 8192 * width);
  assert.equal(await publishReadRangeIndex(a, handle), false, 'a draft is single-use');
});

test('capacity eviction detaches old builders and their pending disk publication', async (t) => {
  const { path, st } = await fixture();
  const handle = await borrowed(t, path);
  const old = await getReadRangeIndex(path, st, handle);
  maybeRecordReadRangeAnchor(old, 4096, 4096 * Buffer.byteLength(`${rows[0]}\n`));
  for (let i = 0; i < 65; i++) {
    const next = await fixture('x\n');
    await getReadRangeIndex(next.path, next.st);
  }
  assert.equal(await publishReadRangeIndex(old, handle), false);
  await noPublishedAnchors(path);
});

for (const changedBeforeSave of [false, true]) {
  test(`eviction saves only a still-valid published snapshot (changed: ${changedBeforeSave})`, {
    timeout: 5000,
  }, async (t) => {
    flushReadRangeIndexesSync();
    // Keep the 750ms debounce pending regardless of machine speed. All other
    // IO is real; the eviction write is observed at its filesystem boundary.
    const setTimer = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
      const timer = setTimer(callback, ms, ...args);
      if (ms === 750) clearTimeout(timer);
      return timer;
    });
    const { path, st } = await fixture();
    await countLogicalLinesBytesSync(path, st.size, st);
    const handle = await borrowed(t, path);
    const unfinished = await getReadRangeIndex(path, st, handle);
    unfinished.totalLines = 1;
    unfinished.anchors.set(8192, 0);
    assert.equal(existsSync(rowFile(path)), false);

    const checked = deferred();
    const saved = deferred();
    const release = deferred();
    const settled = deferred();
    t.after(release.resolve);
    let diskPreparations = 0;
    const mkdir = fs.mkdir;
    mockFs(t, 'mkdir', (directory, ...args) => {
      if (directory === join(root, 'data', 'read-range-index')) diskPreparations++;
      return mkdir(directory, ...args);
    });
    const pathStat = fs.stat;
    mockFs(t, 'stat', async (file, ...args) => {
      if (file !== path) return pathStat(file, ...args);
      checked.resolve();
      await release.promise;
      try {
        const live = await pathStat(file, ...args);
        return changedBeforeSave ? changed(live, 'ino') : live;
      } finally {
        settled.resolve();
      }
    });
    const rename = fs.rename;
    mockFs(t, 'rename', async (from, to, ...args) => {
      const result = await rename(from, to, ...args);
      if (to === rowFile(path)) saved.resolve();
      return result;
    });
    for (let i = 0; i < 64; i++) {
      const next = await fixture('x\n');
      await getReadRangeIndex(next.path, next.st);
    }
    // Foreground lookups completed while the eviction's stat remains blocked.
    const timeout = new AbortController();
    const deadline = delay(2000, null, { signal: timeout.signal }).then(() => {
      assert.fail('eviction did not attempt to persist the published snapshot');
    });
    try {
      await Promise.race([checked.promise, deadline]);
      assert.equal(await publishReadRangeIndex(unfinished, handle), false);
      release.resolve();
      await settled.promise;
      if (changedBeforeSave) {
        // Drain the stat continuation and check that even preparing the disk
        // write was rejected, not merely that its rename has yet to finish.
        await nextTurn();
        assert.equal(diskPreparations, 0);
        assert.equal(existsSync(rowFile(path)), false);
      } else {
        await Promise.race([saved.promise, deadline]);
        const stored = JSON.parse(await fs.readFile(rowFile(path), 'utf8'));
        assert.equal(stored.totalLines, rows.length);
        assert.deepEqual(stored.fileVersion, fileVersion(st));
        const loaded = await getReadRangeIndex(path, st, handle);
        assert.equal(loaded.anchors.get(8192), 8192 * Buffer.byteLength(`${rows[0]}\n`));
        assert.equal(loaded.totalLines, rows.length);
      }
    } finally {
      release.resolve();
      timeout.abort();
      await deadline.catch(() => {});
    }
  });
}

test('cancellation while the final stat waits denies publication', { timeout: 5000 }, async (t) => {
  const { path, st } = await fixture();
  const handle = await borrowed(t, path);
  const index = await getReadRangeIndex(path, st, handle);
  const control = new AbortController();
  const entered = deferred();
  const release = deferred();
  t.after(release.resolve);
  const stat = handle.stat.bind(handle);
  t.mock.method(handle, 'stat', async () => {
    entered.resolve();
    await release.promise;
    return stat();
  });
  const publishing = publishReadRangeIndex(index, handle, control.signal);
  try {
    await entered.promise;
    control.abort();
  } finally {
    release.resolve();
  }
  assert.equal(await publishing, false);
  await noPublishedAnchors(path);
});

test('counting with a stale size hint never stores a partial total as the full count', async () => {
  const { path, st } = await fixture();
  assert.equal(await countLogicalLinesBytesSync(path, st.size / 2, st), rows.length / 2);
  await noPublishedAnchors(path);
  assert.equal(await countLogicalLinesBytesSync(path, st.size, st), rows.length);
  flushReadRangeIndexesSync();
  assert.equal(JSON.parse(await fs.readFile(rowFile(path), 'utf8')).totalLines, rows.length);
});

test('unchanged inspection prefixes avoid extra data IO and preserve borrowed position', async (t) => {
  const { path, st } = await fixture();
  const handle = await borrowed(t, path);
  const read = handle.read.bind(handle);
  let reads = 0;
  t.mock.method(handle, 'read', async (...args) => {
    reads++;
    return read(...args);
  });
  const hooks = { fileHandle: handle, prefixBuffer: Buffer.from(text).subarray(0, 65536) };
  await streamReadRange(path, 0, 2, st, hooks);
  const result = await streamReadRange(path, 0, 2, st, hooks);
  assert.equal(first(result), renderReadLine(1, rows[0]));
  assert.equal(reads, 0, 'the already inspected prefix covers both windows and hash checks');
  await getReadRangeIndex(path, st, handle); // real positional prefix validation
  const byte = Buffer.alloc(1);
  await handle.read(byte, 0, 1, null);
  assert.equal(byte.toString(), 'r', 'index validation must not advance the handle position');
});

test('stable deep windows reuse published anchors instead of rescanning from zero', async (t) => {
  const { path, st } = await fixture();
  await streamReadRange(path, 9000, 1, st);
  const handle = await borrowed(t, path);
  const read = handle.read.bind(handle);
  let bytes = 0;
  let trace;
  t.mock.method(handle, 'read', async (...args) => {
    const result = await read(...args);
    bytes += result.bytesRead;
    return result;
  });
  const result = await streamReadRange(path, 9000, 1, st, {
    fileHandle: handle,
    ioTraceDone: (_event, _start, detail) => {
      trace = detail;
    },
  });
  assert.equal(first(result), renderReadLine(9001, rows[9000]));
  assert.equal(trace.anchorLine, 8192);
  assert.ok(bytes <= 128 * 1024, `warm range read consumed ${bytes} bytes`);
});

test('an unverified extension cannot mutate an already published same-version index', async (t) => {
  const { path, st } = await fixture();
  await streamReadRange(path, 5000, 1, st);
  const handle = await borrowed(t, path);
  const stat = handle.stat.bind(handle);
  const read = handle.read.bind(handle);
  let bodyRead = false;
  t.mock.method(handle, 'read', async (...args) => {
    const result = await read(...args);
    bodyRead = true;
    return result;
  });
  t.mock.method(handle, 'stat', async () => {
    const live = await stat();
    return bodyRead ? changed(live, 'ino') : live;
  });
  await streamReadRange(path, 10000, 1, st, { fileHandle: handle, prefixBuffer: Buffer.from(text).subarray(0, 65536) });
  const current = await getReadRangeIndex(path, st);
  assert.ok(current.anchors.has(4096));
  assert.equal(current.anchors.has(8192), false, 'the rejected scan must not extend shared anchors');
});

test('a stale inspection prefix is not read as the current first lines', async () => {
  const { path, st } = await fixture();
  await delay(20);
  await fs.writeFile(path, text.replace('row-00000', 'NEW-00000'));
  await fs.utimes(path, time, time);
  assert.notEqual((await fs.stat(path)).ctimeMs, st.ctimeMs);
  const result = await streamReadRange(path, 0, 1, st, { prefixBuffer: Buffer.from(text).subarray(0, 65536) });
  assert.equal(first(result), renderReadLine(1, rows[0].replace('row-', 'NEW-')));
});

test('failed pre-stat leaves the current read usable but disables index reuse/publication', async (t) => {
  const { path, st } = await fixture();
  const handle = await borrowed(t, path);
  t.mock.method(handle, 'stat', async () => {
    throw Object.assign(new Error('pre-stat error'), { code: 'EIO' });
  });
  assert.equal(
    first(await streamReadRange(path, 9000, 1, st, { fileHandle: handle })),
    renderReadLine(9001, rows[9000])
  );
  await noPublishedAnchors(path);
});

test('post-read checks use an owned version, not a mutable Stats instance', async (t) => {
  const { path, st } = await fixture();
  const handle = await borrowed(t, path);
  const read = handle.read.bind(handle);
  t.mock.method(handle, 'stat', async () => st);
  let once = false;
  t.mock.method(handle, 'read', async (...args) => {
    const result = await read(...args);
    if (!once) {
      once = true;
      st.ctimeMs += 1;
    }
    return result;
  });
  assert.equal(
    first(await streamReadRange(path, 9000, 1, st, { fileHandle: handle })),
    renderReadLine(9001, rows[9000])
  );
  await noPublishedAnchors(path);
});
