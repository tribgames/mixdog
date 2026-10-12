import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  _setTurnSnapshotStoreRootForTest,
  forgetTurnSnapshotRoot,
  loadSessionSnapshotRecords,
  loadTurnSnapshotRecord,
  saveTurnSnapshotRecord,
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
