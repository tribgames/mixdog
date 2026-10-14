// Per-turn change records, fast lane: non-Git turns (exact tracker patches),
// size-dropped patches, composer Undo bookkeeping and record-write faults.
// The Git-repository integration cases live in turn-changes.slow.test.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
  beginTurnSnapshot,
  clearSessionChangeHistory,
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
const {
  CHANGE_STATE_UNKNOWN_REASON,
  MERGED_PATCH_MAX_BYTES,
  NET_TEXT_MAX_BYTES,
  TURN_CHANGE_FILE_PATCH_MAX_BYTES,
  currentText,
  mergeRecordedSessionChanges,
  storedChangeFile,
  trackedChangeFile,
  turnChangesReply,
} = await import('./turn-changes.mjs');
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
  const { beginAgentTurnReview, completeAgentTurnReview } = snapshotModule;
  const lead = 'review-with-worker';
  const root = sessionRoot(lead);
  writeFileSync(join(root, 'lead.txt'), 'lead\n');
  writeFileSync(join(root, 'worker.txt'), 'worker\n');
  const token = await beginTurnSnapshot(root, lead, { checkpointId: 'cp' });
  const worker = beginAgentTurnReview(lead, `${lead}-worker`, { agent: 'worker' });
  // The worker runs its own session turn, which records its own change.
  await trackedTurn(`${lead}-worker`, root, 'worker-cp', [{ path: 'worker.txt', before: null, after: 'worker\n' }]);
  completeAgentTurnReview(worker);
  recordTurnDiffChanges(lead, [{ path: join(root, 'lead.txt'), displayPath: 'lead.txt', before: null, after: 'lead\n' }]);
  await completeTurnSnapshot(lead, token);
  const [live, restarted] = await reviewTwice(root, lead);
  assert.deepEqual(live.files.map((file) => file.path).sort(), ['lead.txt', 'worker.txt']);
  assert.deepEqual(reviewShape(live), reviewShape(restarted));
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

test('an old record without before-text or display patch still lists its file for the island fallback', {
  skip,
}, async () => {
  const legacy = {
    checkpointId: 'old',
    kind: 'tracked',
    root: join(base, 'legacy-root'),
    files: [
      {
        path: 'C:/x/legacy.txt',
        status: 'A',
        additions: 0,
        deletions: 0,
        revertable: false,
        reason: 'file is outside the recorded root',
        patch: null,
        state: 'applied',
      },
      {
        path: 'kept.txt',
        status: 'A',
        additions: 3,
        deletions: 0,
        revertable: true,
        patch:
          'diff --git a/kept.txt b/kept.txt\nnew file mode 100644\n--- /dev/null\n+++ b/kept.txt\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n',
        patchEncoding: 'utf8',
        state: 'applied',
      },
    ],
  };
  const merged = await mergeRecordedSessionChanges({ supported: true, files: [], patch: '', source: 'absent' }, [
    legacy,
  ]);
  const byPath = Object.fromEntries(merged.files.map((file) => [file.path, file]));
  assert.equal(byPath['C:/x/legacy.txt'].unmeasured, true);
  assert.equal(byPath['kept.txt'].additions, 3);
  assert.equal(merged.complete, true);
  // Absent history with nothing recorded is neither complete nor an invented
  // empty set: the transcript may still know more.
  const absent = await mergeRecordedSessionChanges({ supported: true, files: [], patch: '', source: 'absent' }, []);
  assert.deepEqual([absent.supported, absent.files, absent.complete], [true, [], undefined]);
  const emptyKnown = await mergeRecordedSessionChanges({ supported: true, files: [], patch: '', source: 'empty' }, []);
  assert.equal(emptyKnown.complete, true);
  // A missing baseline with nothing recorded stays unavailable, not empty.
  const unavailable = await mergeRecordedSessionChanges(
    { supported: false, files: [], patch: '', source: 'unavailable', reason: 'r' },
    []
  );
  assert.equal(unavailable.supported, false);
});
test('the merged review stays under its patch budget and lists a file past it without its diff', { skip }, async () => {
  const big = (name) => ({
    path: name,
    status: 'A',
    additions: 1,
    deletions: 0,
    revertable: true,
    patch: `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+${'x'.repeat(1_500_000)}\n`,
    patchEncoding: 'utf8',
    state: 'applied',
  });
  const merged = await mergeRecordedSessionChanges({ supported: true, files: [], patch: '', source: 'absent' }, [
    { checkpointId: 'big', kind: 'tracked', root: join(base, 'big-root'), files: [big('a.txt'), big('b.txt')] },
  ]);
  assert.equal(merged.files.length, 2);
  assert.equal(merged.files.filter((file) => file.patchOmitted === true).length, 1);
  assert.equal(merged.patchTruncated, true);
  assert.ok(Buffer.byteLength(merged.patch, 'utf8') <= MERGED_PATCH_MAX_BYTES);
  // The budget counts bytes, not characters: multi-byte text fills it sooner.
  const wide = (name) => ({ ...big(name), patch: big(name).patch.replace(/x{100,}/, '한'.repeat(500_000)) });
  const wideMerged = await mergeRecordedSessionChanges({ supported: true, files: [], patch: '', source: 'absent' }, [
    { checkpointId: 'wide', kind: 'tracked', root: join(base, 'wide-root'), files: [wide('a.txt'), wide('b.txt')] },
  ]);
  assert.equal(wideMerged.files.filter((file) => file.patchOmitted === true).length, 1);
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
  // An old record that still carries one is ignored, and the file still nets.
  const legacy = await mergeRecordedSessionChanges({ supported: true, files: [], patch: '', source: 'empty' }, [
    { ...record, files: record.files.map((file) => ({ ...file, baseKnown: true, baseText: 'WRONG\n' })) },
  ]);
  assert.deepEqual(
    legacy.files.filter((file) => file.path === 'a.txt').map((file) => [file.additions, file.deletions]),
    [[1, 1]]
  );
  assert.equal(legacy.patch.includes('WRONG'), false);
});

test('the net review rebuilds the original by reverse-applying the recorded patches', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'review-reverse';
  const root = sessionRoot(sessionId);
  writeTree(root, { 'doc.txt': 'a\nB\nc\nd\n' });
  await trackedTurn(sessionId, root, 'cp-1', [{ path: 'doc.txt', before: 'a\nb\nc\n', after: 'a\nB\nc\n' }]);
  writeTree(root, { 'doc.txt': 'a\nB\nc\nd\n' });
  await trackedTurn(sessionId, root, 'cp-2', [{ path: 'doc.txt', before: 'a\nB\nc\n', after: 'a\nB\nc\nd\n' }]);
  const [live, restarted] = await reviewTwice(root, sessionId);
  assert.deepEqual(reviewShape(restarted), [['doc.txt', '', 'M', 2, 1]]);
  assert.deepEqual(reviewShape(live), reviewShape(restarted));
  // The file changed behind the records' back: the patches no longer match,
  // so the review falls back to the per-turn diffs instead of inventing one.
  writeTree(root, { 'doc.txt': 'totally\ndifferent\n' });
  const fallback = await getSessionReviewDiff(root, sessionId);
  assert.deepEqual(reviewShape(fallback), [['doc.txt', '', 'M', 2, 1]]);
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

test('the per-turn fallback re-heads each patch with the emitted path, so two roots stay two rows', {
  skip,
}, async () => {
  const patch = (line) =>
    `diff --git a/x.txt b/x.txt\nnew file mode 100644\n--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1 @@\n+${line}\n`;
  const entry = (line) => ({
    path: 'x.txt',
    status: 'A',
    additions: 1,
    deletions: 0,
    revertable: true,
    patch: patch(line),
    patchEncoding: 'utf8',
    state: 'applied',
  });
  const first = join(base, 'fallback-a');
  const second = join(base, 'fallback-b');
  const merged = await mergeRecordedSessionChanges({ supported: true, files: [], patch: '', source: 'empty' }, [
    { checkpointId: 'fa', kind: 'tracked', root: first, files: [entry('one')] },
    { checkpointId: 'fb', kind: 'tracked', root: second, files: [entry('two')] },
  ]);
  assert.equal(merged.files.length, 2);
  for (const file of merged.files) {
    assert.ok(file.path.endsWith('/x.txt') && file.path !== 'x.txt');
    assert.ok(merged.patch.includes(`diff --git a/${file.path} b/${file.path}\n`));
    assert.ok(merged.patch.includes(`+++ b/${file.path}\n`));
  }
  assert.equal(merged.patch.includes('a/x.txt b/x.txt'), false);
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
  assert.equal(file.revertable, false);
});

// ── Island count (uncommitted vs HEAD) and Delete history ──────────────────

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

/** One sealed Git turn that writes `edits` while it runs. */
async function gitTurn(repo, sessionId, checkpointId, edits) {
  await beginTurnSnapshot(repo, sessionId, { checkpointId });
  writeTree(repo, edits);
  await completeTurnSnapshot(sessionId);
}

const islandShape = (review) =>
  (review.uncommittedFiles || []).map((file) => [file.path, file.status, file.additions, file.deletions]);
const gitState = (repo) => [git(repo, 'rev-parse', 'HEAD'), git(repo, 'status', '--porcelain'), git(repo, 'diff', '--cached')];

test('the island counts only session files still differing from HEAD; the session review keeps them all', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'island-head';
  const repo = gitRepo(sessionId, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'user.txt': 'u\n' });
  // Dirty before the session touched anything: never the session's.
  writeTree(repo, { 'user.txt': 'user edit\n' });
  await gitTurn(repo, sessionId, 'cp', { 'a.txt': 'a\nA2\n', 'b.txt': 'b\nB2\nB3\n', 'new.txt': 'n\n' });
  let review = await getSessionReviewDiff(repo, sessionId);
  assert.deepEqual(islandShape(review), [
    ['a.txt', 'M', 1, 0],
    ['b.txt', 'M', 2, 0],
    ['new.txt', 'A', 1, 0],
  ]);
  assert.equal(review.historyTurns, 1);

  // Committing a file removes it; staging alone does not.
  git(repo, 'add', 'a.txt', 'new.txt');
  git(repo, 'commit', '-qm', 'take a');
  git(repo, 'add', 'b.txt');
  review = await getSessionReviewDiff(repo, sessionId);
  assert.deepEqual(islandShape(review), [['b.txt', 'M', 2, 0]]);
  // The Changes panel's session-wide set is unchanged by the commit.
  assert.deepEqual(review.files.map((file) => file.path).sort(), ['a.txt', 'b.txt', 'new.txt']);

  // A file returned to its HEAD bytes disappears, across a restart too.
  writeTree(repo, { 'b.txt': 'b\n' });
  _resetTurnSnapshotForTest();
  review = await getSessionReviewDiff(repo, sessionId);
  assert.deepEqual(islandShape(review), []);
  assert.equal(review.complete, true);
});

test('a non-Git session keeps its session-based count (no HEAD set)', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'island-plain';
  const root = await plainTurn(sessionId, { 'a.txt': 'a\n' }, { 'a.txt': 'A\n' });
  const review = await getSessionReviewDiff(root, sessionId);
  assert.equal(review.uncommittedFiles, undefined);
  assert.deepEqual(reviewShape(review), [['a.txt', '', 'M', 1, 1]]);
});

test('Delete history empties the records for good, never touches files or Git, and tracks later edits', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'delete-history';
  const repo = gitRepo(sessionId, { 'a.txt': 'a\n', 'c.txt': 'c\n' });
  await gitTurn(repo, sessionId, 'cp-1', { 'a.txt': 'a\nA2\n' });
  await gitTurn(repo, sessionId, 'cp-2', { 'a.txt': 'a\nA2\nA3\n' });
  assert.equal((await getTurnChanges(sessionId, { checkpointId: 'cp-2' })).status, 'ready');
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
    assert.deepEqual([review.files, review.complete, review.historyTurns], [[], true, 0]);
    assert.deepEqual(islandShape(review), []);
    assert.equal((await getTurnChanges(sessionId, { checkpointId: 'cp-1' })).status, 'missing');
    assert.deepEqual((await getTurnReviewDiff(repo, sessionId)).files, []);
  }

  // Edits from the next turn on are tracked again; the old ones stay forgotten.
  await gitTurn(repo, sessionId, 'cp-3', { 'c.txt': 'c\nC2\n' });
  const review = await getSessionReviewDiff(repo, sessionId);
  assert.deepEqual(review.files.map((file) => file.path), ['c.txt']);
  assert.deepEqual(islandShape(review), [['c.txt', 'M', 1, 0]]);
  assert.equal(review.historyTurns, 1);
});

test('a worker finishing while history is being deleted cannot write the old turn back', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const { beginAgentTurnReview, completeAgentTurnReview } = snapshotModule;
  const sessionId = 'delete-history-race';
  const repo = gitRepo(sessionId, { 'a.txt': 'a\n', 'w.txt': 'w\n' });
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-old' });
  const worker = beginAgentTurnReview(sessionId, `${sessionId}-worker`, { agent: 'worker' });
  writeTree(repo, { 'a.txt': 'a\nA2\n' });
  await completeTurnSnapshot(sessionId);
  assert.equal((await getTurnChanges(sessionId, { checkpointId: 'cp-old' })).status, 'ready');

  // The deletion starts; before it lands the late worker completes and
  // queues a re-seal of the old turn with its tracker.
  const clearing = clearSessionChangeHistory(sessionId);
  writeTree(repo, { 'w.txt': 'w\nW2\n' });
  completeAgentTurnReview(worker, ['diff --git a/w.txt b/w.txt\n--- a/w.txt\n+++ b/w.txt\n@@ -1 +1,2 @@\n w\n+W2\n']);
  assert.deepEqual(await clearing, { turns: 1 });
  // Drain the session's change lock: anything queued behind the delete has run.
  await revertTurnChanges(sessionId, 'drain', null, 1).catch(() => {});

  for (const restart of [false, true]) {
    if (restart) _resetTurnSnapshotForTest();
    assert.equal((await getTurnChanges(sessionId, { checkpointId: 'cp-old' })).status, 'missing');
    const review = await getSessionReviewDiff(repo, sessionId);
    assert.deepEqual([review.files, review.complete, review.historyTurns], [[], true, 0]);
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
