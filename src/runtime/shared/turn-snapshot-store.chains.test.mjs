// The per-session write chain only orders writes still in flight: once a
// session's writes settle, its entry goes, so a long-lived process does not
// keep one per session it ever recorded.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  _setTurnSnapshotStoreRootForTest,
  _turnSnapshotWriteChainCountForTest,
  loadTurnSnapshotRecord,
  saveTurnSnapshotRecord,
} from './turn-snapshot-store.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-turn-store-chains-'));
_setTurnSnapshotStoreRootForTest(dir);
test.after(() => {
  _setTurnSnapshotStoreRootForTest('');
  rmSync(dir, { recursive: true, force: true });
});

const record = (generation) => ({
  root: join(dir, 'worktree'),
  generation,
  baselineTree: String(generation).repeat(40).slice(0, 40),
  toolFiles: ['f.txt'],
});

test('settled write chains are released per session', async () => {
  const sessions = Array.from({ length: 50 }, (_, index) => `chain-${index}`);
  await Promise.all(
    sessions.flatMap((id) => [saveTurnSnapshotRecord(id, record(1)), saveTurnSnapshotRecord(id, record(2))])
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(_turnSnapshotWriteChainCountForTest(), 0);
  // Ordering still held while they were queued: the later write won.
  for (const id of sessions) assert.equal((await loadTurnSnapshotRecord(id)).generation, 2);
});
