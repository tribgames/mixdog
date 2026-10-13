import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { storedChangeFile, turnChangesReply } from './turn-changes.mjs';
import {
  _setTurnSnapshotStoreRootForTest,
  REMOVED_WORKTREE_CHANGE_REASON,
  forgetTurnSnapshotRoot,
  loadSessionSnapshotRecords,
  loadTurnChangeRecord,
  loadTurnSnapshotRecord,
  saveTurnSnapshotRecord,
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
