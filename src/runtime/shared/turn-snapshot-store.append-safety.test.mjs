import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  _setTurnChangeRecordWriteHookForTest,
  _setTurnSnapshotStoreRootForTest,
  loadTurnChangeRecords,
  upsertTurnChangeRecord,
} from './turn-snapshot-store.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-turn-store-append-'));
_setTurnSnapshotStoreRootForTest(dir);
test.after(() => {
  _setTurnChangeRecordWriteHookForTest(null);
  _setTurnSnapshotStoreRootForTest('');
  rmSync(dir, { recursive: true, force: true });
});

const hash = (sessionId) => createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
const appendable = (sessionId) => join(dir, 'changes', `${hash(sessionId)}.jsonl`);
const legacy = (sessionId) => join(dir, 'changes', `${hash(sessionId)}.json`);
const file = (path, patch = 'p') => ({ path, status: 'M', additions: 1, deletions: 1, revertable: false, patch });
const upsert = (sessionId, checkpointId, patch) =>
  upsertTurnChangeRecord(sessionId, { checkpointId, kind: 'tracked', root: dir, files: [file('a.txt', patch)] });
const ids = async (sessionId) => {
  _setTurnSnapshotStoreRootForTest(dir); // a restart: nothing cached
  return (await loadTurnChangeRecords(sessionId)).map((record) => record.checkpointId);
};

test('an upsert that evicts older turns is visible whole or not at all when interrupted', async () => {
  const huge = 'y'.repeat(9 * 1024 * 1024);
  for (const checkpointId of ['cp-1', 'cp-2', 'cp-3']) await upsert('torn', checkpointId, huge);
  const before = readFileSync(appendable('torn'));
  await upsert('torn', 'cp-4', huge);
  const after = readFileSync(appendable('torn'));
  assert.deepEqual(await ids('torn'), ['cp-2', 'cp-3', 'cp-4']);
  const tail = after.subarray(before.length);
  const cuts = new Set([1, 2, tail.length >> 1, tail.length - 1]);
  tail.forEach((byte, index) => {
    if (byte === 0x0a) {
      cuts.add(index);
      cuts.add(index + 1);
    }
  });
  for (const cut of cuts) {
    writeFileSync(appendable('torn'), after.subarray(0, before.length + cut));
    assert.deepEqual(await ids('torn'), ['cp-1', 'cp-2', 'cp-3'], `a write cut after ${cut} bytes publishes nothing`);
  }
});

test('a second writer between this process\'s read and append never leaves stale cached records', async () => {
  await upsert('two', 'cp-1');
  await upsert('two', 'cp-2');
  let other = 0;
  _setTurnChangeRecordWriteHookForTest(() => {
    if (other++) return;
    const put = { checkpointId: 'cp-other', kind: 'tracked', root: dir, files: [file('o.txt')], createdAt: 1, revision: 1 };
    appendFileSync(appendable('two'), `\n${JSON.stringify({ put, evict: [] })}`);
  });
  await upsert('two', 'cp-3');
  _setTurnChangeRecordWriteHookForTest(null);
  const warm = (await loadTurnChangeRecords('two')).map((record) => record.checkpointId).sort();
  assert.deepEqual(warm, ['cp-1', 'cp-2', 'cp-3', 'cp-other']);
  assert.deepEqual((await ids('two')).sort(), warm);
});

test('the previous version reads everything or sees nothing of files written now', async () => {
  for (const checkpointId of ['cp-1', 'cp-2', 'cp-3']) await upsert('down', checkpointId);
  const previousRead = () => {
    if (!existsSync(legacy('down'))) return [];
    return JSON.parse(readFileSync(legacy('down'), 'utf8')).records.map((record) => record.checkpointId);
  };
  const seen = previousRead();
  assert.ok(seen.length === 0 || seen.length === 3, 'never a partial view');
  // The previous version's own upsert rewrites its file; ours stays intact.
  mkdirSync(join(dir, 'changes'), { recursive: true });
  writeFileSync(
    legacy('down'),
    JSON.stringify({ version: 1, sessionId: 'down', records: [{ checkpointId: 'old', kind: 'tracked', root: dir, files: [], createdAt: 5 }] })
  );
  assert.deepEqual((await ids('down')).sort(), ['cp-1', 'cp-2', 'cp-3']);
});

test('a file of the previous format is read as-is and migrated by the next write', async () => {
  mkdirSync(join(dir, 'changes'), { recursive: true });
  const records = ['a', 'b'].map((checkpointId, index) => ({
    checkpointId,
    kind: 'tracked',
    root: dir,
    files: [file('a.txt')],
    revision: 1,
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
  writeFileSync(legacy('old'), JSON.stringify({ version: 1, sessionId: 'old', records }));
  assert.deepEqual(await ids('old'), ['a', 'b']);
  await upsert('old', 'c');
  assert.deepEqual(await ids('old'), ['a', 'b', 'c']);
  assert.equal(existsSync(legacy('old')), false);
});
