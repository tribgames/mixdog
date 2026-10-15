// Per-turn change records, fast lane: non-Git turns (exact tracker patches),
// size-dropped patches, composer Undo bookkeeping and record-write faults.
// The Git-repository integration cases live in turn-changes.slow.test.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
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
  beginAgentTurnReview,
  beginTurnSnapshot,
  clearSessionChangeHistory,
  completeAgentTurnReview,
  completeTurnSnapshot,
  getSessionReviewDiff,
  getSessionReviewFilePatch,
  getTurnChanges,
  getTurnReviewDiff,
  getTurnReviewFilePatch,
  reapplyTurnChanges,
  recordTurnDiffChanges,
  revertTurnChanges,
  revertTurnReview,
  revertTurnReviewFile,
} = snapshotModule;
const {
  CHANGE_STATE_UNKNOWN_REASON,
  MERGED_PATCH_MAX_BYTES,
  NET_TEXT_MAX_BYTES,
  TURN_CHANGE_FILE_PATCH_MAX_BYTES,
  changePathKey,
  currentText,
  storedChangeFile,
  trackedChangeFile,
  turnChangesReply,
} = await import('./turn-changes.mjs');
const { _setTurnChangeRecordWriteHookForTest, loadTurnChangeRecord, upsertTurnChangeRecord } = await import(
  './turn-snapshot-store.mjs'
);
const {
  _rowCacheBytesForTest,
  _pendingCapturesForTest,
  _settleSessionBaselinesForTest,
  _unsavedBytesForTest,
  captureSessionBaselines,
  clearSessionBaselines,
  loadSessionBaselines,
  recordReviewOwner,
} = await import('./session-baseline-store.mjs');

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

test('the session byte budget counts multibyte display patches in UTF-8 bytes', async () => {
  // Three Korean patches (3 bytes per character): ~46 MB stored, 30 MB once the
  // largest is dropped — within the 32 MiB budget, so only that one may go.
  const outside = [5_200_000, 5_100_000, 5_000_000].map((length, index) => ({
    path: `${base}/outside-ko-${index}.txt`,
    status: 'M',
    additions: 1,
    deletions: 0,
    viewPatch: '가'.repeat(length),
  }));
  const record = await upsertTurnChangeRecord('multibyte-budget', {
    checkpointId: 'cp',
    kind: 'git',
    root: base,
    files: [],
    outside,
  });
  assert.deepEqual(
    record.outside.map((file) => file.patchOmitted === true),
    [true, false, false]
  );
  assert.equal(typeof record.outside[1].viewPatch, 'string');
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
  const paths = ['blob.bin', 'edit.txt', 'gone.txt', 'made.txt', 'old name.txt', 'new name.txt', 'sub dir/파일.txt'];
  let reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.equal(reply.root, root);
  assert.deepEqual(
    reply.files.map((file) => [file.path, file.oldPath || '', file.status, file.revertable, file.binary === true]),
    [
      ['blob.bin', '', 'M', true, true],
      ['edit.txt', '', 'M', true, false],
      ['gone.txt', '', 'D', true, false],
      ['made.txt', '', 'A', true, false],
      ['new name.txt', 'old name.txt', 'R', true, false],
      ['sub dir/파일.txt', '', 'M', true, false],
    ]
  );
  // Binary content replays as an exact full-index binary patch.
  assert.equal(reply.canUndo, true, reply.reason);
  const after = readTree(root, paths);
  for (const path of paths.filter((path) => path !== 'old name.txt')) {
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
  reply = await reapplyTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.deepEqual(readTree(root, paths), after);
  // A binary file changed since the turn refuses its Undo and keeps its bytes.
  writeFileSync(join(root, 'blob.bin'), Buffer.from([9, 9, 9]));
  await assert.rejects(revertTurnChanges(sessionId, 'cp', 'blob.bin', reply.revision), /undo failed; the worktree was not changed/);
  assert.deepEqual(readFileSync(join(root, 'blob.bin')), Buffer.from([9, 9, 9]));
});

test('a line diff cut short to its replacement hunk still records an exact, replayable patch', { skip }, async () => {
  _resetTurnSnapshotForTest();
  // Over the line limit, so never Myers-diffed: one hunk between the common
  // prefix and suffix, CR bytes and the missing final newline kept exactly.
  const lines = Array.from({ length: 20_010 }, (_, index) => `line ${index}\r`);
  const before = `${lines.join('\n')}\n`;
  const edited = [...lines];
  edited[5] = 'changed 5\r';
  edited[20_000] = 'changed 20000\r';
  const after = edited.join('\n');
  const sessionId = 'fallback-replay';
  const root = await plainTurn(sessionId, { 'long.txt': before }, { 'long.txt': after });
  const live = await getTurnReviewDiff(root, sessionId);
  assert.match(live.patch, /^@@ -3,20008 \+3,20008 @@$/m);
  assert.doesNotMatch(live.patch, /Binary files/);
  let reply = await getTurnChanges(sessionId, { checkpointId: 'cp', patch: true });
  assert.deepEqual(
    reply.files.map((file) => [file.path, file.status, file.revertable, file.additions, file.deletions]),
    [['long.txt', 'M', true, 20_005, 20_005]]
  );
  assert.match(reply.patch, /^@@ -3,20008 \+3,20008 @@\n line 2\r\n line 3\r\n line 4\r\n-line 5\r\n/m);
  assert.ok(reply.patch.endsWith('+line 20009\r\n\\ No newline at end of file\n'));
  reply = await revertTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.equal(readFileSync(join(root, 'long.txt'), 'utf8'), before);
  await reapplyTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.equal(readFileSync(join(root, 'long.txt'), 'utf8'), after);
});

/** One sealed non-Git turn: `before` states are what the tool recorded, the
 *  worktree is edited to the `after` states. */
async function trackedTurn(sessionId, root, checkpointId, edits) {
  await beginTurnSnapshot(root, sessionId, { checkpointId });
  recordTurnDiffChanges(
    sessionId,
    edits.map(({ path, before, after, displayPath }) => ({
      path: isAbsolute(path) ? path : join(root, path),
      displayPath: displayPath ?? path,
      before,
      after,
    }))
  );
  await completeTurnSnapshot(sessionId);
}

const sessionRoot = (name) => {
  const root = join(base, `session-${name}`);
  mkdirSync(root, { recursive: true });
  return root;
};
const reviewShape = (review) =>
  review.files.map((file) => [file.path, file.oldPath || '', file.status, file.additions, file.deletions]);
/** The review before and after a runtime restart (in-memory trackers gone). */
async function reviewTwice(root, sessionId) {
  const live = await getSessionReviewDiff(root, sessionId);
  _resetTurnSnapshotForTest();
  return [live, await getSessionReviewDiff(root, sessionId)];
}

test('the session review lists a non-Git session from its records, outside files with their diff', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'review-recorded';
  const root = sessionRoot(sessionId);
  const outside = join(base, `outside-${sessionId}`, 'outside-note.txt');
  mkdirSync(dirname(outside), { recursive: true });
  writeFileSync(join(root, 'note.txt'), 'one\ntwo\nthree');
  writeFileSync(outside, 'out\n');
  await trackedTurn(sessionId, root, 'cp', [
    { path: 'note.txt', before: null, after: 'one\ntwo\nthree' },
    { path: outside, displayPath: outside, before: null, after: 'out\n' },
  ]);
  const turn = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  const [live, restarted] = await reviewTwice(root, sessionId);
  assert.deepEqual(reviewShape(live), reviewShape(restarted));
  assert.equal(restarted.complete, true);
  assert.equal(restarted.source, undefined);
  const outsideFile = restarted.files.find((file) => file.path !== 'note.txt');
  assert.deepEqual([outsideFile.status, outsideFile.additions, outsideFile.reason], ['A', 1, undefined]);
  assert.ok(restarted.patch.includes(`diff --git a/${outsideFile.path} b/${outsideFile.path}\n`));
  assert.ok(restarted.patch.includes('+out\n'));
  assert.deepEqual(restarted.files.map((file) => file.path).sort(), turn.files.map((file) => file.path).sort());
});

test('a non-Git session review lists its workers’ edits beside the Lead’s, after a restart too', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'review-with-worker';
  const root = sessionRoot(lead);
  writeFileSync(join(root, 'lead.txt'), 'lead\n');
  writeFileSync(join(root, 'worker.txt'), 'worker\n');
  const token = await beginTurnSnapshot(root, lead, { checkpointId: 'cp' });
  const worker = beginAgentTurnReview(lead, `${lead}-worker`, { agent: 'worker' });
  // The worker runs its own session turn, which records its own change.
  await trackedTurn(`${lead}-worker`, root, 'worker-cp', [{ path: 'worker.txt', before: null, after: 'worker\n' }]);
  completeAgentTurnReview(worker);
  recordTurnDiffChanges(lead, [
    { path: join(root, 'lead.txt'), displayPath: 'lead.txt', before: null, after: 'lead\n' },
  ]);
  await completeTurnSnapshot(lead, token);
  const [live, restarted] = await reviewTwice(root, lead);
  assert.deepEqual(live.files.map((file) => file.path).sort(), ['lead.txt', 'worker.txt']);
  assert.deepEqual(reviewShape(live), reviewShape(restarted));
});

test('worker delete → Lead recreate nets to one M against the first-seen state', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'review-worker-first';
  const root = sessionRoot(lead);
  writeFileSync(join(root, 'note.txt'), 'new\n');
  const token = await beginTurnSnapshot(root, lead, { checkpointId: 'cp' });
  const worker = beginAgentTurnReview(lead, `${lead}-worker`, { agent: 'worker' });
  // The worker deletes the file, then the Lead recreates it with new content.
  await trackedTurn(`${lead}-worker`, root, 'worker-cp', [{ path: 'note.txt', before: 'old\n', after: null }]);
  completeAgentTurnReview(worker);
  await new Promise((resolve) => setTimeout(resolve, 5));
  recordTurnDiffChanges(lead, [
    { path: join(root, 'note.txt'), displayPath: 'note.txt', before: null, after: 'new\n' },
  ]);
  await completeTurnSnapshot(lead, token);
  const review = await getSessionReviewDiff(root, lead);
  assert.deepEqual(
    review.files.map((file) => [file.path, file.status]),
    [['note.txt', 'M']]
  );
});

const netStatuses = (review) => review.files.map((file) => [file.path, file.status]);

test('Lead delete → worker recreate (its own session turn) → Lead delete nets to one D', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'baseline-delete-recreate-delete';
  const root = sessionRoot(lead);
  const note = join(root, 'note.txt');
  writeFileSync(note, 'original\n');
  const token = await beginTurnSnapshot(root, lead, { checkpointId: 'cp' });
  rmSync(note);
  recordTurnDiffChanges(lead, [{ path: note, displayPath: 'note.txt', before: 'original\n', after: null }]);
  const worker = beginAgentTurnReview(lead, `${lead}-worker`, { agent: 'worker' });
  writeFileSync(note, 'worker\n');
  await trackedTurn(`${lead}-worker`, root, 'worker-cp', [{ path: 'note.txt', before: null, after: 'worker\n' }]);
  completeAgentTurnReview(worker);
  rmSync(note);
  recordTurnDiffChanges(lead, [{ path: note, displayPath: 'note.txt', before: 'worker\n', after: null }]);
  await completeTurnSnapshot(lead, token);
  const [live, restarted] = await reviewTwice(root, lead);
  for (const review of [live, restarted]) {
    assert.deepEqual(reviewShape(review), [['note.txt', '', 'D', 0, 1]]);
    assert.equal(review.complete, true);
    assert.match(review.patch, /^-original$/m);
  }
});

test('a worker rename old→middle and a Lead rename middle→new net to one R from the original path', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'baseline-rename-chain';
  const root = sessionRoot(lead);
  const [oldFile, middle, newFile] = ['old.txt', 'middle.txt', 'new.txt'].map((name) => join(root, name));
  writeFileSync(oldFile, 'content\n');
  const token = await beginTurnSnapshot(root, lead, { checkpointId: 'cp' });
  // The worker's edits arrive through the tracker bound to the Lead's turn.
  const worker = beginAgentTurnReview(lead, `${lead}-worker`, { agent: 'worker' });
  renameSync(oldFile, middle);
  recordTurnDiffChanges(`${lead}-worker`, [
    {
      path: oldFile,
      displayPath: 'old.txt',
      newPath: middle,
      newDisplayPath: 'middle.txt',
      before: 'content\n',
      after: 'content\n',
    },
  ]);
  completeAgentTurnReview(worker);
  renameSync(middle, newFile);
  writeFileSync(newFile, 'content\nmore\n');
  recordTurnDiffChanges(lead, [
    {
      path: middle,
      displayPath: 'middle.txt',
      newPath: newFile,
      newDisplayPath: 'new.txt',
      before: 'content\n',
      after: 'content\nmore\n',
    },
  ]);
  await completeTurnSnapshot(lead, token);
  const [live, restarted] = await reviewTwice(root, lead);
  for (const review of [live, restarted]) {
    assert.deepEqual(reviewShape(review), [['new.txt', 'old.txt', 'R', 1, 0]]);
    assert.equal(review.complete, true);
    assert.ok(review.patch.includes('rename from old.txt\nrename to new.txt'));
    assert.equal(review.patch.includes('middle.txt'), false);
  }
});

test('a worker resumed after a restart still credits the Lead it was attributed to', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'baseline-attribution';
  const root = sessionRoot(lead);
  const token = await beginTurnSnapshot(root, lead, { checkpointId: 'cp' });
  beginAgentTurnReview(lead, `${lead}-worker`, { agent: 'worker' });
  await completeTurnSnapshot(lead, token);
  const ownerFile = join(
    process.env.MIXDOG_DATA_DIR,
    'turn-snapshots',
    'review-owners',
    `${createHash('sha256').update(`${lead}-worker`).digest('hex').slice(0, 24)}.json`
  );
  for (let tries = 0; tries < 200 && !existsSync(ownerFile); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Restart: the in-memory attribution and trackers are gone.
  _resetTurnSnapshotForTest();
  writeFileSync(join(root, 'w.txt'), 'w\n');
  await trackedTurn(`${lead}-worker`, root, 'worker-cp', [{ path: 'w.txt', before: null, after: 'w\n' }]);
  assert.deepEqual(reviewShape(await getSessionReviewDiff(root, lead)), [['w.txt', '', 'A', 1, 0]]);
});

test('a Lead record re-sealed after its worker nets the Lead’s later edit last', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'review-order-resealed';
  const root = sessionRoot(lead);
  writeFileSync(join(root, 'note.txt'), 'new\n');
  // The Lead turn seals first: its record's createdAt predates the worker's.
  const token = await beginTurnSnapshot(root, lead, { checkpointId: 'cp' });
  await completeTurnSnapshot(lead, token);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const worker = beginAgentTurnReview(lead, `${lead}-worker`, { agent: 'worker' });
  await trackedTurn(`${lead}-worker`, root, 'worker-cp', [{ path: 'note.txt', before: 'old\n', after: null }]);
  completeAgentTurnReview(worker);
  // A completion wake reopens the turn; the Lead recreates the file and the
  // re-seal keeps the record's first createdAt.
  const wake = await beginTurnSnapshot(root, lead, { checkpointId: 'cp', continueTurn: true });
  recordTurnDiffChanges(lead, [
    { path: join(root, 'note.txt'), displayPath: 'note.txt', before: null, after: 'new\n' },
  ]);
  await completeTurnSnapshot(lead, wake);
  const leadRecord = await loadTurnChangeRecord(lead, 'cp');
  const workerRecord = await loadTurnChangeRecord(`${lead}-worker`, 'worker-cp');
  // The completed worker's delete joined the Lead's own changes first, so the
  // Lead's recreate nets old → new.
  assert.deepEqual(
    leadRecord.files.map((file) => [file.path, file.status]),
    [['note.txt', 'M']]
  );
  assert.ok(leadRecord.createdAt < workerRecord.createdAt);
  const [live, restarted] = await reviewTwice(root, lead);
  assert.deepEqual(netStatuses(live), [['note.txt', 'M']]);
  assert.deepEqual(netStatuses(restarted), [['note.txt', 'M']]);
});

test('a Lead edit that landed before its worker’s nets first in the session review', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'review-lead-first';
  const root = sessionRoot(lead);
  writeFileSync(join(root, 'note.txt'), 'new\n');
  const token = await beginTurnSnapshot(root, lead, { checkpointId: 'cp' });
  // The Lead deletes the file, then a worker recreates it; the Lead's record
  // is sealed last.
  recordTurnDiffChanges(lead, [
    { path: join(root, 'note.txt'), displayPath: 'note.txt', before: 'old\n', after: null },
  ]);
  const worker = beginAgentTurnReview(lead, `${lead}-worker`, { agent: 'worker' });
  await trackedTurn(`${lead}-worker`, root, 'worker-cp', [{ path: 'note.txt', before: null, after: 'new\n' }]);
  completeAgentTurnReview(worker);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await completeTurnSnapshot(lead, token);
  const [live, restarted] = await reviewTwice(root, lead);
  assert.deepEqual(netStatuses(live), [['note.txt', 'M']]);
  assert.deepEqual(netStatuses(restarted), [['note.txt', 'M']]);
});

test('session review nets turns: create then delete leaves nothing, edits across turns are one diff', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'review-net';
  const root = sessionRoot(sessionId);
  const ten = Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n');
  writeTree(root, { 'edit.txt': 'head\n' });
  // Turn 1: create tmp.txt and extend edit.txt by ten lines.
  writeTree(root, { 'tmp.txt': 'x\n', 'edit.txt': `head\n${ten}\n` });
  await trackedTurn(sessionId, root, 'cp-1', [
    { path: 'tmp.txt', before: null, after: 'x\n' },
    { path: 'edit.txt', before: 'head\n', after: `head\n${ten}\n` },
  ]);
  // Turn 2: delete tmp.txt and change one line of edit.txt.
  writeTree(root, { 'tmp.txt': null, 'edit.txt': `HEAD\n${ten}\n` });
  await trackedTurn(sessionId, root, 'cp-2', [
    { path: 'tmp.txt', before: 'x\n', after: null },
    { path: 'edit.txt', before: `head\n${ten}\n`, after: `HEAD\n${ten}\n` },
  ]);
  const [live, restarted] = await reviewTwice(root, sessionId);
  // head→HEAD plus ten new lines: net +11 −1, never +1 −1 nor +10 +1.
  assert.deepEqual(reviewShape(restarted), [['edit.txt', '', 'M', 11, 1]]);
  assert.deepEqual(reviewShape(live), reviewShape(restarted));
  assert.equal(restarted.patch.includes('tmp.txt'), false);
});

test('session review keeps a rename as one R entry with its old path', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'review-rename';
  const root = sessionRoot(sessionId);
  writeTree(root, { 'new.txt': 'same\ncontent\n' });
  // A tool-reported rename (path → newPath) with identical content: a PURE
  // rename must stay listed, never netted to nothing.
  await beginTurnSnapshot(root, sessionId, { checkpointId: 'cp' });
  recordTurnDiffChanges(sessionId, [
    {
      path: join(root, 'old.txt'),
      displayPath: 'old.txt',
      before: 'same\ncontent\n',
      after: 'same\ncontent\n',
      newPath: join(root, 'new.txt'),
      newDisplayPath: 'new.txt',
    },
  ]);
  await completeTurnSnapshot(sessionId);
  const [live, restarted] = await reviewTwice(root, sessionId);
  assert.deepEqual(reviewShape(restarted), [['new.txt', 'old.txt', 'R', 0, 0]]);
  assert.deepEqual(reviewShape(live), reviewShape(restarted));
  assert.ok(restarted.patch.includes('rename from old.txt\nrename to new.txt'));
});

test('a rename followed by an edit nets to one R entry with the combined diff', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'review-rename-edit';
  const root = sessionRoot(sessionId);
  writeTree(root, { 'new.txt': 'same\ncontent\nmore\n' });
  await beginTurnSnapshot(root, sessionId, { checkpointId: 'cp-1' });
  recordTurnDiffChanges(sessionId, [
    {
      path: join(root, 'old.txt'),
      displayPath: 'old.txt',
      before: 'same\ncontent\n',
      after: 'same\ncontent\n',
      newPath: join(root, 'new.txt'),
      newDisplayPath: 'new.txt',
    },
  ]);
  await completeTurnSnapshot(sessionId);
  await trackedTurn(sessionId, root, 'cp-2', [
    { path: 'new.txt', before: 'same\ncontent\n', after: 'same\ncontent\nmore\n' },
  ]);
  const [live, restarted] = await reviewTwice(root, sessionId);
  assert.deepEqual(reviewShape(restarted), [['new.txt', 'old.txt', 'R', 1, 0]]);
  assert.deepEqual(reviewShape(live), reviewShape(restarted));
});

test('a plain delete and a plain add stay two entries', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'review-delete-add';
  const root = sessionRoot(sessionId);
  writeTree(root, { 'new.txt': 'same\n', 'old.txt': null });
  await trackedTurn(sessionId, root, 'cp', [
    { path: 'old.txt', before: 'same\n', after: null },
    { path: 'new.txt', before: null, after: 'same\n' },
  ]);
  const [, restarted] = await reviewTwice(root, sessionId);
  assert.deepEqual(
    reviewShape(restarted).map(([path, , status]) => [path, status]),
    [
      ['new.txt', 'A'],
      ['old.txt', 'D'],
    ]
  );
});

test('session review follows Undo and Reapply of a recorded turn', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'review-undo';
  const root = sessionRoot(sessionId);
  writeTree(root, { 'a.txt': 'A\n' });
  await trackedTurn(sessionId, root, 'cp', [{ path: 'a.txt', before: 'a\n', after: 'A\n' }]);
  writeTree(root, { 'a.txt': 'A\n' });
  const reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  const reverted = await revertTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.deepEqual(reviewShape(await getSessionReviewDiff(root, sessionId)), []);
  const reapplied = await reapplyTurnChanges(sessionId, 'cp', null, reverted.revision);
  assert.equal(reapplied.files[0].state, 'applied');
  assert.deepEqual(reviewShape(await getSessionReviewDiff(root, sessionId)), [['a.txt', '', 'M', 1, 1]]);
  _resetTurnSnapshotForTest();
  assert.deepEqual(reviewShape(await getSessionReviewDiff(root, sessionId)), [['a.txt', '', 'M', 1, 1]]);
});

test('session review keys by root: two roots with the same relative path stay two files', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'review-roots';
  const first = sessionRoot('roots-a');
  const second = sessionRoot('roots-b');
  writeTree(first, { 'x.txt': 'one\n' });
  writeTree(second, { 'x.txt': 'two\n' });
  await trackedTurn(sessionId, first, 'cp-1', [{ path: 'x.txt', before: null, after: 'one\n' }]);
  await trackedTurn(sessionId, second, 'cp-2', [{ path: 'x.txt', before: null, after: 'two\n' }]);
  const [live, restarted] = await reviewTwice(first, sessionId);
  for (const review of [live, restarted]) {
    assert.equal(review.files.length, 2);
    assert.equal(review.patch.split('new file mode').length - 1, 2);
    // Distinct ids and distinguishable display paths (the same relative name
    // is shown absolute), each file keeping its own diff.
    assert.equal(new Set(review.files.map((file) => file.id)).size, 2);
    assert.equal(new Set(review.files.map((file) => file.path)).size, 2);
    assert.ok(review.files.every((file) => file.path.endsWith('/x.txt') && file.path !== 'x.txt'));
    assert.ok(review.files.every((file) => file.outside === false));
    for (const file of review.files) assert.ok(review.patch.includes(`diff --git a/${file.path} b/${file.path}\n`));
  }
});

test('a session recorded before baselines existed is listed from its records, never as complete', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'baseline-legacy';
  const root = sessionRoot(sessionId);
  const unmeasured = join(base, 'legacy-missing', 'legacy.txt').replaceAll('\\', '/');
  writeTree(root, { 'kept.txt': 'a\nb\nc\n', 'twice.txt': 'two\n' });
  const kept = {
    path: 'kept.txt',
    status: 'A',
    additions: 3,
    deletions: 0,
    revertable: true,
    patch:
      'diff --git a/kept.txt b/kept.txt\nnew file mode 100644\n--- /dev/null\n+++ b/kept.txt\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n',
    patchEncoding: 'utf8',
  };
  const twice = (line) => ({
    path: 'twice.txt',
    status: 'M',
    additions: 1,
    deletions: 1,
    revertable: false,
    patch: null,
    reason: line,
  });
  const outside = {
    path: unmeasured,
    status: 'A',
    additions: 0,
    deletions: 0,
    revertable: false,
    reason: 'file is outside the recorded root',
    patch: null,
  };
  await upsertTurnChangeRecord(sessionId, {
    checkpointId: 'old-1',
    kind: 'tracked',
    root,
    files: [kept, outside, twice('1')],
  });
  await upsertTurnChangeRecord(sessionId, { checkpointId: 'old-2', kind: 'tracked', root, files: [twice('2')] });
  const review = await getSessionReviewDiff(root, sessionId);
  const byPath = Object.fromEntries(review.files.map((file) => [file.path, file]));
  assert.deepEqual(Object.keys(byPath).sort(), ['kept.txt', 'twice.txt', unmeasured].sort());
  assert.equal(byPath['kept.txt'].additions, 3);
  assert.ok(review.patch.includes('+++ b/kept.txt'));
  assert.equal(byPath[unmeasured].unmeasured, true);
  // Edited in two old turns: listed, but no net diff is invented for it.
  assert.equal(byPath['twice.txt'].unmeasured, true);
  assert.ok(review.files.every((file) => file.baseline === 'missing'));
  assert.deepEqual([review.complete, review.partial, review.authoritative], [undefined, true, true]);

  // With nothing recorded at all the review claims neither completeness nor
  // an authoritative empty set: the transcript may still know more.
  _resetTurnSnapshotForTest();
  const absent = await getSessionReviewDiff(sessionRoot('baseline-absent'), 'baseline-absent');
  assert.deepEqual(
    [absent.supported, absent.files, absent.complete, absent.authoritative],
    [true, [], undefined, false]
  );
});

test('the session review stays under its patch budget and lists a file past it without its diff', {
  skip,
}, async () => {
  // The budget counts bytes, not characters: multi-byte text fills it sooner.
  for (const [name, body] of [
    ['ascii', 'x'.repeat(1_000_000)],
    ['wide', '한'.repeat(340_000)],
  ]) {
    _resetTurnSnapshotForTest();
    const sessionId = `baseline-budget-${name}`;
    const root = sessionRoot(sessionId);
    const edits = ['a.txt', 'b.txt', 'c.txt'].map((path) => ({ path, before: null, after: `${body}\n` }));
    writeTree(root, Object.fromEntries(edits.map(({ path, after }) => [path, after])));
    await trackedTurn(sessionId, root, 'cp', edits);
    const review = await getSessionReviewDiff(root, sessionId);
    assert.equal(review.files.length, 3, name);
    const omitted = review.files.filter((file) => file.patchOmitted === true);
    assert.deepEqual(
      omitted.map((file) => [file.reason, file.additions]),
      [['too_large', 1]],
      name
    );
    assert.equal(review.diffTooLarge, undefined, name);
    assert.equal(review.complete, true, name);
    assert.ok(Buffer.byteLength(review.patch, 'utf8') <= MERGED_PATCH_MAX_BYTES, name);
  }
});

test('a file patch past the per-file cap is listed with its counts and read on its own', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'baseline-file-patch';
  const root = sessionRoot(sessionId);
  const before = 'a\n'.repeat(300_000);
  const after = 'b\n'.repeat(300_000);
  writeTree(root, { 'big.txt': after, 'small.txt': 'new\n' });
  await trackedTurn(sessionId, root, 'cp', [
    { path: 'big.txt', before, after },
    { path: 'small.txt', before: 'old\n', after: 'new\n' },
  ]);
  const review = await getSessionReviewDiff(root, sessionId);
  const byPath = Object.fromEntries(review.files.map((file) => [file.path, file]));
  assert.deepEqual(
    [byPath['big.txt'].patchOmitted, byPath['big.txt'].reason, byPath['big.txt'].additions, byPath['big.txt'].deletions],
    [true, 'too_large', 300_000, 300_000]
  );
  assert.equal(byPath['small.txt'].patchOmitted, undefined);
  assert.match(review.patch, /^-old\n\+new$/m);
  assert.doesNotMatch(review.patch, /big\.txt/);
  assert.equal(review.diffTooLarge, undefined);

  const whole = await getSessionReviewFilePatch(root, sessionId, byPath['big.txt'].id);
  assert.equal(whole.patchOmitted, undefined);
  assert.equal(whole.path, 'big.txt');
  assert.equal(whole.patch.match(/^\+b$/gm).length, 300_000);
  assert.equal(whole.patch.match(/^-a$/gm).length, 300_000);
  assert.deepEqual(await getSessionReviewFilePatch(root, sessionId, 'missing.txt'), {
    supported: true,
    path: 'missing.txt',
    patch: '',
  });

  // With nothing else to show, the whole reply says so.
  writeTree(root, { 'small.txt': 'old\n' });
  const alone = await getSessionReviewDiff(root, sessionId);
  assert.deepEqual(
    alone.files.map((file) => file.path),
    ['big.txt']
  );
  assert.equal(alone.patch, '');
  assert.equal(alone.diffTooLarge, true);
});

test('a current file past the source-read ceiling keeps its counts and reads whole on its own', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'baseline-large-current';
  const root = sessionRoot(sessionId);
  // 1.2 MB of new lines: past the 1 MiB source ceiling of a first state.
  const big = `${'y'.repeat(99)}\n`.repeat(12_000);
  const huge = 'h'.repeat(9 * 1024 * 1024);
  writeTree(root, { 'big.txt': big, 'huge.txt': huge });
  await beginTurnSnapshot(root, sessionId, { checkpointId: 'cp' });
  recordTurnDiffChanges(sessionId, [
    { path: join(root, 'big.txt'), displayPath: 'big.txt', before: null, after: big },
    {
      path: join(root, 'huge.txt'),
      displayPath: 'huge.txt',
      before: null,
      after: { omitted: true, size: huge.length, reason: 'oversized' },
    },
  ]);
  await completeTurnSnapshot(sessionId);
  const shape = (review) =>
    review.files.map(({ path, additions, patchOmitted, reason }) => [path, additions, patchOmitted, reason]);
  // Measured, then answered from the review's cache, then after a restart.
  for (const review of [await getSessionReviewDiff(root, sessionId), ...(await reviewTwice(root, sessionId))]) {
    assert.deepEqual(shape(review), [
      ['big.txt', 12_000, true, 'too_large'],
      ['huge.txt', 0, true, 'too_large'],
    ]);
    assert.equal(review.diffTooLarge, true);
  }
  const whole = await getSessionReviewFilePatch(root, sessionId, 'big.txt');
  assert.equal(whole.patchOmitted, undefined);
  assert.equal(whole.patch.match(/^\+y{99}$/gm).length, 12_000);
  // Past even the file read's ceiling: explicitly too large, never empty.
  assert.deepEqual(await getSessionReviewFilePatch(root, sessionId, 'huge.txt'), {
    supported: true,
    path: 'huge.txt',
    patch: '',
    patchOmitted: true,
    reason: 'too_large',
  });
});

test('a list keeps no patch text past the inline cap; a file read measures only its own baseline', async () => {
  const root = sessionRoot('targeted-read');
  const before = Buffer.from('old\n');
  const sha = createHash('sha256').update(before).digest('hex');
  const names = ['big-1.txt', 'big-2.txt', 'big-3.txt', 'small.txt'];
  // 1.2 MB of new lines each for the big files: past the 1 MiB inline cap.
  writeTree(
    root,
    Object.fromEntries(names.map((name) => [name, name === 'small.txt' ? 'new\n' : `${'z'.repeat(99)}\n`.repeat(12_000)]))
  );
  const reads = [];
  const baselines = {
    createdAt: 1,
    files: names.map((name) => ({
      key: changePathKey(join(root, name)),
      path: join(root, name),
      root,
      state: 'present',
      status: 'captured',
      size: before.length,
      sha256: sha,
      blob: `${sha}:${name}`,
      at: 1,
    })),
    missing: [],
    renames: new Map(),
    cache: new Map(),
    readBlob: async (entry) => {
      reads.push(entry.path);
      return before;
    },
  };
  const base = { supported: true, root, files: [], patch: '', source: 'empty' };
  const { sessionChangeReview } = await import('./turn-changes.mjs');
  const inlineCap = 1024 * 1024;
  const cachedTextBytes = () =>
    Math.max(...[...baselines.cache.values()].map((entry) => Buffer.byteLength(entry.change?.text || '', 'utf8')));

  const review = await sessionChangeReview(base, { baselines });
  assert.deepEqual(
    review.files.map(({ path, additions, patchOmitted, reason }) => [path, additions, patchOmitted, reason]),
    [
      ['big-1.txt', 12_000, true, 'too_large'],
      ['big-2.txt', 12_000, true, 'too_large'],
      ['big-3.txt', 12_000, true, 'too_large'],
      ['small.txt', 1, undefined, undefined],
    ]
  );
  assert.ok(review.files.every((file) => !Object.hasOwn(file, 'patch')));
  assert.doesNotMatch(review.patch, /z{99}/);
  assert.ok(cachedTextBytes() <= inlineCap, 'no measurement past the inline cap is kept');
  assert.equal(reads.length, 4);

  // One file's read measures that file alone, with its whole text.
  reads.length = 0;
  const whole = await sessionChangeReview(base, { baselines, file: join(root, 'big-2.txt') });
  assert.deepEqual(reads, [join(root, 'big-2.txt')]);
  assert.equal(whole.path, 'big-2.txt');
  assert.equal(whole.patch.match(/^\+z{99}$/gm).length, 12_000);
  assert.ok(cachedTextBytes() <= inlineCap, 'the whole text is not kept either');
  reads.length = 0;
  assert.equal((await sessionChangeReview(base, { baselines, file: 'big-3.txt' })).path, 'big-3.txt');
  assert.deepEqual(reads, [join(root, 'big-3.txt')]);
});

test('a turn patch dropped from its record for size stays too large after a restart', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'turn-record-too-large';
  // Every line replaced: a ~10 MiB patch, past what a record keeps.
  const before = `${'a'.repeat(1023)}\n`.repeat(5_000);
  const after = `${'b'.repeat(1023)}\n`.repeat(5_000);
  const root = await plainTurn(sessionId, { 'big.txt': before, 'small.txt': 'old\n' }, { 'big.txt': after, 'small.txt': 'new\n' });
  const shape = (review) =>
    review.files.map(({ path, additions, deletions, patchOmitted, reason }) => [path, additions, deletions, patchOmitted, reason]);
  for (const restart of [false, true]) {
    if (restart) _resetTurnSnapshotForTest();
    const review = await getTurnReviewDiff(root, sessionId);
    assert.deepEqual(
      shape(review),
      [
        ['big.txt', 5_000, 5_000, true, 'too_large'],
        ['small.txt', 1, 1, undefined, undefined],
      ],
      `restart: ${restart}`
    );
    assert.match(review.patch, /^-old\n\+new$/m);
    assert.deepEqual(await getTurnReviewFilePatch(root, sessionId, 'big.txt'), {
      supported: true,
      path: 'big.txt',
      patch: '',
      patchOmitted: true,
      reason: 'too_large',
    });
    assert.match((await getTurnReviewFilePatch(root, sessionId, 'small.txt')).patch, /^\+new$/m);
  }
});

test('a binary or oversized first state is listed as such and never reported complete', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'baseline-omitted';
  const root = sessionRoot(sessionId);
  writeTree(root, { 'blob.bin': Buffer.from([1, 2, 3]), 'huge.txt': 'h'.repeat(NET_TEXT_MAX_BYTES + 10) });
  await beginTurnSnapshot(root, sessionId, { checkpointId: 'cp' });
  recordTurnDiffChanges(sessionId, [
    {
      path: join(root, 'blob.bin'),
      displayPath: 'blob.bin',
      before: { omitted: true, size: 4, reason: 'binary' },
      after: Buffer.from([1, 2, 3]),
    },
    {
      path: join(root, 'huge.txt'),
      displayPath: 'huge.txt',
      before: { omitted: true, size: 5_000_000, reason: 'oversized' },
      after: { omitted: true, size: NET_TEXT_MAX_BYTES + 10, reason: 'oversized' },
    },
  ]);
  await completeTurnSnapshot(sessionId);
  const shape = (review) => review.files.map((file) => [file.path, file.status, file.baseline, file.binary === true]);
  for (const review of await reviewTwice(root, sessionId)) {
    assert.deepEqual(shape(review), [
      ['blob.bin', 'M', 'omitted-binary', true],
      ['huge.txt', 'M', 'omitted-oversized', false],
    ]);
    assert.deepEqual([review.complete, review.partial, review.authoritative], [undefined, true, true]);
  }

  // A large first state the tool did read keeps its hash: unchanged, it nets
  // away; changed, it is listed without a diff and the set is not complete.
  _resetTurnSnapshotForTest();
  const large = 'baseline-large';
  const largeRoot = sessionRoot(large);
  const original = 'l'.repeat(NET_TEXT_MAX_BYTES + 1);
  writeTree(largeRoot, { 'large.txt': original });
  await trackedTurn(large, largeRoot, 'cp', [{ path: 'large.txt', before: original, after: `${original}more` }]);
  let review = await getSessionReviewDiff(largeRoot, large);
  // Only a hash says it is unchanged: hidden, but not vouched for.
  assert.deepEqual([review.files, review.complete, review.partial, review.authoritative], [[], undefined, true, false]);
  writeTree(largeRoot, { 'large.txt': `${original}more` });
  review = await getSessionReviewDiff(largeRoot, large);
  assert.deepEqual(shape(review), [['large.txt', 'M', 'omitted-oversized', false]]);
  assert.equal(review.complete, undefined);
});

test('a file restored to its first-seen state after the session leaves the review, whoever restored it', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'baseline-external';
  const root = sessionRoot(sessionId);
  writeTree(root, { 'doc.txt': 'a\nB\nc\n' });
  await trackedTurn(sessionId, root, 'cp-1', [{ path: 'doc.txt', before: 'a\nb\nc\n', after: 'a\nB\nc\n' }]);
  writeTree(root, { 'doc.txt': 'a\nB\nc\nd\n' });
  await trackedTurn(sessionId, root, 'cp-2', [{ path: 'doc.txt', before: 'a\nB\nc\n', after: 'a\nB\nc\nd\n' }]);
  const [live, restarted] = await reviewTwice(root, sessionId);
  assert.deepEqual(reviewShape(restarted), [['doc.txt', '', 'M', 2, 1]]);
  assert.deepEqual(reviewShape(live), reviewShape(restarted));
  // An external editor changes it again: the review follows the disk and keeps
  // the session's first state as its original.
  writeTree(root, { 'doc.txt': 'totally\ndifferent\n' });
  assert.deepEqual(reviewShape(await getSessionReviewDiff(root, sessionId)), [['doc.txt', '', 'M', 2, 3]]);
  // The user restores the original: nothing is left to review.
  writeTree(root, { 'doc.txt': 'a\nb\nc\n' });
  for (const review of await reviewTwice(root, sessionId)) {
    assert.deepEqual([review.files, review.patch, review.complete], [[], '', true]);
  }
});

test('Delete history clears the session baselines; later edits start a fresh one', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'baseline-delete';
  const root = await plainTurn(sessionId, { 'a.txt': 'a\n' }, { 'a.txt': 'b\n' });
  assert.notEqual(await loadSessionBaselines(sessionId), null);
  assert.deepEqual(await clearSessionChangeHistory(sessionId), { turns: 1 });
  assert.equal(await loadSessionBaselines(sessionId), null);
  _resetTurnSnapshotForTest();
  assert.equal(await loadSessionBaselines(sessionId), null);
  assert.deepEqual(readTree(root, ['a.txt']), { 'a.txt': 'b\n' });
  writeTree(root, { 'a.txt': 'c\n' });
  await trackedTurn(sessionId, root, 'cp-next', [{ path: 'a.txt', before: 'b\n', after: 'c\n' }]);
  const review = await getSessionReviewDiff(root, sessionId);
  assert.deepEqual(reviewShape(review), [['a.txt', '', 'M', 1, 1]]);
  assert.match(review.patch, /^-b\n\+c$/m);
  assert.equal(review.complete, true);
});

test('a legacy outside file is measured from disk for the session review and the turn card', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'review-legacy-outside';
  const root = sessionRoot(sessionId);
  const outside = join(base, `legacy-outside-${seq++}`, 'outside-note.txt').replaceAll('\\', '/');
  mkdirSync(dirname(outside), { recursive: true });
  writeFileSync(outside, 'Single line of text');
  await upsertTurnChangeRecord(sessionId, {
    checkpointId: 'cp',
    kind: 'tracked',
    root,
    files: [
      {
        path: outside,
        status: 'A',
        additions: 0,
        deletions: 0,
        revertable: false,
        reason: 'file is outside the recorded root',
        patch: null,
      },
    ],
  });
  const review = await getSessionReviewDiff(root, sessionId);
  assert.deepEqual(reviewShape(review), [[outside, '', 'A', 1, 0]]);
  assert.ok(review.patch.includes('+Single line of text'));
  const card = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.equal(card.files[0].additions, 1);
});
test('the turn reply flags a file whose record kept no counts as unmeasured', { skip }, () => {
  const reply = turnChangesReply({
    status: 'ready',
    checkpointId: 'cp',
    record: {
      files: [
        {
          path: 'C:/o/x.txt',
          status: 'A',
          additions: 0,
          deletions: 0,
          revertable: false,
          patch: null,
          state: 'applied',
        },
        { path: 'k.txt', status: 'A', additions: 2, deletions: 0, revertable: false, patch: null, state: 'applied' },
      ],
    },
  });
  assert.deepEqual(
    reply.files.map((file) => file.unmeasured),
    [true, undefined]
  );
});

test('no before-text is persisted in a change record', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'review-no-base';
  const root = sessionRoot(sessionId);
  const outside = join(base, `nobase-outside`, 'o.txt');
  mkdirSync(dirname(outside), { recursive: true });
  writeFileSync(outside, 'secret before\nplus\n');
  writeTree(root, { 'a.txt': 'secret in-root after\n' });
  await trackedTurn(sessionId, root, 'cp', [
    { path: 'a.txt', before: 'secret in-root before\n', after: 'secret in-root after\n' },
    { path: outside, displayPath: outside, before: 'secret before\n', after: 'secret before\nplus\n' },
  ]);
  const record = await loadTurnChangeRecord(sessionId, 'cp');
  const text = JSON.stringify(record);
  assert.equal(/baseText|baseKnown/.test(text), false);
  assert.ok(record.files.every((file) => !('baseText' in file) && !('baseKnown' in file)));
  // The session review nets both files from the session baselines.
  const review = await getSessionReviewDiff(root, sessionId);
  assert.deepEqual(review.files.map((file) => [file.path === 'a.txt', file.additions, file.deletions]).sort(), [
    [false, 1, 0],
    [true, 1, 1],
  ]);
});

test('the net review never reads through a link out of the root, and reads files only up to a bound', {
  skip,
}, async () => {
  const root = sessionRoot('links');
  const elsewhere = join(base, 'links-elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'secret.txt'), 'outside the root\n');
  writeFileSync(join(root, 'plain.txt'), 'inside\n');
  let linked = true;
  try {
    symlinkSync(elsewhere, join(root, 'junction'), 'junction');
  } catch {
    linked = false;
  }
  assert.equal(await currentText(root, 'plain.txt'), 'inside\n');
  assert.equal(await currentText(root, 'missing.txt'), null);
  if (linked) assert.equal(await currentText(root, 'junction/secret.txt'), undefined);
  // An outside file is read only at its exact recorded path, never through a link.
  const outsideFile = join(elsewhere, 'secret.txt');
  assert.equal(await currentText(root, outsideFile), 'outside the root\n');
  try {
    symlinkSync(outsideFile, join(elsewhere, 'alias.txt'), 'file');
    assert.equal(await currentText(root, join(elsewhere, 'alias.txt')), undefined);
  } catch {}
  // Bounded: the size is checked first and a larger file is never netted.
  writeFileSync(join(root, 'exact.txt'), 'x'.repeat(NET_TEXT_MAX_BYTES));
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(NET_TEXT_MAX_BYTES + 1));
  assert.equal((await currentText(root, 'exact.txt')).length, NET_TEXT_MAX_BYTES);
  assert.equal(await currentText(root, 'big.txt'), undefined);
  assert.equal(await currentText(root, '.'), undefined);
});

test('a file under a parent junction is not read, nor is NUL content diffed as text', { skip }, async () => {
  const root = sessionRoot('parent-link');
  const real = join(base, 'parent-link-real');
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, 'f.txt'), 'via the real path\n');
  const alias = join(base, 'parent-link-alias');
  let linked = true;
  try {
    symlinkSync(real, alias, 'junction');
  } catch {
    linked = false;
  }
  assert.equal(await currentText(root, join(real, 'f.txt')), 'via the real path\n');
  if (linked) assert.equal(await currentText(root, join(alias, 'f.txt')), undefined);
  writeFileSync(join(root, 'bin.dat'), Buffer.from('text\0more\n'));
  assert.equal(await currentText(root, 'bin.dat'), undefined);
  const file = trackedChangeFile({ oldPath: 'bin.dat', newPath: 'bin.dat', before: null, after: Buffer.from('a\0b') });
  assert.equal(file.binary, true);
  // Binary content replays as a git binary patch, never as text hunks.
  assert.equal(file.revertable, true);
  assert.match(file.patch.toString('utf8'), /^GIT binary patch$/m);
});

// ── Delete history ──────────────────────────────────────────────────────────

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** A committed repository holding `files`. */
function gitRepo(name, files) {
  const repo = join(base, `repo-${name}`);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeTree(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');
  return realpathSync.native(repo);
}

/** One sealed Git turn whose own tools write `edits` while it runs. */
async function gitTurn(repo, sessionId, checkpointId, edits) {
  await beginTurnSnapshot(repo, sessionId, { checkpointId });
  const changes = Object.entries(edits).map(([path, after]) => ({
    path: join(repo, path),
    displayPath: path,
    before: existsSync(join(repo, path)) ? readFileSync(join(repo, path)) : null,
    after,
  }));
  writeTree(repo, edits);
  recordTurnDiffChanges(sessionId, changes);
  await completeTurnSnapshot(sessionId);
}

const gitState = (repo) => [
  git(repo, 'rev-parse', 'HEAD'),
  git(repo, 'status', '--porcelain'),
  git(repo, 'diff', '--cached'),
];
const historyTurns = async (repo, sessionId) => (await getTurnReviewDiff(repo, sessionId)).historyTurns;

test('Delete history empties the records for good, never touches files or Git, and tracks later edits', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'delete-history';
  const repo = gitRepo(sessionId, { 'a.txt': 'a\n', 'c.txt': 'c\n' });
  await gitTurn(repo, sessionId, 'cp-1', { 'a.txt': 'a\nA2\n' });
  await gitTurn(repo, sessionId, 'cp-2', { 'a.txt': 'a\nA2\nA3\n' });
  assert.equal((await getTurnChanges(sessionId, { checkpointId: 'cp-2' })).status, 'ready');
  assert.equal(await historyTurns(repo, sessionId), 2);
  const before = gitState(repo);
  const disk = readTree(repo, ['a.txt', 'c.txt']);

  // Refused while a turn runs.
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-busy' });
  await assert.rejects(clearSessionChangeHistory(sessionId), /running a turn/);
  await completeTurnSnapshot(sessionId);

  assert.deepEqual(await clearSessionChangeHistory(sessionId), { turns: 3 });
  assert.deepEqual(gitState(repo), before, 'HEAD, index and status are untouched');
  assert.deepEqual(readTree(repo, ['a.txt', 'c.txt']), disk, 'files are untouched');
  for (const restart of [false, true]) {
    if (restart) _resetTurnSnapshotForTest();
    const review = await getSessionReviewDiff(repo, sessionId);
    // Complete and empty: nothing (the transcript included) may resurface it.
    assert.deepEqual([review.files, review.complete], [[], true]);
    assert.equal((await getTurnChanges(sessionId, { checkpointId: 'cp-1' })).status, 'missing');
    const turnReview = await getTurnReviewDiff(repo, sessionId);
    assert.deepEqual([turnReview.files, turnReview.historyTurns], [[], 0]);
  }

  // Edits from the next turn on are tracked again; the old ones stay forgotten.
  await gitTurn(repo, sessionId, 'cp-3', { 'c.txt': 'c\nC2\n' });
  const review = await getSessionReviewDiff(repo, sessionId);
  assert.deepEqual(
    review.files.map((file) => file.path),
    ['c.txt']
  );
  assert.equal(Object.hasOwn(review, 'historyTurns'), false);
  assert.equal(await historyTurns(repo, sessionId), 1);
});

test('a worker finishing while history is being deleted cannot write the old turn back', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const { beginAgentTurnReview, completeAgentTurnReview } = snapshotModule;
  const sessionId = 'delete-history-race';
  const repo = gitRepo(sessionId, { 'a.txt': 'a\n', 'w.txt': 'w\n' });
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-old' });
  const worker = beginAgentTurnReview(sessionId, `${sessionId}-worker`, { agent: 'worker' });
  writeTree(repo, { 'a.txt': 'a\nA2\n' });
  recordTurnDiffChanges(sessionId, [
    { path: join(repo, 'a.txt'), displayPath: 'a.txt', before: 'a\n', after: 'a\nA2\n' },
  ]);
  await completeTurnSnapshot(sessionId);
  assert.equal((await getTurnChanges(sessionId, { checkpointId: 'cp-old' })).status, 'ready');

  writeTree(repo, { 'w.txt': 'w\nW2\n' });
  recordTurnDiffChanges(`${sessionId}-worker`, [
    { path: join(repo, 'w.txt'), displayPath: 'w.txt', before: 'w\n', after: 'w\nW2\n' },
  ]);
  // The deletion starts; before it lands the late worker completes and
  // queues a re-seal of the old turn with its tracker.
  const clearing = clearSessionChangeHistory(sessionId);
  completeAgentTurnReview(worker, ['diff --git a/w.txt b/w.txt\n--- a/w.txt\n+++ b/w.txt\n@@ -1 +1,2 @@\n w\n+W2\n']);
  assert.deepEqual(await clearing, { turns: 1 });
  // Drain the session's change lock: anything queued behind the delete has run.
  await revertTurnChanges(sessionId, 'drain', null, 1).catch(() => {});

  for (const restart of [false, true]) {
    if (restart) _resetTurnSnapshotForTest();
    assert.equal((await getTurnChanges(sessionId, { checkpointId: 'cp-old' })).status, 'missing');
    const review = await getSessionReviewDiff(repo, sessionId);
    assert.deepEqual([review.files, review.complete], [[], true]);
    assert.equal(await historyTurns(repo, sessionId), 0);
  }
});

test('Delete history of a non-Git session stays empty after a restart', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'delete-history-plain';
  const root = await plainTurn(sessionId, { 'a.txt': 'a\n' }, { 'a.txt': 'A\n' });
  assert.deepEqual(await clearSessionChangeHistory(sessionId), { turns: 1 });
  _resetTurnSnapshotForTest();
  const review = await getSessionReviewDiff(root, sessionId);
  assert.deepEqual([review.files, review.complete], [[], true]);
  assert.deepEqual(readTree(root, ['a.txt']), { 'a.txt': 'A\n' });
  await trackedTurn(sessionId, root, 'cp-next', [{ path: 'b.txt', before: null, after: 'b\n' }]);
  writeTree(root, { 'b.txt': 'b\n' });
  assert.deepEqual(reviewShape(await getSessionReviewDiff(root, sessionId)), [['b.txt', '', 'A', 1, 0]]);
});

// ── Session baseline store: ordering, merging and bounds ───────────────────

const baselineIndexPath = (sessionId) =>
  join(
    process.env.MIXDOG_DATA_DIR,
    'turn-snapshots',
    'baselines',
    `${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}.json`
  );
const baselineKeys = (baselines) => (baselines?.files || []).map((entry) => entry.path).sort();

test('a restarted worker’s capture stays ahead of a later Lead capture whose owner lookup is faster', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'order-restart';
  const worker = `${lead}-worker`;
  const root = sessionRoot(lead);
  const note = join(root, 'note.txt');
  recordReviewOwner(worker, lead);
  await _settleSessionBaselinesForTest();
  // Restart: the attribution must come back from disk.
  _resetTurnSnapshotForTest();
  writeFileSync(note, 'new\n');
  // The worker deletes the file, then the Lead recreates it — no await between.
  captureSessionBaselines(worker, [{ path: note, root, before: 'old\n', replaced: true }]);
  captureSessionBaselines(lead, [{ path: note, root, before: null, replaced: true }]);
  // A load issued right after the captures sees them.
  assert.deepEqual(baselineKeys(await loadSessionBaselines(lead)), [note]);
  const review = await getSessionReviewDiff(root, lead);
  assert.deepEqual(reviewShape(review), [['note.txt', '', 'M', 1, 1]]);
  assert.match(review.patch, /^-old\n\+new$/m);
});

test('a clear wins over every capture issued before it, and later captures start fresh', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'order-clear';
  const worker = `${lead}-worker`;
  const root = sessionRoot(lead);
  recordReviewOwner(worker, lead);
  await _settleSessionBaselinesForTest();
  _resetTurnSnapshotForTest();
  // The worker's owner lookup is still pending when the clear is issued.
  captureSessionBaselines(worker, [{ path: join(root, 'old.txt'), root, before: 'old\n' }]);
  const cleared = clearSessionBaselines(lead);
  captureSessionBaselines(lead, [{ path: join(root, 'new.txt'), root, before: 'new\n' }]);
  await cleared;
  await _settleSessionBaselinesForTest();
  assert.deepEqual(baselineKeys(await loadSessionBaselines(lead)), [join(root, 'new.txt')]);
  _resetTurnSnapshotForTest();
  assert.deepEqual(baselineKeys(await loadSessionBaselines(lead)), [join(root, 'new.txt')]);
});

test('a baseline first seen after an older recorded edit never makes an empty review authoritative', {
  skip,
}, async () => {
  for (const variant of ['earlier', 'missing-createdAt']) {
    _resetTurnSnapshotForTest();
    const sessionId = `late-${variant}`;
    const root = sessionRoot(sessionId);
    writeTree(root, { 'x.txt': 'cur\n' });
    if (variant === 'missing-createdAt') {
      _setTurnChangeRecordWriteHookForTest((_id, records) => {
        for (const record of records) delete record.createdAt;
      });
    }
    try {
      await upsertTurnChangeRecord(sessionId, {
        checkpointId: 'old',
        kind: 'tracked',
        root,
        files: [{ path: 'x.txt', status: 'M', additions: 1, deletions: 1, revertable: false, patch: null }],
      });
    } finally {
      _setTurnChangeRecordWriteHookForTest(null);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The baseline is first recorded later, while the disk matches it.
    captureSessionBaselines(sessionId, [{ path: join(root, 'x.txt'), root, before: 'cur\n' }]);
    const review = await getSessionReviewDiff(root, sessionId);
    assert.deepEqual(
      [review.files, review.complete, review.partial, review.authoritative],
      [[], undefined, true, false],
      variant
    );
  }
});

test('a hash-equal evicted or oversized baseline hides its row but never certifies the review', {
  skip,
}, async () => {
  for (const status of ['evicted', 'omitted-oversized']) {
    _resetTurnSnapshotForTest();
    const sessionId = `hash-equal-${status}`;
    const root = sessionRoot(sessionId);
    const content = 'same\n';
    writeTree(root, { 'f.txt': content });
    const file = join(root, 'f.txt');
    mkdirSync(dirname(baselineIndexPath(sessionId)), { recursive: true });
    writeFileSync(
      baselineIndexPath(sessionId),
      JSON.stringify({
        version: 1,
        sessionId,
        createdAt: 1,
        files: [
          {
            key: changePathKey(file),
            path: file,
            root,
            state: 'present',
            status,
            size: Buffer.byteLength(content),
            sha256: createHash('sha256').update(content).digest('hex'),
            at: 1,
          },
        ],
        renames: [],
      })
    );
    const review = await getSessionReviewDiff(root, sessionId);
    assert.deepEqual(
      [review.files, review.complete, review.partial, review.authoritative],
      [[], undefined, true, false],
      status
    );
  }
});

test('two processes capturing different files of one session keep both', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'cross-process';
  const root = sessionRoot(sessionId);
  const [a, b, c] = ['a.txt', 'b.txt', 'c.txt'].map((name) => join(root, name));
  captureSessionBaselines(sessionId, [{ path: a, root, before: 'a\n' }]);
  await _settleSessionBaselinesForTest();
  // A second process writes the same index while this one has it cached.
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const store = await import(${JSON.stringify(new URL('./session-baseline-store.mjs', import.meta.url).href)});
       store.captureSessionBaselines(${JSON.stringify(sessionId)}, [{ path: ${JSON.stringify(b)}, root: ${JSON.stringify(root)}, before: 'b\\n' }]);
       await store._settleSessionBaselinesForTest();`,
    ],
    { encoding: 'utf8', env: process.env, windowsHide: true }
  );
  assert.equal(child.status, 0, child.stderr);
  captureSessionBaselines(sessionId, [{ path: c, root, before: 'c\n' }]);
  assert.deepEqual(baselineKeys(await loadSessionBaselines(sessionId)), [a, b, c]);
  _resetTurnSnapshotForTest();
  const reloaded = await loadSessionBaselines(sessionId);
  assert.deepEqual(baselineKeys(reloaded), [a, b, c]);
  assert.deepEqual((await reloaded.readBlob(reloaded.files.find((entry) => entry.path === b))).toString(), 'b\n');
});

test('entries merged in from another process are bounded on the next write', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'merge-bounds';
  const root = sessionRoot(sessionId);
  captureSessionBaselines(sessionId, [{ path: join(root, 'own.txt'), root, before: null }]);
  await _settleSessionBaselinesForTest();
  // Another process filled the index up to the bound meanwhile.
  const foreign = Array.from({ length: 4096 }, (_, index) => {
    const path = join(root, `foreign-${index}.txt`);
    return { key: changePathKey(path), path, root, state: 'absent', status: 'captured', size: 0, at: 2 };
  });
  writeFileSync(
    baselineIndexPath(sessionId),
    JSON.stringify({ version: 1, sessionId, createdAt: 1, files: foreign, renames: [] })
  );
  captureSessionBaselines(sessionId, [{ path: join(root, 'later.txt'), root, before: null }]);
  await _settleSessionBaselinesForTest();
  const stored = JSON.parse(readFileSync(baselineIndexPath(sessionId), 'utf8'));
  assert.ok(stored.files.length <= 4096);
  assert.equal(stored.incomplete, true);
  assert.ok(stored.files.some((entry) => entry.path === join(root, 'foreign-0.txt')));
});

test('renamed paths are bounded like files and mark the baselines incomplete past it', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'rename-bounds';
  const root = sessionRoot(sessionId);
  const changes = Array.from({ length: 10_000 }, (_, index) => ({
    path: join(root, `from-${index}.txt`),
    newPath: join(root, `to-${index}.txt`),
    root,
    before: '',
  }));
  captureSessionBaselines(sessionId, changes);
  const baselines = await loadSessionBaselines(sessionId);
  assert.ok(baselines.renames.size <= 4096, String(baselines.renames.size));
  assert.ok(baselines.files.length <= 4096);
  assert.equal(baselines.incomplete, true);
  const stored = JSON.parse(readFileSync(baselineIndexPath(sessionId), 'utf8'));
  assert.ok(stored.renames.length <= 4096);
});

test('measured review rows share one byte budget across sessions', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const budget = 16 * 1024 * 1024;
  for (const sessionId of ['rows-a', 'rows-b']) {
    const root = sessionRoot(sessionId);
    const changes = [];
    for (let index = 0; index < 50; index += 1) {
      const path = join(root, `big-${index}.txt`);
      writeFileSync(path, `${String(index).repeat(1)}${'x'.repeat(190_000)}\n`);
      changes.push({ path, root, before: null });
    }
    captureSessionBaselines(sessionId, changes);
    const review = await getSessionReviewDiff(root, sessionId);
    assert.equal(review.files.length, 50);
  }
  assert.ok(_rowCacheBytesForTest() > 0);
  assert.ok(_rowCacheBytesForTest() <= budget, String(_rowCacheBytesForTest()));
});

const storeUrl = new URL('./session-baseline-store.mjs', import.meta.url).href;
/** Run `body` in a second process, with the store imported as `store`. */
function inOtherProcess(body) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const store = await import(${JSON.stringify(storeUrl)});\n${body}\nawait store._settleSessionBaselinesForTest();`,
    ],
    { encoding: 'utf8', env: process.env, windowsHide: true }
  );
  assert.equal(child.status, 0, child.stderr);
}
/** A capture call in another process, issued at `at` (its clock stubbed). */
const captureIssuedAt = (at, sessionId, changes) =>
  `{ const now = Date.now; Date.now = () => ${at};
     store.captureSessionBaselines(${JSON.stringify(sessionId)}, ${JSON.stringify(changes)});
     Date.now = now; }`;

test('a capture another process issued before Delete history never brings the cleared baseline back', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'clear-cross-process';
  const root = sessionRoot(sessionId);
  const [gone, later] = ['gone.txt', 'later.txt'].map((name) => join(root, name));
  const issued = Date.now();
  captureSessionBaselines(sessionId, [{ path: gone, root, before: 'old\n' }]);
  await _settleSessionBaselinesForTest();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await clearSessionBaselines(sessionId);
  // Issued before the clear, held up (its owner lookup) until after it.
  inOtherProcess(captureIssuedAt(issued, sessionId, [{ path: gone, root, before: 'old\n' }]));
  assert.equal(await loadSessionBaselines(sessionId), null);
  _resetTurnSnapshotForTest();
  assert.equal(await loadSessionBaselines(sessionId), null);
  // Issued after the clear: a fresh baseline.
  inOtherProcess(captureIssuedAt(Date.now() + 5, sessionId, [{ path: later, root, before: null }]));
  assert.deepEqual(baselineKeys(await loadSessionBaselines(sessionId)), [later]);
});

test('renames two processes publish out of order net by when they were observed: one R', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'rename-cross-process';
  const root = sessionRoot(sessionId);
  const [oldFile, middle, newFile] = ['old.txt', 'middle.txt', 'new.txt'].map((name) => join(root, name));
  writeFileSync(newFile, 'body\n');
  const workerIssued = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The Lead's later rename middle→new is published first ...
  captureSessionBaselines(sessionId, [{ path: middle, newPath: newFile, root, before: 'body\n' }]);
  await _settleSessionBaselinesForTest();
  // ... then the worker's earlier rename old→middle, from another process.
  inOtherProcess(
    captureIssuedAt(workerIssued, sessionId, [{ path: oldFile, newPath: middle, root, before: 'body\n' }])
  );
  for (const review of await reviewTwice(root, sessionId)) {
    assert.deepEqual(reviewShape(review), [['new.txt', 'old.txt', 'R', 0, 0]]);
    assert.equal(review.complete, true);
  }
});

/** Make every baseline write of the session fail (a file where its blob
 *  directory goes); returns the undo. */
function refuseBaselineWrites(sessionId) {
  const blocker = baselineIndexPath(sessionId).replace(/\.json$/, '');
  mkdirSync(dirname(blocker), { recursive: true });
  writeFileSync(blocker, '');
  return () => rmSync(blocker);
}

test('a capture the disk refused is written with the next capture, even of the same file', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'retry-capture';
  const root = sessionRoot(sessionId);
  const file = join(root, 'kept.txt');
  writeFileSync(file, 'edited\n');
  const restore = refuseBaselineWrites(sessionId);
  captureSessionBaselines(sessionId, [{ path: file, root, before: 'first\n' }]);
  await _settleSessionBaselinesForTest();
  restore();
  // Nothing new to record for the file; the refused capture is still unwritten.
  captureSessionBaselines(sessionId, [{ path: file, root, before: 'edited\n' }]);
  await _settleSessionBaselinesForTest();
  _resetTurnSnapshotForTest();
  const reloaded = await loadSessionBaselines(sessionId);
  assert.deepEqual(baselineKeys(reloaded), [file]);
  assert.equal((await reloaded.readBlob(reloaded.files[0])).toString(), 'first\n');
});

test('a later capture whose first state a foreign clear removed is listed as missing, never dropped', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'redundant-after-clear';
  const root = sessionRoot(sessionId);
  const file = join(root, 'kept.txt');
  writeFileSync(file, 'now\n');
  const restore = refuseBaselineWrites(sessionId);
  // Refused by the disk: still unwritten when the clear lands.
  captureSessionBaselines(sessionId, [{ path: file, root, before: 'first\n' }]);
  await _settleSessionBaselinesForTest();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const clearIssued = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  // After the clear was issued; this process recorded the path already.
  captureSessionBaselines(sessionId, [{ path: file, root, before: 'second\n' }]);
  await _settleSessionBaselinesForTest();
  restore();
  // The other process's clear, issued before that capture, is published now.
  inOtherProcess(`{ const now = Date.now; Date.now = () => ${clearIssued};
    const cleared = store.clearSessionBaselines(${JSON.stringify(sessionId)});
    Date.now = now; await cleared; }`);
  for (const restart of [false, true]) {
    if (restart) _resetTurnSnapshotForTest();
    const baselines = await loadSessionBaselines(sessionId);
    assert.equal(baselines?.incomplete, true);
    const review = await getSessionReviewDiff(root, sessionId);
    assert.deepEqual(
      review.files.map((row) => [row.path, row.status, row.baseline]),
      [['kept.txt', 'M', 'missing']]
    );
    assert.deepEqual([review.partial, review.complete], [true, undefined]);
  }
});

test('an edit after a foreign clear stays listed even when an earlier edit of the file was held', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'redundant-twice-after-clear';
  const root = sessionRoot(sessionId);
  const file = join(root, 'kept.txt');
  writeFileSync(file, 'now\n');
  const restore = refuseBaselineWrites(sessionId);
  captureSessionBaselines(sessionId, [{ path: file, root, before: 'first\n' }]);
  // A second edit before the clear: recorded nothing, held for the file.
  captureSessionBaselines(sessionId, [{ path: file, root, before: 'second\n' }]);
  await _settleSessionBaselinesForTest();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const clearIssued = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The edit after the clear was issued must survive it.
  captureSessionBaselines(sessionId, [{ path: file, root, before: 'third\n' }]);
  await _settleSessionBaselinesForTest();
  restore();
  inOtherProcess(`{ const now = Date.now; Date.now = () => ${clearIssued};
    const cleared = store.clearSessionBaselines(${JSON.stringify(sessionId)});
    Date.now = now; await cleared; }`);
  for (const restart of [false, true]) {
    if (restart) _resetTurnSnapshotForTest();
    const review = await getSessionReviewDiff(root, sessionId);
    assert.deepEqual(
      review.files.map((row) => [row.path, row.status, row.baseline]),
      [['kept.txt', 'M', 'missing']]
    );
    assert.deepEqual([review.partial, review.complete], [true, undefined]);
  }
});

test('a refused capture is reported, never complete, until a load writes it', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'retry-load';
  const root = sessionRoot(sessionId);
  const file = join(root, 'kept.txt');
  writeFileSync(file, 'edited\n');
  const restore = refuseBaselineWrites(sessionId);
  captureSessionBaselines(sessionId, [{ path: file, root, before: 'first\n' }]);
  assert.equal((await loadSessionBaselines(sessionId)).unsaved, true);
  const refused = await getSessionReviewDiff(root, sessionId);
  assert.deepEqual(reviewShape(refused), [['kept.txt', '', 'M', 1, 1]]);
  assert.deepEqual([refused.baselinesUnsaved, refused.partial, refused.complete], [true, true, undefined]);
  restore();
  assert.equal((await loadSessionBaselines(sessionId)).unsaved, undefined);
  _resetTurnSnapshotForTest();
  const reloaded = await loadSessionBaselines(sessionId);
  assert.deepEqual(baselineKeys(reloaded), [file]);
  const review = await getSessionReviewDiff(root, sessionId);
  assert.deepEqual([review.baselinesUnsaved, review.complete], [undefined, true]);
});

test('unsaved captures hold only first-seen bytes, within the session byte budget', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'unsaved-bytes';
  const root = sessionRoot(sessionId);
  const file = join(root, 'churn.txt');
  const restore = refuseBaselineWrites(sessionId);
  // One path deleted and recreated over and over: only its first state counts.
  const body = Buffer.alloc(512 * 1024, 'x');
  for (let index = 0; index < 192; index += 1) {
    captureSessionBaselines(sessionId, [
      { path: file, root, before: index % 2 === 0 ? Buffer.from(body) : null, replaced: true },
    ]);
  }
  await _settleSessionBaselinesForTest();
  assert.ok(_unsavedBytesForTest(sessionId) <= body.length, String(_unsavedBytesForTest(sessionId)));
  // Distinct first states past the session budget: bounded, and incomplete.
  const budget = 64 * 1024 * 1024;
  for (let index = 0; index < 70; index += 1) {
    const before = Buffer.alloc(1024 * 1024, 'y');
    before.write(`file ${index}\n`);
    captureSessionBaselines(sessionId, [{ path: join(root, `big-${index}.txt`), root, before }]);
  }
  await _settleSessionBaselinesForTest();
  assert.ok(_unsavedBytesForTest(sessionId) <= budget, String(_unsavedBytesForTest(sessionId)));
  assert.equal((await loadSessionBaselines(sessionId)).incomplete, true);
  restore();
  assert.equal((await loadSessionBaselines(sessionId)).unsaved, undefined);
  _resetTurnSnapshotForTest();
  const reloaded = await loadSessionBaselines(sessionId);
  assert.equal(reloaded.incomplete, true);
  // The churned path keeps its first state (the oldest bytes, evicted first).
  const churn = reloaded.files.find((entry) => entry.path === file);
  assert.deepEqual([churn.state, churn.status, churn.size], ['present', 'evicted', body.length]);
});

test('a delayed clear keeps the baselines captured after it was issued, and their bytes', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'delayed-clear';
  const root = sessionRoot(sessionId);
  const before = join(root, 'before.txt');
  const after = join(root, 'after.txt');
  writeFileSync(before, 'now\n');
  writeFileSync(after, 'now\n');
  captureSessionBaselines(sessionId, [{ path: before, root, before: 'old\n' }]);
  await _settleSessionBaselinesForTest();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const clearIssued = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Captured and written after the clear was issued, before it finishes.
  captureSessionBaselines(sessionId, [{ path: after, root, before: 'newer\n' }]);
  await _settleSessionBaselinesForTest();
  inOtherProcess(`{ const now = Date.now; Date.now = () => ${clearIssued};
    const cleared = store.clearSessionBaselines(${JSON.stringify(sessionId)});
    Date.now = now; await cleared; }`);
  for (const restart of [false, true]) {
    if (restart) _resetTurnSnapshotForTest();
    const baselines = await loadSessionBaselines(sessionId);
    assert.deepEqual(baselineKeys(baselines), [after]);
    assert.equal((await baselines.readBlob(baselines.files[0])).toString(), 'newer\n');
  }
});

test('a delayed clear lists a path captured before it and edited again after it as missing', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'delayed-clear-retouched';
  const root = sessionRoot(sessionId);
  const file = join(root, 'again.txt');
  writeFileSync(file, 'now\n');
  const t0 = Date.now() + 1000;
  const [t1, t2] = [t0 + 10, t0 + 20];
  // Two captures of one path, the second after the clear was issued.
  inOtherProcess(`${captureIssuedAt(t0, sessionId, [{ path: file, root, before: 'old\n' }])}
    await store._settleSessionBaselinesForTest();
    ${captureIssuedAt(t2, sessionId, [{ path: file, root, before: 'newer\n' }])}`);
  inOtherProcess(`{ const now = Date.now; Date.now = () => ${t1};
    const cleared = store.clearSessionBaselines(${JSON.stringify(sessionId)});
    Date.now = now; await cleared; }`);
  for (const restart of [false, true]) {
    if (restart) _resetTurnSnapshotForTest();
    const baselines = await loadSessionBaselines(sessionId);
    assert.ok(baselines, 'the post-clear edit is not forgotten');
    assert.deepEqual(baselineKeys(baselines), []);
    assert.deepEqual(
      baselines.missing.map((entry) => entry.path),
      [file]
    );
    assert.equal(baselines.incomplete, true);
  }
});

test('two delayed clears keep a path edited after both', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'delayed-double-clear';
  const root = sessionRoot(sessionId);
  const file = join(root, 'twice.txt');
  const other = join(root, 'older.txt');
  writeFileSync(file, 'now\n');
  const t0 = Date.now() + 1000;
  const [t1, t2, t3] = [t0 + 10, t0 + 20, t0 + 30];
  inOtherProcess(`${captureIssuedAt(t0, sessionId, [
    { path: file, root, before: 'old\n' },
    { path: other, root, before: 'old\n' },
  ])}
    await store._settleSessionBaselinesForTest();
    ${captureIssuedAt(t3, sessionId, [{ path: file, root, before: 'newer\n' }])}`);
  const clearAt = (at) =>
    inOtherProcess(`{ const now = Date.now; Date.now = () => ${at};
      const cleared = store.clearSessionBaselines(${JSON.stringify(sessionId)});
      Date.now = now; await cleared; }`);
  clearAt(t1);
  clearAt(t2);
  for (const restart of [false, true]) {
    if (restart) _resetTurnSnapshotForTest();
    const baselines = await loadSessionBaselines(sessionId);
    assert.ok(baselines, 'the edit after both clears is not forgotten');
    assert.deepEqual(baselineKeys(baselines), []);
    // `other` was last touched before the second clear: it is not carried.
    assert.deepEqual(
      baselines.missing.map((entry) => entry.path),
      [file]
    );
    assert.equal(baselines.incomplete, true);
  }
  // A clear issued after the edit ends it.
  clearAt(t3 + 10);
  _resetTurnSnapshotForTest();
  assert.equal(await loadSessionBaselines(sessionId), null);
});

test('a delayed clear keeps the incompleteness of a capture the entry limit rejected after it', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'delayed-clear-limit-rejected';
  const root = sessionRoot(sessionId);
  const t0 = Date.now() + 1000;
  const [t1, t2] = [t0 + 10, t0 + 20];
  // 4,096 entries before the clear, then one more path after it: rejected by
  // the limit. The capture clock runs ahead of the clock the index is written
  // with, so only the capture times can order them.
  inOtherProcess(`{ const now = Date.now; Date.now = () => ${t0};
    const root = ${JSON.stringify(root)};
    const changes = Array.from({ length: 4096 }, (_, index) => ({ path: root + '/full-' + index + '.txt', root, before: null }));
    store.captureSessionBaselines(${JSON.stringify(sessionId)}, changes);
    Date.now = now; }
    await store._settleSessionBaselinesForTest();
    ${captureIssuedAt(t2, sessionId, [{ path: join(root, 'rejected.txt'), root, before: null }])}`);
  inOtherProcess(`{ const now = Date.now; Date.now = () => ${t1};
    const cleared = store.clearSessionBaselines(${JSON.stringify(sessionId)});
    Date.now = now; await cleared; }`);
  for (const restart of [false, true]) {
    if (restart) _resetTurnSnapshotForTest();
    const baselines = await loadSessionBaselines(sessionId);
    assert.ok(baselines, 'the rejected post-clear edit is not forgotten');
    assert.deepEqual([baselines.files.length, baselines.incomplete], [0, true]);
  }
  // A clear issued after that capture starts clean.
  inOtherProcess(`{ const now = Date.now; Date.now = () => ${t2 + 10};
    const cleared = store.clearSessionBaselines(${JSON.stringify(sessionId)});
    Date.now = now; await cleared; }`);
  _resetTurnSnapshotForTest();
  assert.equal(await loadSessionBaselines(sessionId), null);
});

test('a clear drops an older index’s missing path and incompleteness that no capture after it explains', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'legacy-missing';
  const root = sessionRoot(sessionId);
  const path = join(root, 'old.txt');
  mkdirSync(dirname(baselineIndexPath(sessionId)), { recursive: true });
  // An index written before missing paths carried an edit time.
  writeFileSync(
    baselineIndexPath(sessionId),
    JSON.stringify({
      version: 1,
      sessionId,
      createdAt: 1,
      incomplete: true,
      files: [],
      missing: [{ key: changePathKey(path), path, root }],
    })
  );
  assert.deepEqual((await loadSessionBaselines(sessionId)).missing.map((entry) => entry.path), [path]);
  await clearSessionBaselines(sessionId);
  await clearSessionBaselines(sessionId);
  for (const restart of [false, true]) {
    if (restart) _resetTurnSnapshotForTest();
    assert.equal(await loadSessionBaselines(sessionId), null);
    const stored = JSON.parse(readFileSync(baselineIndexPath(sessionId), 'utf8'));
    assert.deepEqual([stored.missing, stored.incomplete], [undefined, undefined]);
  }
});

test('repeat edits of one path keep a bounded number of unwritten captures', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'touch-coalesce';
  const root = sessionRoot(sessionId);
  const file = join(root, 'churn.txt');
  const restore = refuseBaselineWrites(sessionId);
  for (let index = 0; index < 200; index += 1) {
    captureSessionBaselines(sessionId, [{ path: file, root, before: `v${index}\n` }]);
  }
  await _settleSessionBaselinesForTest();
  assert.ok(_pendingCapturesForTest(sessionId) <= 2, String(_pendingCapturesForTest(sessionId)));
  restore();
  const baselines = await loadSessionBaselines(sessionId);
  assert.equal(baselines.unsaved, undefined);
  assert.equal((await baselines.readBlob(baselines.files[0])).toString(), 'v0\n');
  const [entry] = JSON.parse(readFileSync(baselineIndexPath(sessionId), 'utf8')).files;
  assert.ok(entry.touched > entry.at, 'the latest edit time is kept');
});

test('a delayed clear keeps the incompleteness of the post-clear entries it carries', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'delayed-clear-incomplete';
  const root = sessionRoot(sessionId);
  const at = Date.now() + 1000;
  // Built in the child: 4,097 changes do not fit a command line.
  inOtherProcess(`{ const now = Date.now; Date.now = () => ${at + 10};
    const root = ${JSON.stringify(root)};
    const changes = Array.from({ length: 4097 }, (_, index) => ({ path: root + '/many-' + index + '.txt', root, before: null }));
    store.captureSessionBaselines(${JSON.stringify(sessionId)}, changes);
    Date.now = now; }`);
  const before = await loadSessionBaselines(sessionId);
  assert.deepEqual([before.files.length, before.incomplete], [4096, true]);
  inOtherProcess(`{ const now = Date.now; Date.now = () => ${at};
    const cleared = store.clearSessionBaselines(${JSON.stringify(sessionId)});
    Date.now = now; await cleared; }`);
  for (const restart of [false, true]) {
    if (restart) _resetTurnSnapshotForTest();
    const after = await loadSessionBaselines(sessionId);
    assert.deepEqual([after.files.length, after.incomplete], [4096, true]);
  }
});

test('a capture tied with another process’s clear is kept, but the review is never complete', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'clear-tie';
  const root = sessionRoot(sessionId);
  const file = join(root, 'tied.txt');
  writeFileSync(file, 'now\n');
  captureSessionBaselines(sessionId, [{ path: join(root, 'old.txt'), root, before: 'old\n' }]);
  await clearSessionBaselines(sessionId);
  const { clearedAt } = JSON.parse(readFileSync(baselineIndexPath(sessionId), 'utf8'));
  // Issued in the clear's very millisecond, after it completed: order unknown.
  inOtherProcess(captureIssuedAt(clearedAt, sessionId, [{ path: file, root, before: 'then\n' }]));
  for (const restart of [false, true]) {
    if (restart) _resetTurnSnapshotForTest();
    const baselines = await loadSessionBaselines(sessionId);
    assert.deepEqual([baselineKeys(baselines), baselines?.incomplete], [[file], true]);
    const review = await getSessionReviewDiff(root, sessionId);
    assert.deepEqual(reviewShape(review), [['tied.txt', '', 'M', 1, 1]]);
    assert.deepEqual([review.partial, review.complete], [true, undefined]);
  }
});
