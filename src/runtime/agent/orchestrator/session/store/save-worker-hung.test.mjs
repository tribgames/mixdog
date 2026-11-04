// A save worker that stays alive but never answers is retired as hung: the
// durable save waiting on it rejects with ESAVEWORKERHUNG instead of pending
// forever, and the next save writes the current state through a new worker.
// One terminated inside its commit gives that session's commit lock back once
// it has exited, so the session saves, closes and deletes again.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';

const root = mkdtempSync(join(tmpdir(), 'mixdog-save-worker-hung-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_SESSION_SAVE_FAULT_HOOKS = '1';
mkdirSync(join(root, 'sessions'));

const {
  saveSessionDurably,
  getSessionSaveError,
  getSessionLifecycleCommitError,
  clearSessionLifecycleCommitError,
  setSessionSaveFault,
  markSessionClosed,
  bumpSessionGeneration,
  deleteSession,
} = await import('../store.mjs');
const { SAVE_OUTCOME_SAVED } = await import('./live-state.mjs');
const { _saveWorkerForTest, _setSaveWorkerHungMsForTest } = await import('./save-worker.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');
const { releaseSessionWriter, sessionWriterHeldHere } = await import('./session-writer-claim.mjs');

test.after(async () => {
  _setSaveWorkerHungMsForTest(null);
  await settleSessionSummaryIndex();
  (await import('./session-writer-claim.mjs')).releaseHeldSessionWriters();
  rmSync(root, { recursive: true, force: true });
});

/** Settles with `promise`, or rejects with `message` after `ms`. */
function within(promise, ms, message) {
  let timer;
  const bound = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

test('a durable save on a worker that never answers rejects as hung, and the next save lands', async () => {
  const id = 'sess_save_worker_hung';
  const session = { id, owner: 'user', generation: 0, closed: false, messages: [{ role: 'user', content: 'h1' }] };
  await saveSessionDurably(session);
  assert.equal(_setSaveWorkerHungMsForTest(300), true);

  // The worker stays alive but nothing it sends reaches the store again.
  const silent = _saveWorkerForTest();
  silent.removeAllListeners('message');
  session.messages.push({ role: 'assistant', content: 'h2' });
  await within(
    assert.rejects(saveSessionDurably(session), { code: 'ESAVEWORKERHUNG' }),
    5_000,
    'the durable save on a silent worker is still pending'
  );
  assert.match(getSessionSaveError(id)?.message ?? '', /made no progress/, 'the session stays unsaved, not silently lost');
  assert.notEqual(_saveWorkerForTest(), silent, 'the hung worker was retired');

  // The short bound only makes the silent worker expire quickly. A healthy
  // save (a fresh worker's spawn included) must run under the real bound, or
  // a loaded machine reads its slow-but-live worker as hung.
  _setSaveWorkerHungMsForTest(null);
  // The next save goes to a fresh worker and writes the current state.
  session.messages.push({ role: 'user', content: 'h3' });
  assert.equal(await within(saveSessionDurably(session), 5_000, 'the next save never landed'), SAVE_OUTCOME_SAVED);
  const onDisk = JSON.parse(readFileSync(join(root, 'sessions', `${id}.json`), 'utf8'));
  assert.deepEqual(
    onDisk.messages.map((message) => message.content),
    ['h1', 'h2', 'h3']
  );
  assert.equal(getSessionSaveError(id), null);
});

for (const stall of ['before-rename', 'after-rename']) {
  test(`a worker terminated ${stall} gives the commit lock back: the session saves, closes and deletes`, async (t) => {
    const id = `sess_save_worker_stalled_${stall}`;
    const session = { id, owner: 'user', generation: 0, closed: false, messages: [{ role: 'user', content: 's1' }] };
    await saveSessionDurably(session);
    assert.equal(_setSaveWorkerHungMsForTest(300), true);
    t.after(() => {
      _setSaveWorkerHungMsForTest(null);
      setSessionSaveFault(null);
    });

    // The worker stops inside its commit, holding the session's commit lock.
    assert.equal(setSessionSaveFault({ ids: id, stall }), true);
    session.messages.push({ role: 'assistant', content: 's2' });
    await within(
      assert.rejects(saveSessionDurably(session), { code: 'ESAVEWORKERHUNG' }),
      5_000,
      'the durable save on a stalled worker is still pending'
    );
    setSessionSaveFault(null);
    // Only the stalled worker needed the short bound; the healthy saves below
    // run under the real one (see the first test).
    _setSaveWorkerHungMsForTest(null);

    session.messages.push({ role: 'user', content: 's3' });
    assert.equal(await within(saveSessionDurably(session), 5_000, 'the session never saved again'), SAVE_OUTCOME_SAVED);
    const onDisk = JSON.parse(readFileSync(join(root, 'sessions', `${id}.json`), 'utf8'));
    assert.deepEqual(
      onDisk.messages.map((message) => message.content),
      ['s1', 's2', 's3']
    );
    assert.equal(getSessionSaveError(id), null);
    assert.deepEqual(
      readdirSync(join(root, 'sessions')).filter((name) => name.startsWith(`${id}.json.`)),
      [],
      'the stalled write left no scratch file behind'
    );
    assert.equal(
      typeof (await within(markSessionClosed(id, 'stalled-commit'), 5_000, 'the close never completed')),
      'number'
    );
    assert.equal(await within(deleteSession(id), 5_000, 'the delete never completed'), true);
  });
}

test('a save queued behind a stalled worker that never exits is answered within the hung bound', async (t) => {
  const id = 'sess_save_worker_exit_withheld';
  const session = { id, owner: 'user', generation: 0, closed: false, messages: [{ role: 'user', content: 'x1' }] };
  await saveSessionDurably(session);
  assert.equal(_setSaveWorkerHungMsForTest(300), true);
  t.after(() => {
    _setSaveWorkerHungMsForTest(null);
    setSessionSaveFault(null);
  });

  // Its termination never completes: the thread stays inside its commit.
  const stalled = _saveWorkerForTest();
  stalled.terminate = () => new Promise(() => {});
  assert.equal(setSessionSaveFault({ ids: id, stall: 'before-rename' }), true);
  session.messages.push({ role: 'assistant', content: 'x2' });
  await within(
    assert.rejects(saveSessionDurably(session), { code: 'ESAVEWORKERHUNG' }),
    5_000,
    'the durable save on a stalled worker is still pending'
  );
  setSessionSaveFault(null);

  // The retry waits on that exit, which never comes: still answered, still dirty.
  session.messages.push({ role: 'user', content: 'x3' });
  await within(
    assert.rejects(saveSessionDurably(session), { code: 'ESAVEWORKERHUNG' }),
    5_000,
    'the save queued behind the unexited worker is still pending'
  );
  assert.match(getSessionSaveError(id)?.message ?? '', /has not exited/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, 'sessions', `${id}.json`), 'utf8')).messages.map((m) => m.content),
    ['x1']
  );

  // Once it really exits, the next save writes the current state. That save
  // is healthy work, so it runs under the real hung bound (see the first test).
  _setSaveWorkerHungMsForTest(null);
  const exited = once(stalled, 'exit');
  await Worker.prototype.terminate.call(stalled);
  await exited;
  session.messages.push({ role: 'assistant', content: 'x4' });
  assert.equal(await within(saveSessionDurably(session), 5_000, 'the session never saved again'), SAVE_OUTCOME_SAVED);
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, 'sessions', `${id}.json`), 'utf8')).messages.map((m) => m.content),
    ['x1', 'x2', 'x3', 'x4']
  );
  assert.equal(getSessionSaveError(id), null);
});

test('close, detach, delete and a writer release behind a stalled worker that never exits fail within the hung bound, then succeed after its exit', async (t) => {
  const id = 'sess_save_worker_exit_withheld_lifecycle';
  const path = join(root, 'sessions', `${id}.json`);
  const session = { id, owner: 'user', generation: 0, closed: false, messages: [{ role: 'user', content: 'y1' }] };
  await saveSessionDurably(session);
  assert.equal(_setSaveWorkerHungMsForTest(300), true);
  t.after(() => {
    _setSaveWorkerHungMsForTest(null);
    setSessionSaveFault(null);
  });

  // The worker stops inside its commit, and its termination never completes.
  const stalled = _saveWorkerForTest();
  stalled.terminate = () => new Promise(() => {});
  assert.equal(setSessionSaveFault({ ids: id, stall: 'before-rename' }), true);
  session.messages.push({ role: 'assistant', content: 'y2' });
  await within(
    assert.rejects(saveSessionDurably(session), { code: 'ESAVEWORKERHUNG' }),
    5_000,
    'the durable save on a stalled worker is still pending'
  );
  setSessionSaveFault(null);

  // Each operation waits on the commit lock the stalled worker holds.
  const stranded = () => getSessionLifecycleCommitError(id)?.code;
  assert.equal(await within(bumpSessionGeneration(id, 'stranded-detach'), 5_000, 'the detach is still pending'), null);
  assert.equal(stranded(), 'ESAVEWORKERHUNG');
  assert.equal(await within(markSessionClosed(id, 'stranded-close'), 5_000, 'the close is still pending'), null);
  assert.equal(stranded(), 'ESAVEWORKERHUNG');
  assert.equal(await within(deleteSession(id), 5_000, 'the delete is still pending'), false);
  assert.equal(stranded(), 'ESAVEWORKERHUNG');
  // Letting the writer lock go waits on that commit too: refused, reported,
  // and the claim stays this process's.
  clearSessionLifecycleCommitError(id);
  assert.equal(await within(releaseSessionWriter(id), 5_000, 'the writer release is still pending'), false);
  assert.equal(stranded(), 'ESAVEWORKERHUNG', 'the writer release reports why it kept the claim');
  assert.equal(sessionWriterHeldHere(id), true);
  // Nothing was marked or removed while the commit lock stays held.
  const untouched = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(untouched.closed, false);
  assert.equal(untouched.generation, 0);
  assert.deepEqual(
    untouched.messages.map((m) => m.content),
    ['y1']
  );

  // Once it really exits, the same operations land: healthy work, so under the
  // real hung bound (see the first test).
  _setSaveWorkerHungMsForTest(null);
  const exited = once(stalled, 'exit');
  await Worker.prototype.terminate.call(stalled);
  await exited;
  assert.equal(typeof (await within(bumpSessionGeneration(id, 'detach'), 5_000, 'the detach never landed')), 'number');
  assert.equal(typeof (await within(markSessionClosed(id, 'close'), 5_000, 'the close never landed')), 'number');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).closed, true);
  assert.equal(await within(deleteSession(id), 5_000, 'the delete never landed'), true);
  assert.equal(existsSync(path), false);
});
