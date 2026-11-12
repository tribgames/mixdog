import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as main from './turn-snapshot-store.mjs';

// Two module instances stand for two processes: separate write chains and
// caches, one shared directory and one cross-process file lock.
const dir = mkdtempSync(join(tmpdir(), 'mixdog-turn-store-exclusive-'));
const instances = [await import('./turn-snapshot-store.mjs?writer-a'), await import('./turn-snapshot-store.mjs?writer-b')];
for (const store of [main, ...instances]) store._setTurnSnapshotStoreRootForTest(dir);
test.after(() => {
  for (const store of [main, ...instances]) {
    store._setTurnChangeRecordWriteHookForTest(null);
    store._setTurnSnapshotStoreRootForTest('');
  }
  rmSync(dir, { recursive: true, force: true });
});

const [a, b] = instances;
const hash = (sessionId) => createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
const appendable = (sessionId) => join(dir, 'changes', `${hash(sessionId)}.jsonl`);
const legacy = (sessionId) => join(dir, 'changes', `${hash(sessionId)}.json`);
const file = (path, patch = 'p') => ({ path, status: 'M', additions: 1, deletions: 1, revertable: true, patch });
const upsert = (store, sessionId, checkpointId, patch, root = dir) =>
  store.upsertTurnChangeRecord(sessionId, { checkpointId, kind: 'tracked', root, files: [file('a.txt', patch)] });
const ids = async (sessionId) => {
  main._setTurnSnapshotStoreRootForTest(dir); // a restart: nothing cached
  return (await main.loadTurnChangeRecords(sessionId)).map((record) => record.checkpointId).sort();
};
const turns = (names) =>
  names.map((checkpointId, index) => ({
    checkpointId,
    kind: 'tracked',
    root: dir,
    files: [file('a.txt')],
    revision: 1,
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
const writeLegacy = (sessionId, records) => {
  mkdirSync(join(dir, 'changes'), { recursive: true });
  writeFileSync(legacy(sessionId), JSON.stringify({ version: 1, sessionId, records }));
};
const ticks = async (count) => {
  for (let index = 0; index < count; index++) await new Promise((resolve) => setImmediate(resolve));
};

test('two writers of one session appending large lines at once keep both turns whole', async () => {
  await upsert(a, 'big', 'base', 'x');
  let arrived = 0;
  const meet = async () => {
    arrived++;
    for (let index = 0; index < 200 && arrived < 2; index++) await ticks(1);
  };
  a._setTurnChangeRecordWriteHookForTest(meet);
  b._setTurnChangeRecordWriteHookForTest(meet);
  const first = upsert(a, 'big', 'w1', 'p'.repeat(2 * 1024 * 1024));
  const second = upsert(b, 'big', 'w2', 'q'.repeat(2 * 1024 * 1024));
  await Promise.all([first, second]);
  assert.deepEqual(await ids('big'), ['base', 'w1', 'w2']);
});

test('a migrator delayed across another migration and its appends loses nothing', async () => {
  writeLegacy('mig', turns(['old-1', 'old-2']));
  let release;
  let entered;
  const gate = new Promise((resolve) => (release = resolve));
  const inside = new Promise((resolve) => (entered = resolve));
  let once = true;
  a._setTurnChangeRecordWriteHookForTest(async () => {
    if (!once) return;
    once = false;
    entered();
    await gate;
  });
  b._setTurnChangeRecordWriteHookForTest(null);
  const slow = upsert(a, 'mig', 'from-a');
  await inside;
  const fast = (async () => {
    await upsert(b, 'mig', 'from-b-1');
    await upsert(b, 'mig', 'from-b-2');
  })();
  await ticks(50);
  release();
  await Promise.all([slow, fast]);
  assert.deepEqual(await ids('mig'), ['from-a', 'from-b-1', 'from-b-2', 'old-1', 'old-2']);
  assert.equal(existsSync(legacy('mig')), false);
});

test('forgetting a root that only the previous-format file holds marks its records', async () => {
  const other = join(dir, 'other-root');
  await upsert(main, 'down', 'kept', 'p', dir);
  writeLegacy('down', [{ ...turns(['old'])[0], root: other }]);
  const result = await main.forgetTurnSnapshotRoot(other);
  assert.equal(result.removed.length, 1);
  const [record] = JSON.parse(readFileSync(legacy('down'), 'utf8')).records;
  assert.equal(record.files[0].revertable, false);
  assert.equal(record.files[0].patch, null);
  const current = (await main.loadTurnChangeRecords('down')).find((entry) => entry.checkpointId === 'kept');
  assert.equal(current.files[0].revertable, true);
});

test('an upsert whose line the file does not show whole fails and leaves nothing of it in the file', async (t) => {
  await upsert(main, 'short', 'one');
  const before = readFileSync(appendable('short'));
  const probe = await open(appendable('short'), 'r');
  const handles = Object.getPrototypeOf(probe);
  await probe.close();
  const read = handles.read;
  // The read-back of the appended line comes one byte short.
  handles.read = async function (...args) {
    handles.read = read;
    const result = await read.apply(this, args);
    return { ...result, bytesRead: result.bytesRead - 1 };
  };
  t.after(() => {
    handles.read = read;
  });
  await assert.rejects(upsert(main, 'short', 'two'), /not written whole/);
  assert.deepEqual(readFileSync(appendable('short')), before);
  await upsert(main, 'short', 'three');
  assert.deepEqual(await ids('short'), ['one', 'three']);
});

test('a line that does not parse in the middle of the file costs only that upsert', async () => {
  await upsert(main, 'dmg', 'one');
  appendFileSync(appendable('dmg'), '\n{"put":{"checkpointId":"lost"');
  await upsert(main, 'dmg', 'two');
  assert.deepEqual(await ids('dmg'), ['one', 'two']);
});
