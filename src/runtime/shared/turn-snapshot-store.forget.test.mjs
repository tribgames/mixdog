import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  loadTurnSnapshotRecord,
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

test('clearSessionChangeHistory removes a review summary an earlier version left behind', async () => {
  await saveTurnSnapshotRecord('sum1', turn(rootA, 1, '3'.repeat(40)));
  const hash = createHash('sha256').update('sum1').digest('hex').slice(0, 24);
  const summary = join(dir, 'review-summaries', `${hash}.json`);
  mkdirSync(dirname(summary), { recursive: true });
  writeFileSync(summary, JSON.stringify({ sessionId: 'sum1', files: [{ path: 'f.txt' }] }));

  await clearSessionChangeHistory('sum1');
  assert.equal(existsSync(summary), false);
  assert.equal(await sessionChangeHistoryCleared('sum1'), true);
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
