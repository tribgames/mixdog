import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { POLL_CONCURRENCY, createWatchedFileCache, fileStamp, fileStampSync } from './watched-file-cache.mjs';
import { eventually, settle, trackWatchers } from './watched-file-cache.test-helpers.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-watched-cache-'));
  const cache = createWatchedFileCache({
    load: (path) => ({ value: readFileSync(path, 'utf8') }),
    loadAsync: async (path) => ({ value: await fsp.readFile(path, 'utf8') }),
  });
  t.after(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const file = (name, text) => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  };
  return { dir, cache, file };
}

test('a directory watch is shared by its entries and closes with the last of them', (t) => {
  const watching = trackWatchers(t);
  const { dir, cache, file } = fixture(t);
  const a = file('a.json', 'A');
  const b = file('b.json', 'B');
  assert.equal(cache.get(a), 'A');
  cache.set(b, 'B2');
  const both = [dir, dirname(dir)].sort();
  assert.deepEqual(watching(), both, 'one watcher for the directory and one for its parent');
  cache.delete(a);
  assert.deepEqual(watching(), both, 'still held by the other entry');
  cache.delete(b);
  assert.deepEqual(watching(), [], 'released with its last entry');
});

const textCache = (t) => {
  const cache = createWatchedFileCache({
    load: (path) => ({ value: readFileSync(path, 'utf8') }),
    loadAsync: async (path) => ({ value: await fsp.readFile(path, 'utf8') }),
  });
  t.after(() => cache.close());
  return cache;
};

test('every cache with files in one directory shares the one watch of it and of its parent', (t) => {
  const watching = trackWatchers(t);
  const { dir, cache, file } = fixture(t);
  const second = textCache(t);
  const third = textCache(t);
  const a = file('a.json', 'A');
  const b = file('b.json', 'B');
  cache.get(a);
  second.get(b);
  third.get(a);
  third.set(b, 'B');
  const both = [dir, dirname(dir)].sort();
  assert.deepEqual(watching(), both, 'three caches, four entries: one watch per directory');
  cache.close();
  second.close();
  assert.deepEqual(watching(), both, 'still held by the third cache');
  third.close();
  assert.deepEqual(watching(), [], 'released with the last holder');
});

// A cache whose missing file reads as null.
const nullableCache = (t) => {
  const cache = createWatchedFileCache({
    load: (path) => {
      try {
        return { value: readFileSync(path, 'utf8') };
      } catch (error) {
        if (error?.code === 'ENOENT') return { value: null };
        throw error;
      }
    },
  });
  t.after(() => cache.close());
  return cache;
};

test('a file under a missing directory is followed through its nearest existing ancestor and that one’s parent', async (t) => {
  const watching = trackWatchers(t);
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-watched-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = nullableCache(t);
  const own = join(dir, 'a', 'b');
  const path = join(own, 'record.json');
  assert.equal(cache.get(path), null);
  assert.deepEqual(
    watching(),
    [dirname(dir), dir].sort(),
    'the nearest existing ancestor and its parent, nothing above'
  );
  mkdirSync(own, { recursive: true });
  writeFileSync(path, 'there');
  await eventually(() => cache.peek(path) === 'there', { timeoutMs: 3_000 });
  assert.deepEqual(watching(), [join(dir, 'a'), own].sort(), 'its own directory and its parent; the wait released');
});

test('the ancestor a missing file waits on, renamed away and recreated with that file, is read afresh', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-watched-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = nullableCache(t);
  const ancestor = join(root, 'anc');
  mkdirSync(ancestor);
  const path = join(ancestor, 'missing', 'record.json');
  assert.equal(cache.get(path), null);
  // The waiting watch follows the moved folder; only its parent sees the swap.
  renameSync(ancestor, join(root, 'moved'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'new');
  await eventually(() => cache.get(path) === 'new', { timeoutMs: 3_000 });
});

test('changes reach every cache sharing a watch: in-place writes, atomic replaces and a replaced directory', async (t) => {
  const opened = recordWatches(t);
  const one = noticing(t);
  const two = noticing(t);
  const sub = join(one.dir, 'sub');
  mkdirSync(sub);
  const a = join(sub, 'a.json');
  const b = join(sub, 'b.json');
  writeFileSync(a, 'a1');
  writeFileSync(b, 'b1');
  one.cache.get(a);
  two.cache.get(a);
  two.cache.get(b);
  const live = () =>
    opened
      .filter((entry) => !entry.closed)
      .map((entry) => entry.dir)
      .sort();
  const single = [one.dir, sub].sort();
  assert.deepEqual(live(), single, 'one watch of the folder and one of its parent for both caches');
  const seen = (path, value) =>
    [one, two].every(({ cache }) => cache.peek(path) === undefined || cache.peek(path) === value);

  writeFileSync(a, 'a2');
  await eventually(() => seen(a, 'a2'));

  writeFileSync(`${b}.tmp`, 'b2');
  renameSync(`${b}.tmp`, b);
  await eventually(() => two.cache.peek(b) === 'b2');

  renameSync(sub, join(one.dir, 'moved'));
  mkdirSync(sub);
  writeFileSync(a, 'a3');
  writeFileSync(b, 'b3');
  await eventually(() => seen(a, 'a3') && two.cache.peek(b) === 'b3');
  await eventually(() => live().join() === single.join());

  // Watched again, on the live folder, by both.
  writeFileSync(a, 'a4');
  await eventually(() => seen(a, 'a4'));
  assert.deepEqual(live(), single);
});

// `reads.sync`/`reads.async` count loads; `reads.beforeSync(path)` may fail a
// synchronous one, `reads.before(path)` hold or fail an async one.
function noticing(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-watched-cache-'));
  const changes = [];
  const waiting = [];
  // Resolves with the next announced path; rejects at one deadline.
  const nextChange = (timeoutMs = 5_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no change announced')), timeoutMs);
      waiting.push((path) => {
        clearTimeout(timer);
        resolve(path);
      });
    });
  const reads = { sync: 0, async: 0, beforeSync: () => {}, before: async () => {} };
  const cache = createWatchedFileCache(
    {
      load: (path) => {
        reads.sync += 1;
        reads.beforeSync(path);
        return { value: readFileSync(path, 'utf8') };
      },
      loadAsync: async (path) => {
        reads.async += 1;
        await reads.before(path);
        return { value: await fsp.readFile(path, 'utf8') };
      },
    },
    {
      onChange: (path) => {
        changes.push(path);
        for (const wake of waiting.splice(0)) wake(path);
      },
    }
  );
  t.after(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, cache, changes, reads, nextChange };
}

test('a changed value is reported, whoever wrote it; our own write reads back as no change', async (t) => {
  const { dir, cache, changes } = noticing(t);
  const path = join(dir, 'record.json');
  writeFileSync(path, 'loaded');
  assert.equal(cache.get(path), 'loaded');
  writeFileSync(path, 'own write');
  cache.set(path, 'own write');
  await settle(300);
  assert.deepEqual(changes, [], 'an equal re-read changes nothing');
  writeFileSync(path, 'external write');
  await eventually(() => changes.length > 0, { timeoutMs: 2_000 });
  assert.deepEqual([...new Set(changes)], [path]);
  assert.equal(cache.get(path), 'external write');
});

test('a failed re-read keeps the last value, tells nobody and reads no disk; the next event reads again', async (t) => {
  const { dir, cache, changes, reads } = noticing(t);
  const path = join(dir, 'record.json');
  writeFileSync(path, 'kept');
  assert.equal(cache.get(path), 'kept');
  reads.before = async () => {
    throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
  };
  writeFileSync(path, 'unread');
  await eventually(() => reads.async > 0, { timeoutMs: 2_000 });
  await settle(100);
  const sync = reads.sync;
  assert.equal(cache.get(path), 'kept');
  assert.equal(reads.sync, sync, 'no synchronous retry');
  assert.deepEqual(changes, []);
  reads.before = async () => {};
  writeFileSync(path, 'next');
  await eventually(() => cache.peek(path) === 'next', { timeoutMs: 2_000 });
  assert.deepEqual([...new Set(changes)], [path]);
});

test('a first read that failed is answered from memory; the next read re-reads it off the loop', async (t) => {
  const { dir, cache, changes, reads } = noticing(t);
  const path = join(dir, 'busy.json');
  writeFileSync(path, 'there');
  reads.beforeSync = () => {
    throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
  };
  assert.throws(() => cache.get(path), { code: 'EBUSY' });
  reads.beforeSync = () => {};
  // No event comes (the file does not change): the read itself asks again.
  assert.throws(() => cache.get(path), { code: 'EBUSY' }, 'answered from memory now');
  await eventually(() => {
    try {
      return cache.get(path) === 'there';
    } catch {
      return false;
    }
  });
  assert.equal(reads.sync, 1, 'never retried synchronously');
  assert.equal(reads.async, 1, 'the reads meanwhile joined one re-read');
  assert.deepEqual(changes, [path]);
});

test('a stat that fails for any reason but absence rejects, as the sync stamp throws; it is never a stamp', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-watched-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'file');
  writeFileSync(path, 'x');
  assert.match(await fileStamp(path), /^\d+:\d+:1:/);
  assert.equal(await fileStamp(join(dir, 'absent')), 'missing');
  assert.equal(await fileStamp(join(path, 'below-a-file')), 'missing');
  for (const code of ['EACCES', 'EPERM', 'EBUSY', 'EIO']) {
    const failure = Object.assign(new Error(`${code}: stat denied`), { code });
    t.mock.method(fsp, 'stat', async () => {
      throw failure;
    });
    t.mock.method(fs, 'statSync', () => {
      throw failure;
    });
    await assert.rejects(fileStamp(path), failure, `async ${code}`);
    assert.throws(() => fileStampSync(path), failure, `sync ${code}`);
    t.mock.restoreAll();
  }
});

// Real-time wait that keeps working while setTimeout is mocked.
async function until(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("our write landing before another writer's reported change is read leaves that change to be read", async (t) => {
  const original = fs.watch;
  let events = 0;
  t.mock.method(fs, 'watch', (dir, options, listener) =>
    original(dir, options, (...args) => {
      events += 1;
      listener(...args);
    })
  );
  // The re-read debounce holds until ticked: the event is received, its re-read not yet run.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { dir, cache, changes } = noticing(t);
  const path = join(dir, 'record.json');
  writeFileSync(path, 'loaded');
  assert.equal(cache.get(path), 'loaded');
  writeFileSync(path, 'foreign');
  await until(() => events > 0);
  cache.set(path, 'own');
  t.mock.timers.tick(1_000);
  await until(() => cache.peek(path) === 'foreign');
  assert.deepEqual([...new Set(changes)], [path]);
});

test('re-reads after a burst of changes run a few at a time', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-watched-cache-'));
  let inFlight = 0;
  let peak = 0;
  const cache = createWatchedFileCache({
    load: (path) => ({ value: readFileSync(path, 'utf8') }),
    loadAsync: async (path) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await settle(10);
      inFlight -= 1;
      return { value: await fsp.readFile(path, 'utf8') };
    },
  });
  t.after(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const paths = Array.from({ length: POLL_CONCURRENCY * 3 }, (_, i) => join(dir, `f${i}.json`));
  for (const path of paths) {
    writeFileSync(path, 'v1');
    cache.get(path);
  }
  for (const path of paths) writeFileSync(path, 'v2');
  await eventually(() => paths.every((path) => cache.peek(path) === 'v2'), { timeoutMs: 5_000 });
  assert.ok(peak <= POLL_CONCURRENCY, `at most ${POLL_CONCURRENCY} re-reads at once, saw ${peak}`);
});

test('forgetting a cached file tells its observer', (t) => {
  const { dir, cache, changes } = noticing(t);
  const path = join(dir, 'record.json');
  writeFileSync(path, 'loaded');
  cache.get(path);
  rmSync(path);
  cache.delete(path);
  assert.deepEqual(changes, [path]);
  assert.equal(cache.peek(path), undefined);
});

test('a directory that cannot be watched waits on its parent and is watched again once it is recreated', async (t) => {
  const original = fs.watch;
  let refuse = true;
  const attempts = [];
  t.mock.method(fs, 'watch', (target, ...rest) => {
    if (String(target).endsWith('unwatchable')) {
      attempts.push(String(target));
      if (refuse) throw Object.assign(new Error('no watch'), { code: 'ENOSYS' });
    }
    return original(target, ...rest);
  });
  t.mock.method(process.stderr, 'write', () => true);
  t.mock.method(globalThis, 'setInterval', () => assert.fail('nothing polls'));
  const { dir, cache, changes } = noticing(t);
  const sub = join(dir, 'unwatchable');
  mkdirSync(sub);
  const path = join(sub, 'record.json');
  writeFileSync(path, 'v1');
  assert.equal(cache.get(path), 'v1');
  assert.equal(attempts.length, 1, 'the failed watch is not retried on its own');
  assert.ok(
    process.stderr.write.mock.calls.some(({ arguments: [line] }) => String(line).includes(sub)),
    'the failure is logged'
  );
  // The directory is replaced: its parent's event names it.
  refuse = false;
  rmSync(sub, { recursive: true, force: true });
  mkdirSync(sub);
  writeFileSync(path, 'v2');
  await eventually(() => cache.peek(path) === 'v2', { timeoutMs: 3_000 });
  assert.ok(attempts.length > 1, 'the watch was tried again on that event');
  changes.length = 0;
  writeFileSync(path, 'v3');
  await eventually(() => cache.peek(path) === 'v3', { timeoutMs: 3_000 });
  assert.deepEqual([...new Set(changes)], [path], 'its own watch now reports changes');
});

test('a watcher that errors is closed; its entries wait on the parent and re-read on demand until it names the directory', async (t) => {
  const original = fs.watch;
  const opened = [];
  t.mock.method(fs, 'watch', (target, ...rest) => {
    const watcher = original(target, ...rest);
    opened.push({ dir: String(target), watcher });
    return watcher;
  });
  t.mock.method(process.stderr, 'write', () => true);
  const { dir, cache, changes } = noticing(t);
  const sub = join(dir, 'sub');
  mkdirSync(sub);
  const path = join(sub, 'record.json');
  writeFileSync(path, 'before');
  assert.equal(cache.get(path), 'before');
  assert.deepEqual(
    opened.map((entry) => entry.dir),
    [sub, dir],
    'the directory and its parent'
  );
  opened[0].watcher.emit('error', new Error('watch lost'));
  assert.deepEqual(
    opened.map((entry) => entry.dir),
    [sub, dir, dirname(dir)],
    "the parent's watch, already open, is the fallback and now follows its own parent; the failed directory is not reopened"
  );
  writeFileSync(path, 'during');
  // Unseen by any watch: the read is what asks for it.
  await eventually(() => cache.get(path) === 'during');
  assert.deepEqual([...new Set(changes)], [path]);
  // The directory is recreated: the parent's event names it, and its watch is tried again.
  rmSync(sub, { recursive: true, force: true });
  mkdirSync(sub);
  writeFileSync(path, 'after');
  await eventually(() => cache.peek(path) === 'after');
  assert.ok(
    opened.slice(3).some((entry) => entry.dir === sub),
    'watched again once its parent named it'
  );
});

// `fs.watch` handles opened through the cache, in order, with their directory.
function recordWatches(t) {
  const original = fs.watch;
  const opened = [];
  t.mock.method(fs, 'watch', (target, ...rest) => {
    const watcher = original(target, ...rest);
    const record = { dir: String(target), watcher, closed: false };
    record.closing = new Promise((resolve) => {
      watcher.once('close', () => {
        record.closed = true;
        resolve();
      });
    });
    opened.push(record);
    return watcher;
  });
  return opened;
}

test('a folder renamed and recreated under a live watch is read afresh, announced and watched again', async (t) => {
  const opened = recordWatches(t);
  const { dir, cache, nextChange } = noticing(t);
  const sub = join(dir, 'sub');
  mkdirSync(sub);
  const path = join(sub, 'record.json');
  writeFileSync(path, 'old');
  assert.equal(cache.get(path), 'old');
  const oldFolderWatch = opened.find((entry) => entry.dir === sub);

  // The folder's watch follows the moved folder; only the parent sees the swap.
  const announced = nextChange();
  renameSync(sub, join(dir, 'moved'));
  mkdirSync(sub);
  writeFileSync(path, 'new');
  assert.equal(await announced, path, 'the change was announced');
  assert.equal(cache.peek(path), 'new');
  await oldFolderWatch.closing;
  // One watch on the folder and one on its parent: two handles for the folder.
  const live = opened.filter((entry) => !entry.closed);
  assert.deepEqual(live.map((entry) => entry.dir).sort(), [dir, sub].sort(), 'the watch moved to the live folder');

  // Watched again: a plain write in the live folder is seen.
  const again = nextChange();
  writeFileSync(path, 'newer');
  assert.equal(await again, path);
  assert.equal(cache.peek(path), 'newer');
});

test('a folder deleted and recreated under a live watch is read afresh', async (t) => {
  const { dir, cache, nextChange } = noticing(t);
  const sub = join(dir, 'sub');
  mkdirSync(sub);
  const path = join(sub, 'record.json');
  writeFileSync(path, 'old');
  assert.equal(cache.get(path), 'old');
  const announced = nextChange();
  rmSync(sub, { recursive: true, force: true });
  mkdirSync(sub);
  writeFileSync(path, 'new');
  assert.equal(await announced, path);
  assert.equal(cache.peek(path), 'new');
});

test('writes inside a watched folder do not re-arm its watch', async (t) => {
  const opened = recordWatches(t);
  const { dir, cache, nextChange } = noticing(t);
  const sub = join(dir, 'sub');
  mkdirSync(sub);
  const path = join(sub, 'record.json');
  writeFileSync(path, 'v0');
  cache.get(path);
  const handles = opened.length;
  for (let i = 1; i <= 5; i += 1) {
    const announced = nextChange();
    writeFileSync(path, `v${i}`);
    await announced;
  }
  assert.equal(opened.length, handles, 'a parent change event is not a replacement');
});

test('a folder watch that closes on its own ends the trust at once', async (t) => {
  const opened = recordWatches(t);
  t.mock.method(process.stderr, 'write', () => true);
  const { dir, cache, nextChange } = noticing(t);
  const sub = join(dir, 'sub');
  mkdirSync(sub);
  const path = join(sub, 'record.json');
  writeFileSync(path, 'before');
  assert.equal(cache.get(path), 'before');
  const announced = nextChange();
  opened.find((entry) => entry.dir === sub).watcher.emit('close');
  // Unseen by any watch: the read is what asks for the re-read.
  writeFileSync(path, 'during');
  cache.get(path);
  assert.equal(await announced, path);
  assert.equal(cache.peek(path), 'during');
});

test('a parent watch that closes or errors ends the trust: a replacement is then read on demand', async (t) => {
  for (const kind of ['close', 'error']) {
    const opened = recordWatches(t);
    t.mock.method(process.stderr, 'write', () => true);
    const { dir, cache, nextChange } = noticing(t);
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    const path = join(sub, 'record.json');
    writeFileSync(path, 'old');
    assert.equal(cache.get(path), 'old');
    const parentWatch = opened.find((entry) => entry.dir === dir).watcher;
    const announced = nextChange();
    if (kind === 'close') parentWatch.emit('close');
    else parentWatch.emit('error', new Error('parent watch lost'));
    renameSync(sub, join(dir, 'moved'));
    mkdirSync(sub);
    writeFileSync(path, 'new');
    assert.equal(await announced, path, kind);
    assert.equal(cache.peek(path), 'new', kind);
    opened.length = 0;
  }
});

test('a write landing while the previous re-read is in flight is observed', async (t) => {
  const { dir, cache, changes, reads } = noticing(t);
  const path = join(dir, 'record.json');
  writeFileSync(path, 'loaded');
  cache.get(path);
  // The re-read that follows our own write is held back ...
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  reads.before = () => {
    reads.before = async () => {};
    return gate;
  };
  writeFileSync(path, 'own write');
  cache.set(path, 'own write');
  await eventually(() => reads.async > 0, { timeoutMs: 2_000 });
  // ... while another writer replaces the file.
  writeFileSync(path, 'foreign write, longer');
  await settle(100);
  release();
  await eventually(() => changes.length > 0, { timeoutMs: 2_000 });
  assert.equal(cache.get(path), 'foreign write, longer');
});

test('the settled seam resolves only once the due re-read has applied its result', async (t) => {
  const { dir, cache, reads } = noticing(t);
  const path = join(dir, 'record.json');
  writeFileSync(path, 'loaded');
  cache.get(path);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let reached;
  const out = new Promise((resolve) => {
    reached = resolve;
  });
  reads.before = () => {
    reads.before = async () => {};
    reached();
    return gate;
  };
  writeFileSync(path, 'external write');
  // Our own write-through schedules the re-read whatever the watch delivers.
  cache.set(path, 'own write');
  let settled = false;
  const done = cache._settledForTest(path).then(() => {
    settled = true;
  });
  await out;
  assert.equal(settled, false, 'a re-read in flight is not settled');
  release();
  await done;
  assert.equal(cache.peek(path), 'external write', 'its result was applied before it settled');
});

test('closing a cache releases its watchers, and later reads leave none behind', (t) => {
  const watching = trackWatchers(t);
  const { cache, file } = fixture(t);
  const a = file('a.json', 'A');
  cache.get(a);
  cache.close();
  assert.deepEqual(watching(), []);
  file('a.json', 'A2');
  assert.equal(cache.get(a), 'A2', 'a closed cache reads the disk');
  assert.deepEqual(watching(), []);
});
