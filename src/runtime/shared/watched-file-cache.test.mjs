import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { POLL_CONCURRENCY, createWatchedFileCache } from './watched-file-cache.mjs';
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
    [sub, dir, dir, dirname(dir)],
    'the parent is watched as the fallback (with its own parent); the failed directory is not reopened'
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
    opened.slice(4).some((entry) => entry.dir === sub),
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
