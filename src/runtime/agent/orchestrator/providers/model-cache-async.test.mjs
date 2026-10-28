import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'model-cache-async-'));
process.env.MIXDOG_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { makeModelCache, flushModelCacheWrites } = await import('./model-cache.mjs');

const onDisk = (cache) => JSON.parse(readFileSync(cache.path(), 'utf8'));

// Slows or fails the async rename that publishes a given file, the one step
// every atomic write ends with.
function mockRename(t, handler) {
  const rename = fsPromises.rename;
  t.mock.method(fsPromises, 'rename', async (from, to, ...rest) => {
    await handler(String(to));
    return rename(from, to, ...rest);
  });
  syncBuiltinESMExports();
  return () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  };
}

test('save is visible at once, reaches disk in the unchanged format, and leaves no lock or temp file', async () => {
  const mirrored = [];
  const cache = makeModelCache({
    fileName: 'format-models.json',
    ttlMs: 60_000,
    version: 3,
    onSave: (models) => mirrored.push(models),
  });
  const models = [{ id: 'a' }];
  const done = cache.save(models, { clientVersion: '1.2.3' });
  assert.deepEqual(mirrored, [models], 'the in-memory mirror updates synchronously');
  assert.deepEqual(cache.loadSync(), models, 'a fresh instance of the same file reads the unsettled save');
  assert.equal(
    makeModelCache({ fileName: 'format-models.json', ttlMs: 60_000, version: 3 }).loadEntrySync().clientVersion,
    '1.2.3'
  );
  await done;
  const record = onDisk(cache);
  assert.deepEqual(Object.keys(record).sort(), ['clientVersion', 'fetchedAt', 'models', 'version']);
  assert.equal(record.version, 3);
  assert.deepEqual(record.models, models);
  assert.deepEqual(cache.loadSync(), models);
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.startsWith('format-models')),
    ['format-models.json']
  );
});

test('a burst of saves and publishes ends with the latest data, in request order', async (t) => {
  const cache = makeModelCache({ fileName: 'ordered-models.json', ttlMs: 60_000 });
  const landed = [];
  // The first write is slow: later ones must wait for it, not overtake it.
  const restore = mockRename(t, async (to) => {
    if (!to.endsWith('ordered-models.json')) return;
    landed.push(to);
    if (landed.length === 1) await new Promise((resolve) => setTimeout(resolve, 120));
  });
  try {
    cache.save([{ id: 'save-0' }]);
    const publish = cache.beginSave(() => true);
    const published = publish([{ id: 'publish-1' }]);
    for (let i = 2; i < 12; i++) cache.save([{ id: `save-${i}` }]);
    assert.deepEqual(cache.loadSync(), [{ id: 'save-11' }], 'readers always see the newest save');
    await flushModelCacheWrites();
    assert.equal(await published, true);
  } finally {
    restore();
  }
  assert.equal(landed.length, 12);
  assert.deepEqual(onDisk(cache).models, [{ id: 'save-11' }]);
  assert.deepEqual(cache.loadSync(), [{ id: 'save-11' }]);
});

test('a publish still defers to a newer request that another process already wrote', async () => {
  const cache = makeModelCache({ fileName: 'merge-models.json', ttlMs: 60_000 });
  const publish = cache.beginSave(() => true);
  writeFileSync(
    cache.path(),
    JSON.stringify({ fetchedAt: Date.now(), requestedAt: Date.now() + 60_000, models: [{ id: 'other-process' }] })
  );
  assert.equal(await publish([{ id: 'mine' }]), false);
  assert.deepEqual(onDisk(cache).models, [{ id: 'other-process' }]);
});

test('a superseded request does not publish even while its write waits in the queue', async (t) => {
  const cache = makeModelCache({ fileName: 'superseded-models.json', ttlMs: 60_000 });
  const gate = Promise.withResolvers();
  const restore = mockRename(t, async (to) => {
    if (to.endsWith('superseded-models.json')) await gate.promise;
  });
  try {
    cache.save([{ id: 'blocker' }]);
    const old = cache.beginSave(() => true)([{ id: 'old' }]);
    cache.beginSave(() => true); // a newer request starts while the old write is queued
    gate.resolve();
    assert.equal(await old, false);
    await flushModelCacheWrites();
  } finally {
    restore();
  }
  assert.deepEqual(onDisk(cache).models, [{ id: 'blocker' }]);
});

test('a failed write neither crashes, corrupts the file, nor blocks later writes', async (t) => {
  const cache = makeModelCache({ fileName: 'failing-models.json', ttlMs: 60_000 });
  await cache.save([{ id: 'good' }]);
  const before = readFileSync(cache.path(), 'utf8');

  const restore = mockRename(t, (to) => {
    if (to.endsWith('failing-models.json')) throw Object.assign(new Error('disk exploded'), { code: 'EIO' });
  });
  try {
    await cache.save([{ id: 'doomed' }]);
    await cache.beginSave(() => true)([{ id: 'also-doomed' }]);
  } finally {
    restore();
  }
  assert.equal(readFileSync(cache.path(), 'utf8'), before, 'the previous file survives untouched');
  assert.deepEqual(cache.loadSync(), [{ id: 'good' }], 'a failed save is not served from memory forever');
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.startsWith('failing-models')),
    ['failing-models.json'],
    'no temp or lock file is left behind'
  );

  await cache.save([{ id: 'recovered' }]);
  assert.deepEqual(onDisk(cache).models, [{ id: 'recovered' }]);

  // A directory that cannot be created is a failure too, not a crash.
  const blocked = makeModelCache({ fileName: join('not-a-dir', 'models.json'), ttlMs: 60_000 });
  writeFileSync(join(dir, 'not-a-dir'), 'file');
  await blocked.save([{ id: 'x' }]);
  assert.equal(await blocked.beginSave(() => true)([{ id: 'y' }]), false);
  assert.equal(blocked.loadSync(), null);
});

test('the event loop stays responsive while another process holds the cache lock', async () => {
  const cache = makeModelCache({ fileName: 'contended-models.json', ttlMs: 60_000 });
  const lock = `${cache.path()}.lock`;
  // Own pid + foreign token: a live holder that is never reclaimable.
  writeFileSync(lock, `${process.pid} ${Date.now()} foreign-token\n`);
  let maxLagMs = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - last - 10);
    last = now;
  }, 10);
  const release = setTimeout(() => unlinkSync(lock), 900);
  try {
    const done = cache.save([{ id: 'slow' }]);
    const published = cache.beginSave(() => true)([{ id: 'slower' }]);
    assert.deepEqual(cache.loadSync(), [{ id: 'slow' }]);
    await done;
    assert.equal(await published, true);
  } finally {
    clearInterval(probe);
    clearTimeout(release);
  }
  // A synchronous lock wait would have frozen the loop for the whole hold.
  assert.ok(maxLagMs < 600, `event loop blocked for ${Math.round(maxLagMs)}ms during the cache write`);
  assert.deepEqual(onDisk(cache).models, [{ id: 'slower' }]);
  assert.equal(existsSync(lock), false);
});

test('a credential change while the publish waits on a held lock means nothing is published', async () => {
  const mirrored = [];
  const cache = makeModelCache({
    fileName: 'credential-models.json',
    ttlMs: 60_000,
    onSave: (models) => mirrored.push(models),
  });
  await cache.save([{ id: 'current-account' }]);
  const lock = `${cache.path()}.lock`;
  writeFileSync(lock, `${process.pid} ${Date.now()} foreign-token\n`);
  let accountActive = true;
  const published = cache.beginSave(() => accountActive)([{ id: 'old-account' }]);
  mirrored.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 50)); // the publish is now waiting for the lock
  accountActive = false; // the user switched accounts meanwhile
  unlinkSync(lock);
  assert.equal(await published, false);
  assert.deepEqual(mirrored, [], 'no mirror update for a superseded roster');
  assert.deepEqual(onDisk(cache).models, [{ id: 'current-account' }]);
});

test('a newer request starting while the publish waits on a held lock supersedes it', async () => {
  const cache = makeModelCache({ fileName: 'newer-request-models.json', ttlMs: 60_000 });
  await cache.save([{ id: 'before' }]);
  const lock = `${cache.path()}.lock`;
  writeFileSync(lock, `${process.pid} ${Date.now()} foreign-token\n`);
  const published = cache.beginSave(() => true)([{ id: 'stale' }]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  cache.beginSave(() => true);
  unlinkSync(lock);
  assert.equal(await published, false);
  assert.deepEqual(onDisk(cache).models, [{ id: 'before' }]);
});

test('mutating the models after save() or publish() does not change what reaches disk', async () => {
  const cache = makeModelCache({ fileName: 'snapshot-models.json', ttlMs: 60_000 });
  const lock = `${cache.path()}.lock`;
  writeFileSync(lock, `${process.pid} ${Date.now()} foreign-token\n`);
  const saved = [{ id: 'as-saved' }];
  const done = cache.save(saved);
  saved[0].id = 'mutated';
  saved.push({ id: 'extra' });
  assert.deepEqual(cache.loadSync(), [{ id: 'as-saved' }], 'the overlay shows the value as of the call');
  unlinkSync(lock);
  await done;
  assert.deepEqual(onDisk(cache).models, [{ id: 'as-saved' }]);

  writeFileSync(lock, `${process.pid} ${Date.now()} foreign-token\n`);
  const rows = [{ id: 'as-published' }];
  const extra = { tag: 'one' };
  const published = cache.beginSave(() => true)(rows, extra);
  rows[0].id = 'mutated';
  extra.tag = 'two';
  unlinkSync(lock);
  assert.equal(await published, true);
  const record = onDisk(cache);
  assert.deepEqual(record.models, [{ id: 'as-published' }]);
  assert.equal(record.tag, 'one');
});
