import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  _setTurnSnapshotStoreRootForTest,
  loadTurnChangeRecord,
  loadTurnChangeRecords,
  updateTurnChangeRecord,
  upsertTurnChangeRecord,
} from './turn-snapshot-store.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-turn-store-cache-'));
_setTurnSnapshotStoreRootForTest(dir);

// Counts the parses of change files (large documents), not small side files.
const realParse = JSON.parse;
let bigParses = 0;
JSON.parse = (text, ...rest) => {
  if (typeof text === 'string' && text.length > 20_000) bigParses += 1;
  return realParse(text, ...rest);
};
test.after(() => {
  JSON.parse = realParse;
  _setTurnSnapshotStoreRootForTest('');
  rmSync(dir, { recursive: true, force: true });
});

const bigFile = (path) => ({ path, status: 'M', additions: 1, deletions: 1, revertable: false, patch: 'x'.repeat(30_000) });
const seed = async (sessionId, checkpointIds = ['cp-1', 'cp-2']) => {
  for (const checkpointId of checkpointIds) {
    await upsertTurnChangeRecord(sessionId, { checkpointId, kind: 'tracked', root: dir, files: [bigFile('a.txt')] });
  }
};

test('concurrent and repeated record reads parse the changes file once', async () => {
  await seed('shared');
  bigParses = 0;
  const reads = await Promise.all(
    Array.from({ length: 15 }, (_, index) => loadTurnChangeRecord('shared', index % 2 ? 'cp-1' : 'cp-2'))
  );
  assert.ok(reads.every(Boolean));
  assert.equal((await loadTurnChangeRecords('shared')).length, 2);
  assert.equal((await loadTurnChangeRecord('shared', 'cp-1')).checkpointId, 'cp-1');
  assert.equal(bigParses, 1);
});

test('a write is never served stale', async () => {
  await seed('writes');
  const before = await loadTurnChangeRecord('writes', 'cp-1');
  await updateTurnChangeRecord('writes', 'cp-1', (record) => record.files.map((file) => ({ ...file, state: 'reverted' })));
  const after = await loadTurnChangeRecord('writes', 'cp-1');
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.files[0].state, 'reverted');
  assert.equal(before.files[0].state, 'applied');
  await upsertTurnChangeRecord('writes', { checkpointId: 'cp-3', kind: 'tracked', root: dir, files: [bigFile('b.txt')] });
  assert.equal(await loadTurnChangeRecord('writes', 'cp-3').then((record) => record.checkpointId), 'cp-3');
});

test('mutating a read record does not leak into the next read', async () => {
  await seed('mutate', ['cp-1']);
  const first = await loadTurnChangeRecord('mutate', 'cp-1');
  for (const mutate of [
    () => {
      first.files[0].state = 'reverted';
    },
    () => first.files.push({ path: 'z.txt' }),
    () => {
      first.revision = 99;
    },
  ]) {
    try {
      mutate();
    } catch {
      // A frozen record refuses the write; either way the next read is unchanged.
    }
  }
  const second = await loadTurnChangeRecord('mutate', 'cp-1');
  assert.equal(second.revision, 1);
  assert.deepEqual(
    second.files.map((file) => [file.path, file.state]),
    [['a.txt', 'applied']]
  );
});

test('a failed read is not served after the file recovers', async () => {
  await seed('recover', ['cp-1']);
  const file = join(dir, 'changes', `${createHash('sha256').update('recover').digest('hex').slice(0, 24)}.json`);
  const good = readFileSync(file);
  const stamp = new Date('2024-01-01T00:00:00Z');
  // Same size and mtime: the signature cannot tell the broken file from the good one.
  writeFileSync(file, Buffer.alloc(good.length, 'x'));
  utimesSync(file, stamp, stamp);
  assert.equal(await loadTurnChangeRecord('recover', 'cp-1'), null);
  writeFileSync(file, good);
  utimesSync(file, stamp, stamp);
  assert.equal((await loadTurnChangeRecord('recover', 'cp-1'))?.checkpointId, 'cp-1');
});

test('the cache is bounded by session count', async () => {
  const sessions = Array.from({ length: 10 }, (_, index) => `bound-${index}`);
  for (const sessionId of sessions) await seed(sessionId, ['cp-1']);
  for (const sessionId of sessions) await loadTurnChangeRecords(sessionId);
  bigParses = 0;
  await loadTurnChangeRecords(sessions.at(-1));
  assert.equal(bigParses, 0, 'the newest session stays cached');
  await loadTurnChangeRecords(sessions[0]);
  assert.equal(bigParses, 1, 'the oldest session was evicted');
});
