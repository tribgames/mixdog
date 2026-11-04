import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { withFileLock } from '../../../../runtime/shared/file-lock.mjs';
import { acquireOsExclusiveLockSync } from '../../../../runtime/shared/os-exclusive-lock.mjs';
import { claimSessionWriter, releaseSessionWriter, whenSessionWritersFree } from '../../../../runtime/agent/orchestrator/session/store/session-writer-claim.mjs';
import { flushAllIndexWrites } from '../index-write-queue.mjs';
import { createWorkerIndex } from '../worker-index.mjs';
import { PROCESS_RESTART_FAILURE } from '../worker-index/row-liveness.mjs';
import { createGoneRowSweep } from './gone-rows.mjs';

// An index shaped like a busy user's: ~1,800 rows, most of them settled rows
// of owners that never come back and whose session files are gone.
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const LEAD = 'sess_gone_lead';
const id = (kind, i) => `sess_${kind}_${String(i).padStart(4, '0')}`;

const readIndex = (file) => JSON.parse(readFileSync(file, 'utf8'));

function row(sessionId, now, extra = {}) {
  return {
    tag: `tag-${sessionId}`,
    sessionId,
    agent: 'worker',
    ownerSessionId: LEAD,
    parentSessionId: LEAD,
    status: 'idle',
    stage: 'idle',
    createdAt: new Date(now - 12 * DAY).toISOString(),
    updatedAt: new Date(now - 12 * DAY).toISOString(),
    ...extra,
  };
}

/** A data dir with the index below; `kept` are the ids the sweep must leave. */
function userShapedFixture(t, { idle = 1378, cancelled = 72, live = 339 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-gone-rows-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  mkdirSync(join(root, 'sessions'));
  const now = Date.now();
  const workers = {};
  const kept = new Set();
  const add = (sessionId, extra, { file = false, keep }) => {
    workers[sessionId] = row(sessionId, now, extra);
    if (file) {
      writeFileSync(join(root, 'sessions', `${sessionId}.json`), JSON.stringify({ id: sessionId, owner: 'agent', agent: 'worker', ownerSessionId: LEAD, title: sessionId, messages: [] }));
    }
    if (keep) kept.add(sessionId);
  };
  // 1,451 rows to prune: gone sessions, settled long ago.
  for (let i = 0; i < idle; i += 1) add(id('goneidle', i), {}, { keep: false });
  for (let i = 0; i < cancelled; i += 1) add(id('gonecancel', i), { status: 'cancelled', stage: 'cancelled' }, { keep: false });
  add(id('gonefailed', 0), { status: 'failed', stage: 'failed', failureReason: PROCESS_RESTART_FAILURE, restartNotified: new Date(now - 11 * DAY).toISOString() }, { keep: false });
  // Rows that stay.
  for (let i = 0; i < live; i += 1) add(id('liveidle', i), {}, { file: true, keep: true });
  for (let i = 0; i < 12; i += 1) {
    add(id('running', i), { status: 'running', stage: 'streaming', updatedAt: new Date(now - 2 * MINUTE).toISOString() }, { file: true, keep: true });
  }
  add(id('owed', 0), { status: 'failed', stage: 'failed', failureReason: PROCESS_RESTART_FAILURE }, { keep: true });
  add(id('recent', 0), { updatedAt: new Date(now - 60 * MINUTE).toISOString() }, { keep: true });
  add(id('working', 0), {}, { keep: true });
  add(id('goneactive', 0), { status: 'running', stage: 'streaming' }, { keep: true });
  const gone = Object.keys(workers).length - kept.size; // the idle and cancelled rows, and the notified failure
  assert.equal(gone, idle + cancelled + 1);

  const file = join(root, 'agent-workers.json');
  const legacy = JSON.stringify({ version: 2, updatedAt: new Date(now).toISOString(), workers, tombstones: {} }, null, 2);
  writeFileSync(file, legacy);
  const past = new Date(now - 60_000);
  utimesSync(file, past, past);

  // The running rows belong to turns this process runs (else the index settles them at startup).
  const running = (sessionId) => sessionId.startsWith('sess_running_') || sessionId === id('goneactive', 0);
  const mgr = {
    getSessionRuntime: (sessionId) => (running(sessionId) ? { stage: 'streaming' } : null),
    isSessionTurnInFlight: (sessionId) => sessionId === id('working', 0) || running(sessionId),
  };
  const worker = createWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    mgr,
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
  });
  const sweep = createGoneRowSweep({ cfgMod: { loadConfig: () => ({}) }, mgr, tagMaps: { unbindIfOwned() {} }, index: worker, ownsDataDir: () => true });
  t.after(async () => {
    await flushAllIndexWrites();
    worker.dispose();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file, legacy, now, kept, gone, worker, sweep, workers };
}

test('the sweep removes exactly the settled rows whose session file is gone, for any owner', async (t) => {
  const { root, file, legacy, kept, worker, sweep } = userShapedFixture(t);
  assert.equal(worker.readAllWorkerRows().length, 1806);

  const removed = await sweep.sweepGoneRows();
  await worker.flushWorkerIndexWrites();

  assert.equal(removed, 1451);
  const left = readIndex(file);
  assert.deepEqual(Object.keys(left.workers).sort(), [...kept].sort(), 'only rows that miss a condition remain');
  assert.equal(Object.keys(left.tombstones).length, 500, 'each removal left a tombstone, capped as ever');
  assert.equal(readFileSync(`${file}.pre-prune.bak`, 'utf8'), legacy, 'the old bytes were saved first');
  assert.ok(statSync(file).size < legacy.length);
  assert.ok(existsSync(join(root, 'sessions')));
  // A second sweep has nothing left to remove.
  assert.equal(await sweep.sweepGoneRows(), 0);
});

test('an owed restart failure, a live session, live work and a row within retention are kept', async (t) => {
  const { kept, worker, sweep } = userShapedFixture(t, { idle: 60, cancelled: 0, live: 10 });
  await sweep.sweepGoneRows();
  const left = new Set(worker.readAllWorkerRows().map((entry) => entry.sessionId));
  for (const sessionId of [id('owed', 0), id('liveidle', 0), id('running', 0), id('working', 0), id('recent', 0), id('goneactive', 0)]) {
    assert.ok(left.has(sessionId), `${sessionId} stays`);
  }
  assert.equal(left.size, kept.size);
});

test('the backup is written once, before the first removal, and later removals leave it alone', async (t) => {
  const { file, legacy, worker, sweep } = userShapedFixture(t, { idle: 60, cancelled: 0, live: 10 });
  assert.equal(existsSync(`${file}.pre-prune.bak`), false);
  assert.equal(sweep.forgetDeletedSession(id('liveidle', 1)), true);
  assert.equal(readFileSync(`${file}.pre-prune.bak`, 'utf8'), legacy, 'a delete hook is a removal too');
  await sweep.sweepGoneRows();
  await worker.flushWorkerIndexWrites();
  assert.equal(readFileSync(`${file}.pre-prune.bak`, 'utf8'), legacy, 'the first bytes are the ones kept');
});
test('deleting a session removes its terminal rows; a running or owed row stays', async (t) => {
  const { file, worker, sweep } = userShapedFixture(t, { idle: 60, cancelled: 0, live: 10 });
  assert.equal(sweep.forgetDeletedSession(id('liveidle', 1)), true);
  assert.equal(sweep.forgetDeletedSession(id('running', 1)), false, 'a running row is not terminal');
  assert.equal(sweep.forgetDeletedSession(id('owed', 0)), false, 'an owed restart failure stays');
  assert.equal(sweep.forgetDeletedSession(id('liveidle', 2)), true);
  worker.flushWorkerIndexMutations();
  await worker.flushWorkerIndexWrites();
  const left = readIndex(file);
  assert.equal(left.workers[id('liveidle', 1)], undefined);
  assert.equal(left.workers[id('liveidle', 2)], undefined);
  assert.ok(left.workers[id('liveidle', 3)] && left.workers[id('running', 1)] && left.workers[id('owed', 0)]);
  assert.equal(Object.keys(left.tombstones).length, 2);
});

test('the pool lists the same rows, in the same order and fields, after the sweep', async (t) => {
  const { sweep, worker, gone } = userShapedFixture(t, { idle: 200, cancelled: 10, live: 20 });
  const runningIds = new Set([id('goneactive', 0), ...Array.from({ length: 12 }, (_, i) => id('running', i))]);
  let instance = 0;
  const list = async () =>
    (await import(`../../../../runtime/agent/orchestrator/session/store-agent-worker-rows.mjs?gone=${(instance += 1)}`)).listStoredAgentWorkersAsync({
      runningSessionIds: runningIds,
    });

  const before = await list();
  assert.ok(before.length >= 13, 'the running rows are listed');
  assert.equal(await sweep.sweepGoneRows(), gone);
  await worker.flushWorkerIndexWrites();
  assert.deepEqual(await list(), before);
});
// A session record that appears — a save in this process or another — between
// the listing that named a row a candidate and the removal keeps its row.
const recordOf = (root, sessionId) => join(root, 'sessions', `${sessionId}.json`);
const saveRecord = (root, sessionId) =>
  writeFileSync(recordOf(root, sessionId), JSON.stringify({ id: sessionId, owner: 'agent', agent: 'worker', messages: [] }));

test('a record that appears after the listing keeps its row', async (t) => {
  const { root, file, kept, gone, worker, sweep } = userShapedFixture(t, { idle: 60, cancelled: 0, live: 10 });
  const late = id('goneidle', 5);
  const readdir = fsp.readdir;
  t.mock.method(fsp, 'readdir', async (...args) => {
    const names = await readdir.apply(fsp, args);
    saveRecord(root, late); // the save lands once the listing is taken
    return names;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  assert.equal(await sweep.sweepGoneRows(), gone - 1);
  await worker.flushWorkerIndexWrites();

  const left = readIndex(file).workers;
  assert.ok(left[late], 'the row of the record that appeared stays');
  assert.equal(Object.keys(left).length, kept.size + 1);
});

test('a record that appears before the removal is persisted keeps its row', async (t) => {
  const { root, file, kept, gone, worker, sweep } = userShapedFixture(t, { idle: 60, cancelled: 0, live: 10 });
  const late = id('goneidle', 6);
  // The persist waits on the index lock; the record is saved while it waits.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let locked;
  const lockTaken = new Promise((resolve) => {
    locked = resolve;
  });
  const holder = withFileLock(`${file}.lock`, async () => {
    locked();
    await gate;
  });
  await lockTaken;

  const swept = sweep.sweepGoneRows();
  // The first batch is out of this process's view at once, but not on disk.
  while (worker.readAllWorkerRows().some((entry) => entry.sessionId === id('goneidle', 0))) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).workers[late], 'still in the file');
  saveRecord(root, late);
  release();
  await holder;
  assert.equal(await swept, gone - 1, 'the persisted run kept the row whose record appeared');
  await worker.flushWorkerIndexWrites();

  const left = readIndex(file).workers;
  assert.ok(left[late], 'the persisted removal ran again against the record and kept the row');
  assert.equal(Object.keys(left).length, kept.size + 1);
  assert.ok(worker.readAllWorkerRows().some((entry) => entry.sessionId === late), 'and the view follows the file');
});

test('a session with a writer — here or in another process — keeps its row', async (t) => {
  const { root, file, kept, gone, worker, sweep } = userShapedFixture(t, { idle: 60, cancelled: 0, live: 10 });
  const here = id('goneidle', 7);
  const elsewhere = id('goneidle', 8);
  const claim = claimSessionWriter(here); // an open session of this process, its first save still to come
  assert.equal(claim.held, true);
  const lockPath = join(root, 'session-writer-locks', `${elsewhere}.lock`);
  const other = acquireOsExclusiveLockSync(lockPath, { namespace: 'session-writer' });
  assert.equal(other.held, true);

  let removed;
  try {
    removed = await sweep.sweepGoneRows();
    await worker.flushWorkerIndexWrites();
  } finally {
    other.release();
    await releaseSessionWriter(here);
  }
  assert.equal(removed, gone - 2);

  const left = readIndex(file).workers;
  assert.ok(left[here] && left[elsewhere]);
  assert.equal(Object.keys(left).length, kept.size + 2);
  assert.equal(existsSync(recordOf(root, here)), false, 'no record was ever there: only the writer kept the row');
});
test('no writer can claim a session between the check and the publish of its removal', async (t) => {
  const { root, file, kept, gone, worker, sweep } = userShapedFixture(t, { idle: 60, cancelled: 0, live: 10 });
  const inFirstBatch = id('goneidle', 3);
  const inSecondBatch = id('goneidle', 55);
  const lockOf = (sessionId) => join(root, 'session-writer-locks', `${sessionId}.lock`);
  // Another process tries to claim the session — to save it — at the moment
  // the index file holding the removal is about to be replaced.
  const seen = {};
  const rename = fsp.rename;
  t.mock.method(fsp, 'rename', async (...args) => {
    if (String(args[1]) === file) {
      const attempt = acquireOsExclusiveLockSync(lockOf(inFirstBatch), { namespace: 'session-writer' });
      seen[seen.first === undefined ? 'first' : 'second'] = attempt.held;
      if (attempt.held) attempt.release();
      const other = acquireOsExclusiveLockSync(lockOf(inSecondBatch), { namespace: 'session-writer' });
      seen.otherBatchHeld ??= other.held;
      if (other.held) other.release();
    }
    return rename.apply(fsp, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  assert.equal(await sweep.sweepGoneRows(), gone);
  await worker.flushWorkerIndexWrites();

  assert.equal(seen.first, false, 'a claim in the window before the first publish was refused');
  assert.equal(seen.otherBatchHeld, true, 'a session of a batch not yet checked is not fenced');
  assert.equal(Object.keys(readIndex(file).workers).length, kept.size);
  // The fence is gone with the publish: the session can be claimed and saved again.
  const after = acquireOsExclusiveLockSync(lockOf(inFirstBatch), { namespace: 'session-writer' });
  assert.equal(after.held, true);
  after.release();
});
test('a creation of an id the prune is deciding about waits for the batch and is not refused', async (t) => {
  const { file, gone, sweep } = userShapedFixture(t, { idle: 60, cancelled: 0, live: 10 });
  const reused = id('goneidle', 3); // a reserved id created again while its old row is pruned
  const rename = fsp.rename;
  let waiting = null;
  let freeBeforePublish = null;
  t.mock.method(fsp, 'rename', async (...args) => {
    if (String(args[1]) === file && !waiting) {
      let resolved = false;
      waiting = whenSessionWritersFree(reused).then(() => {
        resolved = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      freeBeforePublish = resolved;
    }
    return rename.apply(fsp, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  assert.equal(await sweep.sweepGoneRows(), gone);
  await waiting;

  assert.equal(freeBeforePublish, false, 'the creator waited while the batch held its exclusion');
  const claim = claimSessionWriter(reused);
  assert.equal(claim.held, true, 'and the claim after the wait is granted');
  releaseSessionWriter(reused);
});
test('a process that does not own the data dir prunes nothing and saves no backup', async (t) => {
  const { file, legacy, worker } = userShapedFixture(t, { idle: 60, cancelled: 0, live: 10 });
  const mgr = { getSessionRuntime: () => null, isSessionTurnInFlight: () => false };
  // The default owner state: no daemon owner lock is held by this test process.
  const nonOwner = createGoneRowSweep({ cfgMod: { loadConfig: () => ({}) }, mgr, tagMaps: { unbindIfOwned() {} }, index: worker });

  assert.equal(await nonOwner.sweepGoneRows(), 0);
  await worker.flushWorkerIndexWrites();

  assert.equal(readFileSync(file, 'utf8'), legacy, 'the index is untouched');
  assert.equal(existsSync(`${file}.pre-prune.bak`), false);
});