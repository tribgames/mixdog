// Per-turn change records, fast lane: non-Git turns (exact tracker patches),
// size-dropped patches, composer Undo bookkeeping and record-write faults.
// The Git-repository integration cases live in turn-changes.slow.test.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
const skip = gitAvailable ? false : 'git is unavailable';

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mixdog-turn-changes-')));
process.env.MIXDOG_DATA_DIR = join(base, 'data');
process.on('exit', () => {
  rmSync(base, { recursive: true, force: true });
});

const snapshotModule = await import('./turn-snapshot.mjs');
const {
  _resetTurnSnapshotForTest,
  beginTurnSnapshot,
  completeTurnSnapshot,
  getSessionReviewDiff,
  getTurnChanges,
  getTurnReviewDiff,
  reapplyTurnChanges,
  recordTurnDiffChanges,
  revertTurnChanges,
  revertTurnReview,
  revertTurnReviewFile,
} = snapshotModule;
const { CHANGE_STATE_UNKNOWN_REASON, TURN_CHANGE_FILE_PATCH_MAX_BYTES, storedChangeFile, turnChangesReply } =
  await import('./turn-changes.mjs');
const { _setTurnChangeRecordWriteHookForTest, loadTurnChangeRecord, upsertTurnChangeRecord } = await import(
  './turn-snapshot-store.mjs'
);

let seq = 0;

function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    if (content === null) {
      rmSync(full, { force: true });
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** Every listed path's exact bytes (null = absent). */
function readTree(root, paths) {
  return Object.fromEntries(
    paths.map((path) => [path, existsSync(join(root, path)) ? readFileSync(join(root, path)).toString('latin1') : null])
  );
}

const states = (reply) => reply.files.map((file) => [file.path, file.state]);

/** A sealed non-Git turn that changed every `edits` file from `seed`. */
async function plainTurn(sessionId, seed, edits) {
  const root = join(base, `plain-${sessionId}-${++seq}`);
  mkdirSync(root, { recursive: true });
  writeTree(root, seed);
  await beginTurnSnapshot(root, sessionId, { checkpointId: 'cp' });
  writeTree(root, edits);
  recordTurnDiffChanges(
    sessionId,
    Object.entries(edits).map(([path, after]) => ({
      path: join(root, path),
      displayPath: path,
      before: seed[path] ?? null,
      after,
    }))
  );
  await completeTurnSnapshot(sessionId);
  return root;
}

test('composer Undo records the turn as reverted so its history offers Reapply', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'composer-undo';
  const root = await plainTurn(sessionId, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, { 'a.txt': 'A\n', 'b.txt': 'B\n' });
  let reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.equal(reply.revision, 1);

  await revertTurnReviewFile(root, sessionId, 'a.txt', 'cp');
  reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.equal(reply.revision, 2);
  assert.deepEqual(states(reply), [
    ['a.txt', 'reverted'],
    ['b.txt', 'applied'],
  ]);
  assert.equal(reply.canUndo, true);
  assert.equal(reply.canReapply, true);
  await assert.rejects(revertTurnChanges(sessionId, 'cp', 'a.txt', reply.revision), /already undone/);

  await revertTurnReview(root, sessionId, 'cp');
  assert.deepEqual(readTree(root, ['a.txt', 'b.txt']), { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.equal(reply.revision, 3);
  assert.deepEqual(states(reply), [
    ['a.txt', 'reverted'],
    ['b.txt', 'reverted'],
  ]);
  assert.equal(reply.canUndo, false);
  assert.equal(reply.canReapply, true);

  reply = await reapplyTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.deepEqual(readTree(root, ['a.txt', 'b.txt']), { 'a.txt': 'A\n', 'b.txt': 'B\n' });
  assert.deepEqual(states(reply), [
    ['a.txt', 'applied'],
    ['b.txt', 'applied'],
  ]);
});

test('a record write failing after Undo applied restores the worktree and rethrows', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'record-fault';
  const root = await plainTurn(sessionId, { 'edit.txt': 'x\n' }, { 'edit.txt': 'X\n' });
  const before = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  const injected = new Error('injected record write failure');
  let writes = 0;
  _setTurnChangeRecordWriteHookForTest(() => {
    writes += 1;
    // The patch already applied: the worktree holds the undone bytes.
    assert.equal(readTree(root, ['edit.txt'])['edit.txt'], 'x\n');
    throw injected;
  });
  try {
    await assert.rejects(
      revertTurnChanges(sessionId, 'cp', 'edit.txt', before.revision),
      (error) => error === injected
    );
  } finally {
    _setTurnChangeRecordWriteHookForTest(null);
  }
  assert.equal(writes, 1);
  assert.equal(readTree(root, ['edit.txt'])['edit.txt'], 'X\n');
  const after = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.equal(after.revision, before.revision);
  assert.deepEqual(states(after), [['edit.txt', 'applied']]);
  assert.equal(after.canUndo, true);

  const undone = await revertTurnChanges(sessionId, 'cp', 'edit.txt', after.revision);
  assert.equal(readTree(root, ['edit.txt'])['edit.txt'], 'x\n');
  assert.deepEqual(states(undone), [['edit.txt', 'reverted']]);
});

test('a failed record write whose rollback fails leaves the files unknown, never applied', { skip }, async () => {
  for (const storeRefuses of [false, true]) {
    _resetTurnSnapshotForTest();
    const sessionId = `rollback-fault-${storeRefuses}`;
    const root = await plainTurn(
      sessionId,
      { 'edit.txt': 'x\n', 'other.txt': 'o\n' },
      { 'edit.txt': 'X\n', 'other.txt': 'O\n' }
    );
    const before = await getTurnChanges(sessionId, { checkpointId: 'cp' });
    const injected = new Error('injected record write failure');
    let writes = 0;
    _setTurnChangeRecordWriteHookForTest(() => {
      writes += 1;
      if (writes === 1) {
        // An edit lands between the Undo and its rollback.
        writeTree(root, { 'edit.txt': 'edited meanwhile\n' });
        throw injected;
      }
      if (storeRefuses) throw new Error('the store still refuses writes');
    });
    try {
      await assert.rejects(revertTurnChanges(sessionId, 'cp', 'edit.txt', before.revision), (error) => {
        assert.match(error.message, /were undone but could not be recorded \(injected record write failure\)/);
        assert.match(error.message, /restoring the worktree failed/);
        assert.equal(error.cause, injected);
        return true;
      });
    } finally {
      _setTurnChangeRecordWriteHookForTest(null);
    }
    assert.equal(writes, 2, `storeRefuses=${storeRefuses}`);
    assert.equal(readTree(root, ['edit.txt'])['edit.txt'], 'edited meanwhile\n');

    const after = await getTurnChanges(sessionId, { checkpointId: 'cp' });
    assert.equal(after.revision, storeRefuses ? before.revision : before.revision + 1);
    const edit = after.files.find((file) => file.path === 'edit.txt');
    assert.equal(edit.revertable, false);
    assert.equal(edit.reason, CHANGE_STATE_UNKNOWN_REASON);
    assert.equal(after.canUndo, false);
    assert.match(after.reason, /edit\.txt cannot be undone/);
    assert.equal(after.canReapply, false);
    await assert.rejects(revertTurnChanges(sessionId, 'cp', 'edit.txt', after.revision), /edit\.txt cannot be undone/);

    // The unaffected file still undoes on its own, and edit.txt stays unknown.
    const other = await revertTurnChanges(sessionId, 'cp', 'other.txt', after.revision);
    assert.equal(readTree(root, ['other.txt'])['other.txt'], 'o\n');
    assert.deepEqual(
      other.files.map((file) => [file.path, file.state, file.revertable]),
      [
        ['edit.txt', 'applied', false],
        ['other.txt', 'reverted', true],
      ]
    );
  }
});

test('Undo/Reapply refreshes a non-Git turn review tracker', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const root = join(base, `plain-review-${++seq}`);
  mkdirSync(root, { recursive: true });
  writeTree(root, { 'edit.txt': 'x\n', 'old.txt': 'same\n' });
  const sessionId = 'review-plain';
  await beginTurnSnapshot(root, sessionId, { checkpointId: 'cp' });
  writeTree(root, { 'edit.txt': 'X\n', 'made.txt': 'made\n', 'old.txt': null, 'new.txt': 'same\n' });
  recordTurnDiffChanges(sessionId, [
    { path: join(root, 'edit.txt'), displayPath: 'edit.txt', before: 'x\n', after: 'X\n' },
    { path: join(root, 'made.txt'), displayPath: 'made.txt', before: null, after: 'made\n' },
    {
      path: join(root, 'old.txt'),
      displayPath: 'old.txt',
      newPath: join(root, 'new.txt'),
      newDisplayPath: 'new.txt',
      before: 'same\n',
      after: 'same\n',
    },
  ]);
  await completeTurnSnapshot(sessionId);
  const patch = async () => (await getTurnReviewDiff(root, sessionId)).patch;
  assert.match(await patch(), /edit\.txt[\s\S]*made\.txt[\s\S]*a\/old\.txt b\/new\.txt/);

  let reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  reply = await revertTurnChanges(sessionId, 'cp', 'edit.txt', reply.revision);
  assert.doesNotMatch(await patch(), /edit\.txt/);
  assert.match(await patch(), /made\.txt/);
  reply = await revertTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.equal(await patch(), '');
  assert.equal((await getSessionReviewDiff(root, sessionId)).patch, '');

  reply = await reapplyTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.match(await patch(), /-x\n\+X\n[\s\S]*made\.txt[\s\S]*a\/old\.txt b\/new\.txt/);
  assert.match((await getSessionReviewDiff(root, sessionId)).patch, /made\.txt/);
  // The composer's latest-turn Undo reverts the reapplied state exactly.
  await revertTurnReview(root, sessionId, 'cp');
  assert.deepEqual(readTree(root, ['edit.txt', 'made.txt', 'old.txt', 'new.txt']), {
    'edit.txt': 'x\n',
    'made.txt': null,
    'old.txt': 'same\n',
    'new.txt': null,
  });
});

test('files whose patch was dropped for size carry patchOmitted', async () => {
  const sessionId = 'omitted';
  const big = (fill, bytes) => Buffer.from(`diff --git a/${fill} b/${fill}\n${'+'.repeat(bytes)}\n`);
  const small = storedChangeFile({
    path: 'small.txt',
    status: 'M',
    additions: 1,
    deletions: 0,
    revertable: true,
    patch: big('small.txt', 10),
  });
  // Over the per-file ceiling.
  const oversized = storedChangeFile({
    path: 'huge.txt',
    status: 'M',
    additions: 1,
    deletions: 0,
    revertable: true,
    patch: big('huge.txt', TURN_CHANGE_FILE_PATCH_MAX_BYTES + 1),
  });
  // Under it, but together over the session byte budget (32 MiB).
  const parts = ['p1', 'p2', 'p3', 'p4', 'p5'].map((name) =>
    storedChangeFile({
      path: `${name}.txt`,
      status: 'M',
      additions: 1,
      deletions: 0,
      revertable: true,
      patch: big(name, 7 * 1024 * 1024),
    })
  );
  const record = await upsertTurnChangeRecord(sessionId, {
    checkpointId: 'cp',
    kind: 'git',
    root: base,
    files: [small, oversized, ...parts],
  });
  const reply = turnChangesReply({ status: 'ready', checkpointId: 'cp', record });
  const byPath = Object.fromEntries(reply.files.map((file) => [file.path, file]));
  assert.equal(byPath['huge.txt'].patchOmitted, true);
  assert.equal(byPath['huge.txt'].revertable, false);
  assert.equal(Object.hasOwn(byPath['small.txt'], 'patchOmitted'), false);
  assert.equal(byPath['small.txt'].revertable, true);
  const dropped = parts.filter((part) => byPath[part.path].patchOmitted === true);
  assert.ok(dropped.length >= 1, 'the oversized turn dropped its largest patches');
  for (const part of parts) {
    const file = byPath[part.path];
    assert.equal(file.revertable, file.patchOmitted !== true, part.path);
  }
  // Durable: the stored record still reports it.
  const reloaded = turnChangesReply({
    status: 'ready',
    checkpointId: 'cp',
    record: await loadTurnChangeRecord(sessionId, 'cp'),
  });
  assert.deepEqual(reloaded.files, reply.files);
});

test('a non-Git turn records exact tracker patches and replays them', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const root = join(base, `plain-${++seq}`);
  mkdirSync(join(root, 'sub dir'), { recursive: true });
  const seed = {
    'edit.txt': 'x\r\ny\r\n',
    'gone.txt': 'bye\n',
    'old name.txt': 'same\n',
    'sub dir/파일.txt': 'tail',
    'blob.bin': Buffer.from([0xff, 0xfe, 0x00, 0x01]),
  };
  writeTree(root, seed);
  const sessionId = 'plain';
  await beginTurnSnapshot(root, sessionId, { checkpointId: 'cp' });
  const abs = (path) => join(root, path);
  const changes = [
    { path: abs('edit.txt'), displayPath: 'edit.txt', before: seed['edit.txt'], after: 'x\r\nY\r\n' },
    { path: abs('gone.txt'), displayPath: 'gone.txt', before: seed['gone.txt'], after: null },
    { path: abs('made.txt'), displayPath: 'made.txt', before: null, after: 'made\n' },
    {
      path: abs('old name.txt'),
      displayPath: 'old name.txt',
      newPath: abs('new name.txt'),
      newDisplayPath: 'new name.txt',
      before: seed['old name.txt'],
      after: seed['old name.txt'],
    },
    { path: abs('sub dir/파일.txt'), displayPath: 'sub dir/파일.txt', before: 'tail', after: 'tail\nmore' },
    { path: abs('blob.bin'), displayPath: 'blob.bin', before: seed['blob.bin'], after: Buffer.from([1, 2]) },
  ];
  // Apply the same edits the tool reported.
  writeTree(root, {
    'edit.txt': 'x\r\nY\r\n',
    'gone.txt': null,
    'made.txt': 'made\n',
    'old name.txt': null,
    'new name.txt': seed['old name.txt'],
    'sub dir/파일.txt': 'tail\nmore',
    'blob.bin': Buffer.from([1, 2]),
  });
  recordTurnDiffChanges(sessionId, changes);
  await completeTurnSnapshot(sessionId);
  const paths = ['edit.txt', 'gone.txt', 'made.txt', 'old name.txt', 'new name.txt', 'sub dir/파일.txt'];
  let reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.equal(reply.root, root);
  assert.deepEqual(
    reply.files.map((file) => [file.path, file.oldPath || '', file.status, file.revertable]),
    [
      ['blob.bin', '', 'M', false],
      ['edit.txt', '', 'M', true],
      ['gone.txt', '', 'D', true],
      ['made.txt', '', 'A', true],
      ['new name.txt', 'old name.txt', 'R', true],
      ['sub dir/파일.txt', '', 'M', true],
    ]
  );
  // A non-revertable applied file refuses the whole-turn Undo.
  assert.equal(reply.canUndo, false);
  assert.match(reply.reason, /blob\.bin cannot be undone/);
  await assert.rejects(revertTurnChanges(sessionId, 'cp', null, reply.revision), /blob\.bin cannot be undone/);
  const after = readTree(root, paths);
  for (const path of paths.filter((path) => !['old name.txt', 'blob.bin'].includes(path))) {
    reply = await revertTurnChanges(sessionId, 'cp', path, reply.revision);
  }
  assert.deepEqual(
    readTree(root, paths),
    Object.fromEntries(
      paths.map((path) => [
        path,
        path === 'new name.txt' || path === 'made.txt' ? null : Buffer.from(seed[path]).toString('latin1'),
      ])
    )
  );
  for (const path of ['edit.txt', 'gone.txt', 'made.txt', 'new name.txt', 'sub dir/파일.txt']) {
    reply = await reapplyTurnChanges(sessionId, 'cp', path, reply.revision);
  }
  assert.deepEqual(readTree(root, paths), after);
});
