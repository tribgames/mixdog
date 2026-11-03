import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkerIndex } from './worker-index.mjs';
import { createWorkerRowStore } from './worker-index/row-store.mjs';
import { eventually } from '../../../runtime/shared/watched-file-cache.test-helpers.mjs';

const row = (id) => ({ tag: id, sessionId: id, agent: 'worker', status: 'idle', clientHostPid: 4242 });
const tombstone = (tag) => ({
  tag,
  agent: 'worker',
  parentSessionId: 'lead',
  ownerSessionId: 'lead',
  clientHostPid: 4242,
  reapedAt: new Date().toISOString(),
});
const doc = (id, tag) => ({ version: 2, workers: { [id]: row(id) }, tombstones: [tombstone(tag)] });

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'mixdog-worker-snapshot-'));
  const file = join(root, 'agent-workers.json');
  fs.writeFileSync(file, JSON.stringify(doc('first', 'old-tag')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file };
}

function observeStats(t, file) {
  const statSync = fs.statSync;
  let calls = 0;
  t.mock.method(fs, 'statSync', (path, ...args) => {
    const result = statSync(path, ...args);
    if (String(path) === file) calls++;
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return () => calls;
}

test('worker listing reads the index again only after another writer changed it', async (t) => {
  const { root, file } = fixture(t);
  const index = createWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    mgr: { getSessionRuntime: () => null },
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
  });
  t.after(() => index.dispose());
  // Construction read the index (startup recovery); every later read is warm.
  const calls = observeStats(t, file);
  assert.deepEqual(
    index.readWorkerRows().map((entry) => entry.sessionId),
    ['first']
  );
  index.readWorkerRows();
  assert.equal(calls(), 0, 'a warm read checks nothing on disk');
  fs.writeFileSync(file, JSON.stringify(doc('new-longer-session-id', 'new-longer-tag')));
  await eventually(() => index.readWorkerRows()[0]?.sessionId === 'new-longer-session-id');
  const reads = calls();
  index.readWorkerRows();
  assert.equal(calls(), reads);
});

test('one snapshot never mixes old rows with tombstones from a newer on-disk document', async (t) => {
  const { file } = fixture(t);
  const store = createWorkerRowStore(file);
  t.after(() => store.close());
  store.readAll(); // establish a cached view
  fs.writeFileSync(file, JSON.stringify(doc('second-longer-id', 'new-tag')));
  const seen = [];
  await eventually(() => {
    const { rows, tombstones } = store.readSnapshot();
    seen.push([rows.map((entry) => entry.sessionId), tombstones.map((entry) => entry.tag)]);
    return rows[0]?.sessionId === 'second-longer-id';
  });
  for (const pair of seen) {
    assert.ok(
      JSON.stringify(pair) === JSON.stringify([['first'], ['old-tag']]) ||
        JSON.stringify(pair) === JSON.stringify([['second-longer-id'], ['new-tag']]),
      JSON.stringify(pair)
    );
  }
});

// Another process rewrites the index right after this process's next read
// of it took the bytes. Counts the reads of the file.
function rewriteDuringNextRead(t, file, next) {
  const { readFileSync } = fs;
  let armed = true;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    const result = readFileSync(path, ...args);
    if (String(path) === file) {
      reads += 1;
      if (armed) {
        armed = false;
        fs.writeFileSync(file, JSON.stringify(next));
      }
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return () => reads;
}

const tags = (snapshot) => ({
  rows: snapshot.rows.map((entry) => entry.sessionId),
  tombstones: snapshot.tombstones.map((entry) => entry.tag),
});

test('a rewrite right after a read never mixes documents and is picked up', async (t) => {
  const { file } = fixture(t);
  const store = createWorkerRowStore(file);
  t.after(() => store.close());
  const reads = rewriteDuringNextRead(t, file, doc('second-longer-id', 'new-tag'));
  const newer = { rows: ['second-longer-id'], tombstones: ['new-tag'] };
  assert.deepEqual(tags(store.readSnapshot()), { rows: ['first'], tombstones: ['old-tag'] });
  // The rewrite's watch event reads the newer document back (off the loop), and it stays.
  await eventually(() => JSON.stringify(tags(store.readSnapshot())) === JSON.stringify(newer));
  const before = reads();
  for (let i = 0; i < 3; i += 1) assert.deepEqual(tags(store.readSnapshot()), newer);
  assert.equal(reads(), before, 'settled on the newer document');
  assert.equal(before, 1, 'only the first read touched the file synchronously');
});

// A read of the index that fails once (a Windows sharing violation) and then
// clears with no change to the file.
function failNextRead(t, file) {
  const readFileSync = fs.readFileSync;
  let armed = false;
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (armed && String(path) === file) {
      armed = false;
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    return readFileSync(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return () => {
    armed = true;
  };
}

test('a failed index read keeps the last good rows and is retried, never cached as empty', async (t) => {
  const { file } = fixture(t);
  const arm = failNextRead(t, file);
  const ids = (store) => store.readSnapshot().rows.map((entry) => entry.sessionId);

  const cold = createWorkerRowStore(file);
  t.after(() => cold.close());
  arm();
  assert.deepEqual(ids(cold), [], 'nothing good was read yet');
  // The unchanged file is read again off the loop.
  await eventually(() => ids(cold)[0] === 'first');

  const warm = createWorkerRowStore(file);
  t.after(() => warm.close());
  assert.deepEqual(ids(warm), ['first']);
  warm.invalidate();
  arm();
  assert.deepEqual(ids(warm), ['first'], 'the last good document stands');
  assert.deepEqual(warm.readSnapshot().tombstones.map((entry) => entry.tag), ['old-tag']);
  assert.deepEqual(ids(warm), ['first']);
});

test("a reload that read the file before this process's write landed never replaces that write", async (t) => {
  const { file } = fixture(t);
  const store = createWorkerRowStore(file);
  t.after(() => store.close());
  const ids = () =>
    store
      .readSnapshot()
      .rows.map((entry) => entry.sessionId)
      .sort();
  assert.deepEqual(ids(), ['first']);
  // The next async read of the index takes the bytes there now and hands
  // them over only once released.
  const readFile = fsp.readFile;
  let held = null;
  let release = null;
  t.mock.method(fsp, 'readFile', async (path, ...args) => {
    const bytes = await readFile(path, ...args);
    if (held || String(path) !== file) return bytes;
    held = bytes;
    await new Promise((resolve) => {
      release = resolve;
    });
    return bytes;
  });
  // Another process's write: its reload reads these bytes and is held.
  fs.writeFileSync(file, JSON.stringify({ version: 2, workers: { first: row('first'), foreign: row('foreign') } }));
  await eventually(() => held !== null);
  // This process's write lands meanwhile, over the foreign one.
  store.write((rows) => rows.set('own', row('own')));
  await store.flush();
  assert.deepEqual(ids(), ['first', 'foreign', 'own']);
  release();
  // The held read has landed (its handlers run before the next turn); no
  // later read of the file has finished yet.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ids(), ['first', 'foreign', 'own'], 'the older bytes did not replace the write');
  await eventually(() => JSON.stringify(ids()) === JSON.stringify(['first', 'foreign', 'own']));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).workers).sort(), ids());
});

test('unpersisted rows and tombstones share a projection without checking the file', async (t) => {
  const { file } = fixture(t);
  const store = createWorkerRowStore(file);
  store.write((rows, tombstones) => {
    rows.set('pending', row('pending'));
    tombstones.set('pending-tombstone', tombstone('pending-tag'));
  });
  const calls = observeStats(t, file);
  const snapshot = store.readSnapshot();
  assert.deepEqual(snapshot.rows.map((entry) => entry.sessionId).sort(), ['first', 'pending']);
  assert.deepEqual(snapshot.tombstones.map((entry) => entry.tag).sort(), ['old-tag', 'pending-tag']);
  assert.equal(calls(), 0);
  await store.flush();
  assert.deepEqual(
    store
      .readSnapshot()
      .rows.map((entry) => entry.sessionId)
      .sort(),
    ['first', 'pending']
  );
});

test('missing, malformed and unconfigured indexes expose empty collections together', (t) => {
  const { file } = fixture(t);
  const store = createWorkerRowStore(file);
  fs.writeFileSync(file, 'invalid json');
  assert.deepEqual(store.readSnapshot(), { rows: [], tombstones: [] });
  fs.unlinkSync(file);
  assert.deepEqual(store.readSnapshot(), { rows: [], tombstones: [] });
  assert.deepEqual(createWorkerRowStore(null).readSnapshot(), { rows: [], tombstones: [] });
});
