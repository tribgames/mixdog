// Own-commit stamps shared between the parent realm and the save worker: a
// check that runs after the worker renamed a file but before its reply is
// processed must be answered from the stamp, while every foreign or barrier
// rewrite still takes the strict full read.
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-own-commit-peer-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'));

const { saveSessionAsync, loadSession, bumpSessionGeneration } = await import('../store.mjs');
const { _sessionWriteAuthorityRefusal, _shouldDrop } = await import('./write-admission.mjs');
const { statSessionStamp, sameSessionStamp } = await import('./canonical-reader.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  rmSync(root, { recursive: true, force: true });
});

const sessionFile = (id) => join(root, 'sessions', `${id}.json`);

function makeSession(id) {
  return { id, generation: 1, closed: false, messages: [{ role: 'user', content: 'x'.repeat(64 * 1024) }] };
}

// Counts whole-file reads of one path on this (parent) thread.
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

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Block this thread (no event-loop turn, so no worker reply can be processed)
// until the worker has renamed a new file over `path`, then give it a moment
// to publish its commit stamp.
function waitForWorkerCommit(path, previous) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    let current = null;
    try {
      current = statSessionStamp(path);
    } catch {
      /* mid-rename */
    }
    if (current && !sameSessionStamp(current, previous)) break;
    if (Date.now() > deadline) throw new Error('the save worker never committed');
    sleepSync(1);
  }
  sleepSync(50);
}

test('pipelined saves answer every in-flight ownership check from the worker commit stamp', async (t) => {
  const id = 'sess_own_commit_pipelined';
  const path = sessionFile(id);
  const session = makeSession(id);
  await saveSessionAsync(session, { expectedGeneration: 1 });
  const reads = countReads(t, path);
  for (let round = 0; round < 8; round++) {
    const before = statSessionStamp(path);
    session.messages = [...session.messages, { role: 'assistant', content: `reply ${round}` }];
    const landing = saveSessionAsync(session, { expectedGeneration: 1 });
    waitForWorkerCommit(path, before);
    // The file is the worker's new commit; the reply is still unprocessed.
    assert.equal(_sessionWriteAuthorityRefusal(id), null);
    assert.equal(_shouldDrop(id, { expectedGeneration: 1 }), false);
    assert.equal(loadSession(id), session);
    // The next save's pre-admission runs in the same window and coalesces.
    session.messages = [...session.messages, { role: 'user', content: `ask ${round}` }];
    const queued = saveSessionAsync(session, { expectedGeneration: 1 });
    await Promise.all([landing, queued]);
  }
  assert.equal(reads.count, 0, 'no whole-file read for bytes this process wrote');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).messages.length, 17);
});

test('a foreign replacement landing right after the worker commit is read strictly and refused', async (t) => {
  const id = 'sess_own_commit_foreigna';
  const foreignId = 'sess_own_commit_foreignb';
  const path = sessionFile(id);
  const session = makeSession(id);
  await saveSessionAsync(session, { expectedGeneration: 1 });
  const before = statSessionStamp(path);
  session.messages = [...session.messages, { role: 'assistant', content: 'reply' }];
  const landing = saveSessionAsync(session, { expectedGeneration: 1 });
  waitForWorkerCommit(path, before);
  // Another writer renames a same-size record for another session over the
  // file while the worker's commit stamp is still queued for this realm.
  const foreign = readFileSync(path, 'utf8').replace(JSON.stringify(id), JSON.stringify(foreignId));
  writeFileSync(`${path}.foreign`, foreign);
  renameSync(`${path}.foreign`, path);
  const reads = countReads(t, path);
  assert.equal(_sessionWriteAuthorityRefusal(id), 'foreign');
  assert.ok(reads.count >= 1, 'the foreign file was read strictly');
  await assert.rejects(saveSessionAsync(session, { expectedGeneration: 1 }), { code: 'ESESSIONNOTOWNED' });
  await landing;
  const again = reads.count;
  assert.equal(_sessionWriteAuthorityRefusal(id), 'foreign');
  assert.equal(loadSession(id), null);
  assert.ok(reads.count > again, 'no verdict is ever cached for the foreign bytes');
  assert.equal(readFileSync(path, 'utf8'), foreign);
});

test('a lifecycle barrier rewrite after worker saves is read strictly in both realms', async (t) => {
  const id = 'sess_own_commit_barrier';
  const path = sessionFile(id);
  const session = makeSession(id);
  await saveSessionAsync(session, { expectedGeneration: 1 });
  assert.equal(bumpSessionGeneration(id), 2);
  const reads = countReads(t, path);
  assert.equal(_shouldDrop(id, { expectedGeneration: 1 }), true);
  assert.ok(reads.count >= 1, 'the barrier rewrite was read strictly');
  // The worker realm refuses the stale write under its own strict read.
  session.messages = [...session.messages, { role: 'assistant', content: 'stale' }];
  await saveSessionAsync(session, { expectedGeneration: 1 });
  const disk = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(disk.generation, 2);
  assert.equal(disk.messages.length, 1);
});
