// Idle release of the save worker and parent-side failure evidence without a
// transcript copy: an idle worker thread is terminated and re-spawned on
// demand (bases resend full, own-commit stamps survive the restart), no write
// is lost or reordered across the restart, and evidence is recorded only when
// it provably matches what was posted.
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-save-worker-idle-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_SESSION_SAVE_FAULT_HOOKS = '1';
mkdirSync(join(root, 'sessions'));

const { saveSessionAsync, bumpSessionGeneration } = await import('../store.mjs');
const { _saveWorkerForTest, _setSaveWorkerIdleMsForTest, _detachSaveWorkerForTest } = await import(
  './save-worker.mjs'
);
const { _sessionWriteAuthorityRefusal } = await import('./write-admission.mjs');
const { getFailedSaveSnapshot, getSessionSaveError } = await import('./live-state.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');

const posted = [];
const originalPost = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (message, ...rest) {
  if (message && message.reqId !== undefined) posted.push(message);
  return originalPost.call(this, message, ...rest);
};

test.after(async () => {
  Worker.prototype.postMessage = originalPost;
  _setSaveWorkerIdleMsForTest(null);
  await settleSessionSummaryIndex();
  rmSync(root, { recursive: true, force: true });
});

const sessionFile = (id) => join(root, 'sessions', `${id}.json`);
const diskMessages = (id) => JSON.parse(readFileSync(sessionFile(id), 'utf8')).messages;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeSession(id, count = 3) {
  return {
    id,
    generation: 1,
    closed: false,
    messages: Array.from({ length: count }, (_, index) => ({ role: 'user', content: `${id} ${index}` })),
  };
}

async function waitForRelease() {
  const deadline = Date.now() + 5000;
  while (_saveWorkerForTest()) {
    if (Date.now() > deadline) throw new Error('the idle worker was never released');
    await sleep(10);
  }
}

function countReads(t, path) {
  const original = fs.readFileSync;
  let count = 0;
  fs.readFileSync = function (file, ...rest) {
    if (String(file) === path) count++;
    return original.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  });
  return {
    get count() {
      return count;
    },
  };
}

test('an idle worker is released, and the next save re-spawns it and goes out full', async (t) => {
  _setSaveWorkerIdleMsForTest(50);
  const id = 'sess_idle_release';
  const session = makeSession(id);
  await saveSessionAsync(session, { expectedGeneration: 1 });
  const first = _saveWorkerForTest();
  assert.ok(first, 'a worker serves the write');
  await waitForRelease();
  // The released worker's last commit stamp was adopted before its channel
  // closed: the ownership check still answers without reading the file.
  const reads = countReads(t, sessionFile(id));
  assert.equal(_sessionWriteAuthorityRefusal(id), null);
  assert.equal(reads.count, 0);
  posted.length = 0;
  session.messages = [...session.messages, { role: 'assistant', content: 'after release' }];
  await saveSessionAsync(session, { expectedGeneration: 1 });
  assert.notEqual(_saveWorkerForTest(), first, 'a fresh worker');
  assert.equal(posted.length, 1);
  assert.ok(posted[0].session, 'its base is gone, so the save is a full snapshot');
  assert.equal(_sessionWriteAuthorityRefusal(id), null);
  assert.equal(reads.count, 0, 'the new worker commit stamp reaches this realm too');
  assert.equal(diskMessages(id).at(-1).content, 'after release');
});

test('writes racing the idle release are neither lost nor reordered', async () => {
  _setSaveWorkerIdleMsForTest(0);
  const ids = ['sess_idle_race_a', 'sess_idle_race_b', 'sess_idle_race_c'];
  const sessions = ids.map((id) => makeSession(id, 1));
  let restarts = 0;
  let last = null;
  for (let round = 0; round < 30; round++) {
    const burst = [];
    for (const session of sessions) {
      session.messages = [...session.messages, { role: 'assistant', content: `round ${round}` }];
      burst.push(saveSessionAsync(session, { expectedGeneration: 1 }));
      if (round % 3 === 0) {
        session.messages = [...session.messages, { role: 'user', content: `extra ${round}` }];
        burst.push(saveSessionAsync(session, { expectedGeneration: 1 }));
      }
    }
    await Promise.all(burst);
    const worker = _saveWorkerForTest();
    if (worker && worker !== last) restarts++;
    last = worker;
    if (round % 2 === 0) await sleep(5);
  }
  assert.ok(restarts > 1, `the worker was released and re-spawned (${restarts} instances)`);
  for (const session of sessions) {
    assert.deepEqual(diskMessages(session.id), session.messages, `${session.id} holds its newest state`);
  }
});

test('evidence of a dead worker is rebuilt only while it provably matches what was posted', async () => {
  _setSaveWorkerIdleMsForTest(null);
  for (const edited of [false, true]) {
    const id = `sess_idle_evidence_${edited ? 'edited' : 'intact'}`;
    const session = makeSession(id, 2);
    await saveSessionAsync(session, { expectedGeneration: 1 });
    // The posted write is refused before the commit lock, so terminating
    // the detached instance cannot strand that lock.
    assert.equal(bumpSessionGeneration(id, 'evidence-test'), 2);
    session.messages = [...session.messages, { role: 'assistant', content: 'attempted' }];
    const inFlight = saveSessionAsync(session, { expectedGeneration: 1 }); // a delta
    if (edited) session.messages[0].content = 'edited in place after the post';
    session.messages = [...session.messages, { role: 'user', content: 'never posted' }];
    const dead = _detachSaveWorkerForTest();
    assert.ok(dead);
    await assert.rejects(inFlight, /detached before this write settled/);
    assert.ok(getSessionSaveError(id), 'the failure is recorded');
    const evidence = getFailedSaveSnapshot(id);
    if (edited) {
      assert.equal(evidence, null, 'an in-place edit since the post leaves no provable evidence');
    } else {
      assert.deepEqual(
        evidence.messages.map((message) => message.content),
        [`${id} 0`, `${id} 1`, 'attempted'],
        'exactly the posted payload'
      );
    }
    await dead.terminate();
  }
});
