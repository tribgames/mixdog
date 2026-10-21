import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkerIndex } from './worker-index.mjs';
import { createWorkerRowStore } from './worker-index/row-store.mjs';

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

function observeStats(t, file, afterStat = () => {}) {
  const statSync = fs.statSync;
  let calls = 0;
  t.mock.method(fs, 'statSync', (path, ...args) => {
    const result = statSync(path, ...args);
    if (String(path) === file) {
      calls++;
      afterStat(calls);
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return () => calls;
}

test('worker listing checks the index once, and every subsequent call still checks freshness', (t) => {
  const { root, file } = fixture(t);
  const index = createWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    mgr: { getSessionRuntime: () => null },
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
  });
  const calls = observeStats(t, file);
  assert.deepEqual(
    index.readWorkerRows().map((entry) => entry.sessionId),
    ['first']
  );
  assert.equal(calls(), 1);
  fs.writeFileSync(file, JSON.stringify(doc('new-longer-session-id', 'new-longer-tag')));
  assert.deepEqual(
    index.readWorkerRows().map((entry) => entry.sessionId),
    ['new-longer-session-id']
  );
  assert.equal(calls(), 2);
});

test('one snapshot never mixes old rows with tombstones from a newer on-disk document', (t) => {
  const { file } = fixture(t);
  const store = createWorkerRowStore(file);
  store.readAll(); // establish a cached view
  const calls = observeStats(t, file, (count) => {
    if (count === 1) fs.writeFileSync(file, JSON.stringify(doc('second-longer-id', 'new-tag')));
  });
  const first = store.readSnapshot();
  assert.equal(calls(), 1);
  assert.deepEqual(
    first.rows.map((entry) => entry.sessionId),
    ['first']
  );
  assert.deepEqual(
    first.tombstones.map((entry) => entry.tag),
    ['old-tag']
  );
  const second = store.readSnapshot();
  assert.equal(calls(), 2);
  assert.deepEqual(
    second.rows.map((entry) => entry.sessionId),
    ['second-longer-id']
  );
  assert.deepEqual(
    second.tombstones.map((entry) => entry.tag),
    ['new-tag']
  );
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
