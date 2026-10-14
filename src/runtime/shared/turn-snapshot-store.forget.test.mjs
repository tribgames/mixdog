import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { storedChangeFile, turnChangesReply } from './turn-changes.mjs';
import {
  _setTurnSnapshotStoreRootForTest,
  REMOVED_WORKTREE_CHANGE_REASON,
  clearSessionChangeHistory,
  forgetSessionChangeHistoryMarker,
  forgetTurnSnapshotRoot,
  loadSessionSnapshotRecords,
  loadTurnChangeRecord,
  loadTurnChangeRecords,
  loadTurnReviewSummary,
  loadTurnSnapshotRecord,
  saveTurnReviewSummary,
  saveTurnSnapshotRecord,
  sessionChangeHistoryCleared,
  updateTurnChangeRecord,
  upsertTurnChangeRecord,
} from './turn-snapshot-store.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-turn-store-forget-'));
_setTurnSnapshotStoreRootForTest(dir);
test.after(() => {
  _setTurnSnapshotStoreRootForTest('');
  rmSync(dir, { recursive: true, force: true });
});

const rootA = join(dir, 'worktrees', 'a');
const rootB = join(dir, 'worktrees', 'b');
const turn = (root, generation, tree) => ({
  root,
  generation,
  baselineTree: tree,
  toolFiles: ['f.txt'],
});

test('forgetTurnSnapshotRoot removes only the target root from session records', async () => {
  await saveTurnSnapshotRecord('s1', turn(rootA, 1, 'a'.repeat(40)));
  await saveTurnSnapshotRecord('s1', turn(rootB, 2, 'b'.repeat(40)));
  await saveTurnSnapshotRecord('s2', turn(rootA, 1, 'c'.repeat(40)));
  assert.equal(readdirSync(dir).filter((name) => name.endsWith('.json')).length, 2);

  const result = await forgetTurnSnapshotRoot(process.platform === 'win32' ? rootA.toUpperCase() : `${rootA}/`);
  assert.equal(result.removed.length, 2);
  assert.deepEqual(result.kept, []);

  // s1 keeps its other root and history; s2 had nothing else, so it is gone.
  const scopes = await loadSessionSnapshotRecords('s1');
  assert.deepEqual(
    scopes.map((scope) => scope.root),
    [rootB]
  );
  assert.equal((await loadTurnSnapshotRecord('s1')).root, rootB);
  assert.equal(await loadTurnSnapshotRecord('s2'), null);
  assert.equal(readdirSync(dir).filter((name) => name.endsWith('.json')).length, 1);

  // Idempotent, and an unrelated root changes nothing.
  assert.deepEqual(await forgetTurnSnapshotRoot(rootA), { removed: [], kept: [] });
  assert.deepEqual(await forgetTurnSnapshotRoot(join(dir, 'worktrees', 'other')), { removed: [], kept: [] });
  assert.equal((await loadSessionSnapshotRecords('s1')).length, 1);
});

test('forgetTurnSnapshotRoot tolerates a missing store directory', async () => {
  _setTurnSnapshotStoreRootForTest(join(dir, 'missing'));
  assert.deepEqual(await forgetTurnSnapshotRoot(rootA), { removed: [], kept: [] });
  assert.equal(existsSync(join(dir, 'missing')), false);
  _setTurnSnapshotStoreRootForTest(dir);
});

test("forgetTurnSnapshotRoot marks the removed root's change records unavailable, only those", async () => {
  const changeFile = (path, state) => ({
    ...storedChangeFile({
      path,
      status: 'M',
      additions: 1,
      deletions: 1,
      revertable: true,
      patch: Buffer.from(`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`),
    }),
    state,
  });
  const upsert = async (sessionId, checkpointId, root) => {
    await upsertTurnChangeRecord(sessionId, { checkpointId, kind: 'git', root, files: [changeFile('a.txt')] });
    // A file the user already undid: the card would offer Reapply for it.
    return await updateTurnChangeRecord(sessionId, checkpointId, (record) => [
      ...record.files,
      changeFile('b.txt', 'reverted'),
    ]);
  };
  const reply = (record) => turnChangesReply({ status: 'ready', checkpointId: record.checkpointId, record });
  const before = await upsert('c1', 'cp-a', rootA);
  await upsert('c1', 'cp-b', rootB);
  await upsert('c2', 'cp-a', rootA);
  assert.equal(reply(before).canUndo, true);
  assert.equal(reply(before).canReapply, true);

  const result = await forgetTurnSnapshotRoot(process.platform === 'win32' ? rootA.toUpperCase() : `${rootA}/`);
  assert.equal(result.removed.filter((entry) => entry.endsWith('#cp-a')).length, 2);
  assert.deepEqual(result.kept, []);

  for (const sessionId of ['c1', 'c2']) {
    const record = await loadTurnChangeRecord(sessionId, 'cp-a');
    assert.equal(record.revision, before.revision + 1);
    assert.equal(record.root, rootA);
    const card = reply(record);
    // The history card still lists the files, but offers neither Undo nor Reapply.
    assert.deepEqual(
      card.files.map((file) => [file.path, file.state, file.revertable, file.reason]),
      [
        ['a.txt', 'applied', false, REMOVED_WORKTREE_CHANGE_REASON],
        ['b.txt', 'reverted', false, REMOVED_WORKTREE_CHANGE_REASON],
      ]
    );
    assert.equal(card.canUndo, false);
    assert.equal(card.canReapply, false);
    assert.match(card.reason, /its worktree was removed/);
    // The removed worktree's contents (the patches) are gone from the store.
    assert.ok(record.files.every((file) => file.patch === null && !('patchEncoding' in file)));
    assert.equal(turnChangesReply({ status: 'ready', checkpointId: 'cp-a', record, patch: true }).patch, '');
  }
  const other = await loadTurnChangeRecord('c1', 'cp-b');
  assert.equal(other.revision, before.revision);
  assert.equal(reply(other).canUndo, true);
  assert.equal(reply(other).canReapply, true);

  // Idempotent: an already unavailable record is not rewritten again.
  assert.deepEqual(await forgetTurnSnapshotRoot(rootA), { removed: [], kept: [] });
  assert.equal((await loadTurnChangeRecord('c1', 'cp-a')).revision, before.revision + 1);
});

test("clearSessionChangeHistory deletes only that session's baselines and change records, and is marked", async () => {
  const file = storedChangeFile({ path: 'f.txt', status: 'M', additions: 1, deletions: 0, revertable: false });
  for (const sessionId of ['h1', 'h2']) {
    await saveTurnSnapshotRecord(sessionId, turn(rootA, 1, 'd'.repeat(40)));
    await upsertTurnChangeRecord(sessionId, { checkpointId: 'cp-1', kind: 'git', root: rootA, files: [file] });
    await upsertTurnChangeRecord(sessionId, { checkpointId: 'cp-2', kind: 'git', root: rootA, files: [file] });
  }
  assert.equal(await sessionChangeHistoryCleared('h1'), false);

  assert.equal(await clearSessionChangeHistory('h1'), 2);
  assert.deepEqual(await loadSessionSnapshotRecords('h1'), []);
  assert.equal(await loadTurnSnapshotRecord('h1'), null);
  assert.deepEqual(await loadTurnChangeRecords('h1'), []);
  assert.equal(await loadTurnChangeRecord('h1', 'cp-1'), null);
  assert.equal(await sessionChangeHistoryCleared('h1'), true);
  // Another session keeps everything.
  assert.equal((await loadSessionSnapshotRecords('h2')).length, 1);
  assert.equal((await loadTurnChangeRecords('h2')).length, 2);
  assert.equal(await sessionChangeHistoryCleared('h2'), false);

  // The next recorded turn starts a fresh scope and ends the cleared state.
  await saveTurnSnapshotRecord('h1', turn(rootB, 1, 'e'.repeat(40)));
  assert.deepEqual(
    (await loadSessionSnapshotRecords('h1')).map((scope) => scope.root),
    [rootB]
  );
  assert.equal(await sessionChangeHistoryCleared('h1'), false);
});

test('clearSessionChangeHistory removes the saved review summary, and a pending summary write cannot restore it', async () => {
  const recorded = turn(rootA, 1, '3'.repeat(40));
  const review = { files: [{ path: 'f.txt', status: 'M', additions: 1, deletions: 0 }] };
  await saveTurnSnapshotRecord('sum1', recorded);
  assert.equal(await saveTurnReviewSummary('sum1', recorded, review), true);
  assert.ok(await loadTurnReviewSummary('sum1', recorded));

  await clearSessionChangeHistory('sum1');
  assert.equal(await loadTurnReviewSummary('sum1', recorded), null);

  // A write issued before the delete finishes, or only after it: neither returns.
  const before = saveTurnReviewSummary('sum1', recorded, review);
  await clearSessionChangeHistory('sum1');
  await before;
  assert.equal(await loadTurnReviewSummary('sum1', recorded), null);
  assert.equal(await saveTurnReviewSummary('sum1', recorded, review), false);
  assert.equal(await loadTurnReviewSummary('sum1', recorded), null);

  // The next recorded turn ends the deletion; its summary is kept again.
  await saveTurnSnapshotRecord('sum1', recorded);
  assert.equal(await saveTurnReviewSummary('sum1', recorded, review), true);
  assert.ok(await loadTurnReviewSummary('sum1', recorded));
});

test('a summary write in another store instance cannot land after the delete', async () => {
  const recorded = turn(rootA, 1, '4'.repeat(40));
  const review = { files: [{ path: 'f.txt', status: 'M', additions: 1, deletions: 0 }] };
  await saveTurnSnapshotRecord('sum2', recorded);
  // A second process: its own module instance (and so its own in-process
  // queues). It stops inside the summary write, after its marker check and
  // before the write, and resumes when told to.
  const storeUrl = new URL('./turn-snapshot-store.mjs', import.meta.url).href;
  const script = `
    const other = await import(${JSON.stringify(storeUrl)});
    other._setTurnSnapshotStoreRootForTest(${JSON.stringify(dir)});
    other._setSummaryWriteHookForTest(async () => {
      console.log('paused');
      await new Promise((resolve) => process.stdin.once('data', resolve));
      process.stdin.pause();
    });
    const saved = await other.saveTurnReviewSummary('sum2', ${JSON.stringify(recorded)}, ${JSON.stringify(review)});
    process.exit(saved === true ? 0 : 3);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', (chunk) => String(chunk).includes('paused') && resolve());
      exited.then((code) => reject(new Error(`child exited early (${code})`)));
    });
    // Between its check and its write the child holds the summary's file lock:
    // this is what a delete in any other process has to wait for.
    const lockHash = createHash('sha256').update('sum2').digest('hex').slice(0, 24);
    const lockPath = join(dir, 'review-summaries', `${lockHash}.json.lock`);
    assert.equal(existsSync(lockPath), true, 'the child holds the lock');
    // The delete starts while the child is in the middle of its write; it can
    // only finish after the child's write, whenever the child is resumed.
    const clearing = clearSessionChangeHistory('sum2');
    child.stdin.write('go\n');
    assert.equal(await exited, 0, 'the child finished its write');
    await clearing;
    assert.equal(await sessionChangeHistoryCleared('sum2'), true);
    assert.equal(await loadTurnReviewSummary('sum2', recorded), null);
  } finally {
    // A failed assertion must not leave the child waiting on its stdin.
    child.kill();
  }
});

test('a deletion marker outlives record retention and goes only with the session', async () => {
  const root = join(dir, 'retention');
  _setTurnSnapshotStoreRootForTest(root);
  try {
    await saveTurnSnapshotRecord('r1', turn(rootA, 1, 'f'.repeat(40)));
    await clearSessionChangeHistory('r1');
    // Everything in the store ages past the 7-day record TTL.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const age = (path) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) age(full);
        else utimesSync(full, old, old);
      }
    };
    await saveTurnSnapshotRecord('stale', turn(rootA, 1, '1'.repeat(40)));
    age(root);
    // The next write runs the (once per process) record sweep; it reaps the
    // stale record but never the deletion marker.
    _setTurnSnapshotStoreRootForTest(root);
    await saveTurnSnapshotRecord('fresh', turn(rootA, 1, '2'.repeat(40)));
    for (let tries = 0; tries < 100 && (await loadTurnSnapshotRecord('stale')); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await loadTurnSnapshotRecord('stale'), null, 'the sweep ran');
    assert.equal(await sessionChangeHistoryCleared('r1'), true);

    // Deleting the session removes it.
    await forgetSessionChangeHistoryMarker('r1');
    assert.equal(await sessionChangeHistoryCleared('r1'), false);
  } finally {
    _setTurnSnapshotStoreRootForTest(dir);
  }
});

test('any new turn change record ends the cleared state, a non-Git one too', async () => {
  const file = storedChangeFile({ path: 'f.txt', status: 'M', additions: 1, deletions: 0, revertable: false });
  await upsertTurnChangeRecord('n1', { checkpointId: 'cp-1', kind: 'tracked', root: rootA, files: [file] });
  await clearSessionChangeHistory('n1');
  assert.equal(await sessionChangeHistoryCleared('n1'), true);
  // A non-Git turn writes no baseline, only its change record.
  await upsertTurnChangeRecord('n1', { checkpointId: 'cp-2', kind: 'tracked', root: rootA, files: [file] });
  assert.equal(await sessionChangeHistoryCleared('n1'), false);
  assert.deepEqual(
    (await loadTurnChangeRecords('n1')).map((record) => record.checkpointId),
    ['cp-2']
  );
});
