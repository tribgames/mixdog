// A turn-changes read that overlaps a seal of its turn — one already writing
// when the read began, or a completion wake's that starts during it — answers
// pending, never "settled" with the record from before that seal.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mixdog-turn-changes-read-')));
const priorDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = join(base, 'data');
after(() => {
  if (priorDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = priorDataDir;
  rmSync(base, { recursive: true, force: true });
});

// A record read can be held after it has read the store, before its caller
// resumes: the window in which a seal can land.
const storeUrl = new URL('./turn-snapshot-store.mjs', import.meta.url).href;
const store = await import(storeUrl);
let afterRecordRead = null;
mock.module(storeUrl, {
  namedExports: {
    ...store,
    async loadTurnChangeRecord(...args) {
      const record = await store.loadTurnChangeRecord(...args);
      const hold = afterRecordRead;
      afterRecordRead = null;
      await hold?.();
      return record;
    },
  },
});
const { beginTurnSnapshot, completeTurnSnapshot, getTurnChanges, recordTurnDiffChanges } = await import(
  './turn-snapshot.mjs'
);

test('a read the seal lands during answers pending, never settled without the sealed record', async () => {
  const worktree = join(base, 'worktree');
  mkdirSync(worktree);
  await beginTurnSnapshot(worktree, 'read-race', { checkpointId: 'cp' });
  writeFileSync(join(worktree, 'a.txt'), 'A\n');
  recordTurnDiffChanges('read-race', [
    { path: join(worktree, 'a.txt'), displayPath: 'a.txt', before: 'a\n', after: 'A\n' },
  ]);

  // The seal's record write waits until the read below has read the store;
  // the seal then lands before that read decides its status.
  let releaseWrite;
  const writeHeld = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  store._setTurnChangeRecordWriteHookForTest(() => writeHeld);
  const sealed = completeTurnSnapshot('read-race');
  afterRecordRead = async () => {
    releaseWrite();
    await sealed;
  };
  const reply = await getTurnChanges('read-race', { checkpointId: 'cp' });
  releaseWrite();
  assert.equal(await sealed, true);
  store._setTurnChangeRecordWriteHookForTest(null);
  assert.equal(reply.status, 'pending');

  const settled = await getTurnChanges('read-race', { checkpointId: 'cp' });
  assert.equal(settled.status, 'ready');
  assert.deepEqual(
    settled.files.map((file) => [file.path, file.state]),
    [['a.txt', 'applied']]
  );
});

test('a read a completion wake reopens the sealed turn during answers pending, never the earlier seal', async () => {
  const worktree = join(base, 'reopen');
  mkdirSync(worktree);
  const edit = (name) => {
    writeFileSync(join(worktree, name), 'B\n');
    recordTurnDiffChanges('reopen', [{ path: join(worktree, name), displayPath: name, before: 'b\n', after: 'B\n' }]);
  };
  const reopen = async (name) => {
    await beginTurnSnapshot(worktree, 'reopen', { continueTurn: true });
    edit(name);
  };
  const read = () => getTurnChanges('reopen', { checkpointId: 'cp' });
  await beginTurnSnapshot(worktree, 'reopen', { checkpointId: 'cp' });
  edit('a.txt');
  assert.equal(await completeTurnSnapshot('reopen'), true);

  // Reopened after the read began; its new seal is still writing when the
  // read decides.
  let releaseWrite;
  const writeHeld = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  store._setTurnChangeRecordWriteHookForTest(() => writeHeld);
  let resealed = null;
  afterRecordRead = async () => {
    await reopen('b.txt');
    resealed = completeTurnSnapshot('reopen');
  };
  const writing = await read();
  releaseWrite();
  assert.equal(await resealed, true);
  store._setTurnChangeRecordWriteHookForTest(null);
  assert.equal(writing.status, 'pending');

  // Reopened and resealed entirely within the read.
  afterRecordRead = async () => {
    await reopen('c.txt');
    assert.equal(await completeTurnSnapshot('reopen'), true);
  };
  assert.equal((await read()).status, 'pending');

  const settled = await read();
  assert.equal(settled.status, 'ready');
  assert.deepEqual(
    settled.files.map((file) => [file.path, file.state]),
    [
      ['a.txt', 'applied'],
      ['b.txt', 'applied'],
      ['c.txt', 'applied'],
    ]
  );
});
