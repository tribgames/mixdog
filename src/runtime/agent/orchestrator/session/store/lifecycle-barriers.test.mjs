// Detach barrier (bumpSessionGeneration) authority: bytes this realm renamed
// into place are vouched for by the own-commit stamp instead of a strict full
// read, while every foreign or ambiguous replacement is still read strictly
// and refused, the written bytes are identical on both paths, and an
// in-flight save never lands after the barrier.
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-lifecycle-barriers-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'));

const { saveSessionAsync, bumpSessionGeneration, getSessionLifecycleCommitError } = await import('../store.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  rmSync(root, { recursive: true, force: true });
});

const sessionFile = (id) => join(root, 'sessions', `${id}.json`);

function makeSession(id) {
  return { id, generation: 1, closed: false, messages: [{ role: 'user', content: 'x'.repeat(256 * 1024) }] };
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

function replaceWith(path, text) {
  writeFileSync(`${path}.other`, text);
  renameSync(`${path}.other`, path);
}

test('a detach bump over our own commit skips the full read and writes the same bytes as the strict path', async (t) => {
  const ownId = 'sess_barrier_equiv_own';
  const coldId = 'sess_barrier_equiv_cld';
  await saveSessionAsync(makeSession(ownId), { expectedGeneration: 1 });
  // The same record, but not renamed into place by this realm: strict path.
  replaceWith(
    sessionFile(coldId),
    readFileSync(sessionFile(ownId), 'utf8').replace(JSON.stringify(ownId), JSON.stringify(coldId))
  );
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  const ownReads = countReads(t, sessionFile(ownId));
  const coldReads = countReads(t, sessionFile(coldId));
  assert.equal(bumpSessionGeneration(ownId), 2);
  assert.equal(ownReads.count, 0, 'own-commit bytes are not re-read');
  assert.equal(bumpSessionGeneration(coldId), 2);
  assert.ok(coldReads.count >= 1, 'bytes of unknown origin are read strictly');
  assert.equal(
    readFileSync(sessionFile(ownId), 'utf8').replace(JSON.stringify(ownId), JSON.stringify(coldId)),
    readFileSync(sessionFile(coldId), 'utf8')
  );
  assert.equal(getSessionLifecycleCommitError(ownId), null);
});

test('a foreign replacement of our own commit is read strictly and the detach bump is refused', async () => {
  const id = 'sess_barrier_foreign_a';
  const path = sessionFile(id);
  await saveSessionAsync(makeSession(id), { expectedGeneration: 1 });
  const foreign = readFileSync(path, 'utf8').replace(JSON.stringify(id), JSON.stringify('sess_barrier_foreign_b'));
  replaceWith(path, foreign);
  assert.equal(bumpSessionGeneration(id), null);
  assert.equal(getSessionLifecycleCommitError(id)?.code, 'ELIFECYCLEUNREADABLE');
  assert.equal(readFileSync(path, 'utf8'), foreign, 'the foreign record is untouched');
});

test('an ambiguous (duplicate-key) replacement of our own commit refuses the detach bump', async () => {
  const id = 'sess_barrier_ambiguous';
  const path = sessionFile(id);
  await saveSessionAsync(makeSession(id), { expectedGeneration: 1 });
  const ambiguous = `{"generation":9,${readFileSync(path, 'utf8').slice(1)}`;
  replaceWith(path, ambiguous);
  assert.equal(bumpSessionGeneration(id), null);
  assert.equal(getSessionLifecycleCommitError(id)?.code, 'ELIFECYCLEUNREADABLE');
  assert.equal(readFileSync(path, 'utf8'), ambiguous);
});

test('read-only lifecycle checks after a barrier reuse what it wrote; a foreign change is read strictly', async (t) => {
  const { readSessionLifecycleStateFromDisk } = await import('../store.mjs');
  const { _shouldDrop } = await import('./write-admission.mjs');
  const id = 'sess_barrier_lifecycle_reads';
  const path = sessionFile(id);
  await saveSessionAsync(makeSession(id), { expectedGeneration: 1 });
  assert.equal(bumpSessionGeneration(id), 2);
  const reads = countReads(t, path);
  for (let round = 0; round < 3; round++) {
    assert.deepEqual(readSessionLifecycleStateFromDisk(id), { state: 'open', generation: 2 });
  }
  assert.equal(reads.count, 0, 'pending-message gates right after a detach read nothing');
  assert.equal(_shouldDrop(id, { expectedGeneration: 1 }), true);
  assert.equal(reads.count, 1, 'write authority still reads the barrier rewrite strictly');
  replaceWith(path, readFileSync(path, 'utf8').replace(JSON.stringify(id), JSON.stringify('sess_barrier_lifecycle_x')));
  assert.equal(readSessionLifecycleStateFromDisk(id).state, 'unreadable');
  assert.equal(reads.count, 3, 'the foreign replacement was read strictly (test read + check)');
});

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('a save in flight when the detach bump lands is never written after it and loses nothing', async () => {
  for (let round = 0; round < 6; round++) {
    const id = `sess_barrier_inflight_${round}`;
    const path = sessionFile(id);
    const session = makeSession(id);
    await saveSessionAsync(session, { expectedGeneration: 1 });
    session.messages = [...session.messages, { role: 'assistant', content: `reply ${round}` }];
    const landing = saveSessionAsync(session, { expectedGeneration: 1 });
    // Land the barrier at different points of the worker's write/rename.
    if (round > 0) sleepSync(round * 3);
    assert.equal(bumpSessionGeneration(id), 2);
    await Promise.allSettled([landing]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const disk = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(disk.generation, 2, `round ${round}: the barrier is the last write`);
    assert.equal(disk.detachedReason, 'detach');
    assert.equal(disk.messages.length, 2, `round ${round}: the in-flight content is kept`);
  }
});
