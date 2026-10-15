// Per-turn change records in real Git repositories (slow lane): freezing,
// revision upsert, cancelled turns, re-seal races and historical Undo/Reapply
// (whole turn and per file), including the Windows line-ending shapes (CRLF,
// .gitattributes eol, autocrlf, missing final newline) and Unicode/space
// paths with add/delete/rename.
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
  _setTurnOpenedHookForTest,
  beginAgentTurnReview,
  beginTurnSnapshot,
  completeAgentTurnReview,
  completeTurnSnapshot,
  getSessionReviewDiff,
  getTurnChanges,
  getTurnReviewDiff,
  reapplyTurnChanges,
  recordTurnDiffChanges,
  revertTurnChanges,
  revertTurnReview,
} = snapshotModule;
const { createSnapshotTrackerFactory } = await import('../../session-runtime/turn/turn-run/snapshot-tracker.mjs');
const { loadTurnChangeRecord } = await import('./turn-snapshot-store.mjs');

let seq = 0;
function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** A committed repository; `config` entries are applied before the seed commit. */
function seedRepo(files, { config = {}, attributes = '' } = {}) {
  const repo = join(base, `repo-${++seq}`);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'false');
  for (const [key, value] of Object.entries(config)) git(repo, 'config', key, value);
  if (attributes) writeFileSync(join(repo, '.gitattributes'), attributes);
  writeTree(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');
  return realpathSync.native(repo);
}

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

const shape = (reply) => reply.files.map((file) => [file.path, file.oldPath || '', file.status, file.state]);

test('a sealed turn freezes a revisioned, exact per-file record keyed by checkpoint', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const repo = seedRepo({ 'a.txt': 'one\ntwo\n', 'b.txt': 'gone\n', 'c.txt': 'moved content\nline\nline\n' });
  await beginTurnSnapshot(repo, 'freeze', { checkpointId: 'cp-1' });
  const pending = await getTurnChanges('freeze', { checkpointId: 'cp-1' });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.canUndo, false);
  writeTree(repo, { 'a.txt': 'one\nTWO\n', 'b.txt': null, 'c.txt': null, 'd.txt': 'moved content\nline\nline\n' });
  writeTree(repo, { 'bin.dat': Buffer.from([0, 1, 2, 255, 0, 10]) });
  assert.equal(await completeTurnSnapshot('freeze'), true);

  const reply = await getTurnChanges('freeze', { checkpointId: 'cp-1' });
  assert.equal(reply.status, 'ready');
  assert.equal(reply.revision, 1);
  assert.equal(reply.root, repo);
  assert.deepEqual(shape(reply), [
    ['a.txt', '', 'M', 'applied'],
    ['b.txt', '', 'D', 'applied'],
    ['bin.dat', '', 'A', 'applied'],
    ['d.txt', 'c.txt', 'R', 'applied'],
  ]);
  assert.deepEqual(
    reply.files.map((file) => [file.additions, file.deletions, file.binary === true, file.revertable]),
    [
      [1, 1, false, true],
      [0, 1, false, true],
      [0, 0, true, true],
      [0, 0, false, true],
    ]
  );
  assert.equal(reply.canUndo, true);
  assert.equal(reply.canReapply, false);
  assert.equal(Object.hasOwn(reply, 'patch'), false);
  const one = await getTurnChanges('freeze', { checkpointId: 'cp-1', patch: true, file: 'a.txt' });
  assert.match(one.patch, /^diff --git a\/a\.txt b\/a\.txt\n/);
  assert.match(one.patch, /-two\n\+TWO\n/);
  assert.doesNotMatch(one.patch, /b\.txt/);
  const all = await getTurnChanges('freeze', { checkpointId: 'cp-1', patch: true });
  assert.match(all.patch, /GIT binary patch/);
  assert.match(all.patch, /rename from c\.txt\nrename to d\.txt/);

  // An unknown checkpoint is missing — never the latest turn.
  const unknown = await getTurnChanges('freeze', { checkpointId: 'cp-unknown' });
  assert.deepEqual([unknown.status, unknown.files, unknown.canUndo, unknown.canReapply], ['missing', [], false, false]);
  await assert.rejects(getTurnChanges('freeze', {}), /checkpointId is required/);

  // A turn that changed nothing is `none`.
  await beginTurnSnapshot(repo, 'freeze', { checkpointId: 'cp-2' });
  await completeTurnSnapshot('freeze');
  assert.equal((await getTurnChanges('freeze', { checkpointId: 'cp-2' })).status, 'none');
  // The earlier record survives the newer turn and a runtime restart.
  _resetTurnSnapshotForTest();
  assert.equal((await getTurnChanges('freeze', { checkpointId: 'cp-1' })).revision, 1);
});

test('whole-turn and per-file Undo/Reapply restore exact bytes and bump the revision', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const repo = seedRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'keep.txt': 'keep\n' });
  const paths = ['a.txt', 'b.txt', 'new.txt', 'keep.txt'];
  const before = readTree(repo, paths);
  await beginTurnSnapshot(repo, 'undo', { checkpointId: 'cp' });
  writeTree(repo, { 'a.txt': 'A\n', 'b.txt': null, 'new.txt': 'new\n' });
  await completeTurnSnapshot('undo');
  const after = readTree(repo, paths);
  let reply = await getTurnChanges('undo', { checkpointId: 'cp' });

  await assert.rejects(revertTurnChanges('undo', 'cp', null, reply.revision + 1), /turn changes changed; refresh/);
  reply = await revertTurnChanges('undo', 'cp', 'a.txt', reply.revision);
  assert.equal(reply.revision, 2);
  assert.deepEqual(readTree(repo, ['a.txt']), { 'a.txt': before['a.txt'] });
  assert.deepEqual(
    reply.files.map((file) => [file.path, file.state]),
    [
      ['a.txt', 'reverted'],
      ['b.txt', 'applied'],
      ['new.txt', 'applied'],
    ]
  );
  assert.equal(reply.canUndo, true);
  assert.equal(reply.canReapply, true);
  await assert.rejects(revertTurnChanges('undo', 'cp', 'a.txt', reply.revision), /already undone/);

  // Whole-turn Undo reverses only the still-applied files.
  reply = await revertTurnChanges('undo', 'cp', null, reply.revision);
  assert.equal(reply.revision, 3);
  assert.deepEqual(readTree(repo, paths), before);
  assert.equal(reply.canUndo, false);
  assert.match(reply.reason, /already undone/);
  await assert.rejects(revertTurnChanges('undo', 'cp', null, reply.revision), /no changes to be undone/);

  reply = await reapplyTurnChanges('undo', 'cp', 'new.txt', reply.revision);
  assert.equal(readTree(repo, ['new.txt'])['new.txt'], after['new.txt']);
  reply = await reapplyTurnChanges('undo', 'cp', null, reply.revision);
  assert.deepEqual(readTree(repo, paths), after);
  assert.equal(reply.revision, 5);
  assert.deepEqual(
    reply.files.map((file) => file.state),
    ['applied', 'applied', 'applied']
  );
  assert.equal(reply.canReapply, false);
});

test('a conflicting Undo refuses entirely and surfaces git’s error', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const repo = seedRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  await beginTurnSnapshot(repo, 'conflict', { checkpointId: 'cp' });
  writeTree(repo, { 'a.txt': 'A\n', 'b.txt': 'B\n' });
  await completeTurnSnapshot('conflict');
  const reply = await getTurnChanges('conflict', { checkpointId: 'cp' });
  // A later edit conflicts with a.txt's recorded patch.
  writeTree(repo, { 'a.txt': 'edited later\n' });
  await assert.rejects(revertTurnChanges('conflict', 'cp', null, reply.revision), (error) => {
    assert.match(error.message, /worktree was not changed/);
    assert.match(error.message, /a\.txt/);
    return true;
  });
  // No partial undo: b.txt keeps its turn edit and nothing changed state.
  assert.deepEqual(readTree(repo, ['a.txt', 'b.txt']), { 'a.txt': 'edited later\n', 'b.txt': 'B\n' });
  const after = await getTurnChanges('conflict', { checkpointId: 'cp' });
  assert.equal(after.revision, reply.revision);
  assert.deepEqual(
    after.files.map((file) => file.state),
    ['applied', 'applied']
  );
  // The clean file still undoes on its own.
  await revertTurnChanges('conflict', 'cp', 'b.txt', after.revision);
  assert.equal(readTree(repo, ['b.txt'])['b.txt'], 'b\n');
});

test('mutations are refused while the session runs a turn', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const repo = seedRepo({ 'a.txt': 'a\n' });
  await beginTurnSnapshot(repo, 'busy', { checkpointId: 'cp-1' });
  writeTree(repo, { 'a.txt': 'A\n' });
  await completeTurnSnapshot('busy');
  const reply = await getTurnChanges('busy', { checkpointId: 'cp-1' });
  await beginTurnSnapshot(repo, 'busy', { checkpointId: 'cp-2' });
  await assert.rejects(revertTurnChanges('busy', 'cp-1', null, reply.revision), /running a turn/);
  assert.equal(readTree(repo, ['a.txt'])['a.txt'], 'A\n');
  await completeTurnSnapshot('busy');
  await revertTurnChanges('busy', 'cp-1', null, reply.revision);
  assert.equal(readTree(repo, ['a.txt'])['a.txt'], 'a\n');
});

test('turn startup and Undo/Reapply share one per-session lock', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const repo = seedRepo({ 'a.txt': 'a\n' });
  await beginTurnSnapshot(repo, 'race', { checkpointId: 'cp-1' });
  writeTree(repo, { 'a.txt': 'A\n' });
  await completeTurnSnapshot('race');
  let reply = await getTurnChanges('race', { checkpointId: 'cp-1' });

  // A turn started while an Undo is in flight waits for it: the Undo lands
  // and the new turn's baseline already contains it.
  const undo = revertTurnChanges('race', 'cp-1', null, reply.revision);
  const started = beginTurnSnapshot(repo, 'race', { checkpointId: 'cp-2' });
  reply = await undo;
  await started;
  assert.equal(readTree(repo, ['a.txt'])['a.txt'], 'a\n');
  assert.equal((await getTurnChanges('race', { checkpointId: 'cp-2' })).status, 'pending');
  await completeTurnSnapshot('race');
  assert.equal((await getTurnChanges('race', { checkpointId: 'cp-2' })).status, 'none');

  // A Reapply requested after a turn start re-checks under the lock and
  // refuses without touching the disk.
  const next = beginTurnSnapshot(repo, 'race', { checkpointId: 'cp-3' });
  await assert.rejects(reapplyTurnChanges('race', 'cp-1', null, reply.revision), /running a turn/);
  await next;
  assert.equal(readTree(repo, ['a.txt'])['a.txt'], 'a\n');
  assert.equal((await getTurnChanges('race', { checkpointId: 'cp-1' })).revision, reply.revision);
  await completeTurnSnapshot('race');
});

test('Undo/Reapply refreshes the sealed Git turn review and the session diff', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const repo = seedRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  await beginTurnSnapshot(repo, 'review-git', { checkpointId: 'cp' });
  writeTree(repo, { 'a.txt': 'A\n', 'b.txt': 'B\n' });
  await completeTurnSnapshot('review-git');
  const reviewPaths = async () => (await getTurnReviewDiff(repo, 'review-git')).files.map((file) => file.path);
  const sessionPaths = async () => (await getSessionReviewDiff(repo, 'review-git')).files.map((file) => file.path);
  assert.deepEqual(await reviewPaths(), ['a.txt', 'b.txt']);

  let reply = await getTurnChanges('review-git', { checkpointId: 'cp' });
  reply = await revertTurnChanges('review-git', 'cp', 'a.txt', reply.revision);
  assert.deepEqual(await reviewPaths(), ['b.txt']);
  assert.deepEqual(await sessionPaths(), ['b.txt']);
  const review = await getTurnReviewDiff(repo, 'review-git');
  assert.doesNotMatch(review.patch, /a\.txt/);

  reply = await revertTurnChanges('review-git', 'cp', null, reply.revision);
  assert.deepEqual(await reviewPaths(), []);
  assert.deepEqual(await sessionPaths(), []);

  reply = await reapplyTurnChanges('review-git', 'cp', null, reply.revision);
  assert.deepEqual(await reviewPaths(), ['a.txt', 'b.txt']);
  assert.deepEqual(await sessionPaths(), ['a.txt', 'b.txt']);
  // The composer's latest-turn Undo still works on the refreshed review, and
  // the turn's history records it: reverted, Reapply offered.
  await revertTurnReview(repo, 'review-git', 'cp');
  assert.deepEqual(readTree(repo, ['a.txt', 'b.txt']), { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  reply = await getTurnChanges('review-git', { checkpointId: 'cp' });
  assert.deepEqual(
    reply.files.map((file) => [file.path, file.state]),
    [
      ['a.txt', 'reverted'],
      ['b.txt', 'reverted'],
    ]
  );
  assert.equal(reply.canUndo, false);
  assert.equal(reply.canReapply, true);
  await reapplyTurnChanges('review-git', 'cp', null, reply.revision);
  assert.deepEqual(readTree(repo, ['a.txt', 'b.txt']), { 'a.txt': 'A\n', 'b.txt': 'B\n' });
});

test('the session diff lists a worker’s edits made in its own session turn', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const repo = seedRepo({ 'lead.txt': 'a\n', 'worker.txt': 'a\n' });
  const token = await beginTurnSnapshot(repo, 'own-turn-lead', { checkpointId: 'cp' });
  const worker = beginAgentTurnReview('own-turn-lead', 'own-turn-worker', { agent: 'worker' });
  // The worker's session turn opens its own tracker in the same worktree.
  await beginTurnSnapshot(repo, 'own-turn-worker', { checkpointId: 'worker-cp' });
  const edit = (sessionId, name) => {
    writeTree(repo, { [name]: 'b\n' });
    recordTurnDiffChanges(sessionId, [{ path: join(repo, name), displayPath: name, before: 'a\n', after: 'b\n' }]);
  };
  edit('own-turn-lead', 'lead.txt');
  edit('own-turn-worker', 'worker.txt');
  await completeAgentTurnReview(worker);
  await completeTurnSnapshot('own-turn-lead', token);
  const files = (await getSessionReviewDiff(repo, 'own-turn-lead')).files.map((file) => file.path);
  assert.deepEqual(files, ['lead.txt', 'worker.txt']);
});

/** Fails instead of hanging when a lock deadlocks. */
function withinDeadline(promise, label, ms = 20_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`deadlock: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The record once no seal of it is in flight. */
async function settledChanges(sessionId, checkpointId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const reply = await getTurnChanges(sessionId, { checkpointId });
    if (reply.status !== 'pending') return reply;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`deadlock: ${checkpointId} stayed pending`);
}

const workerPatch = 'diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-b\n+B\n';
const statesOf = (reply) => reply.files.map((file) => [file.path, file.status, file.state]);

test('composer whole-turn Undo on a contended worktree records only the Lead files it restored', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'contended-undo';
  const repo = seedRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
  // A second live turn on the same worktree makes it contended.
  await beginTurnSnapshot(repo, 'contended-other', { checkpointId: 'cp-other' });
  const worker = beginAgentTurnReview(sessionId, 'contended-undo-worker', { agent: 'worker' });
  writeTree(repo, { 'a.txt': 'A\n', 'b.txt': 'B\n' });
  recordTurnDiffChanges(sessionId, [{ path: join(repo, 'a.txt'), displayPath: 'a.txt', before: 'a\n', after: 'A\n' }]);
  recordTurnDiffChanges('contended-undo-worker', [
    { path: join(repo, 'b.txt'), displayPath: 'b.txt', before: 'b\n', after: 'B\n' },
  ]);
  assert.equal(await completeAgentTurnReview(worker), true);
  await completeTurnSnapshot(sessionId);
  let reply = await settledChanges(sessionId, 'cp');
  assert.deepEqual(statesOf(reply), [
    ['a.txt', 'M', 'applied'],
    ['b.txt', 'M', 'applied'],
  ]);

  // The Lead's exact tracker owns a.txt only: the worker's b.txt stays.
  await revertTurnReview(repo, sessionId, 'cp');
  assert.deepEqual(readTree(repo, ['a.txt', 'b.txt']), { 'a.txt': 'a\n', 'b.txt': 'B\n' });
  reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.deepEqual(statesOf(reply), [
    ['a.txt', 'M', 'reverted'],
    ['b.txt', 'M', 'applied'],
  ]);
  assert.equal(reply.canUndo, true);
  assert.equal(reply.canReapply, true);

  reply = await reapplyTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.deepEqual(readTree(repo, ['a.txt', 'b.txt']), { 'a.txt': 'A\n', 'b.txt': 'B\n' });
  assert.deepEqual(statesOf(reply), [
    ['a.txt', 'M', 'applied'],
    ['b.txt', 'M', 'applied'],
  ]);
  await completeTurnSnapshot('contended-other');
});

test('a worker completed just before or during the Lead seal reaches the persisted record', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'complete-then-seal';
  const repo = seedRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
  // A second live turn on the same worktree makes it contended: the record
  // is scoped to the paths attributed to this session and its workers.
  await beginTurnSnapshot(repo, 'complete-then-seal-other', { checkpointId: 'cp-other' });
  const before = beginAgentTurnReview(sessionId, 'complete-then-seal-worker-1', { agent: 'worker' });
  const during = beginAgentTurnReview(sessionId, 'complete-then-seal-worker-2', { agent: 'worker' });
  writeTree(repo, { 'a.txt': 'A\n', 'b.txt': 'B\n', 'c.txt': 'C\n' });
  const edit = (id, name) => {
    const letter = name[0];
    recordTurnDiffChanges(id, [
      { path: join(repo, name), displayPath: name, before: `${letter}\n`, after: `${letter.toUpperCase()}\n` },
    ]);
  };
  edit(sessionId, 'a.txt');
  // Neither worker's tracked diff has rendered yet when it completes.
  edit('complete-then-seal-worker-1', 'b.txt');
  edit('complete-then-seal-worker-2', 'c.txt');
  // Completed, then sealed at once; the second completes while that seal freezes.
  const completedBefore = completeAgentTurnReview(before);
  const sealed = completeTurnSnapshot(sessionId);
  const completedDuring = completeAgentTurnReview(during);
  assert.equal(await completedBefore, true);
  assert.equal(await withinDeadline(sealed, 'seal'), true);
  assert.equal(await completedDuring, true);
  const live = await getTurnReviewDiff(repo, sessionId);
  assert.deepEqual(
    live.agents.map((agent) => [agent.sessionId, agent.patch.split('\n').filter((line) => /^[-+]\w/.test(line))]),
    [
      ['complete-then-seal-worker-1', ['-b', '+B']],
      ['complete-then-seal-worker-2', ['-c', '+C']],
    ]
  );
  // The next turn opens only after the queued re-seal landed.
  await withinDeadline(beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-2' }), 'next turn start');

  const record = await loadTurnChangeRecord(sessionId, 'cp');
  assert.deepEqual(
    record.agents.map((agent) => agent.sessionId),
    ['complete-then-seal-worker-1', 'complete-then-seal-worker-2']
  );
  assert.deepEqual(statesOf(await settledChanges(sessionId, 'cp')), [
    ['a.txt', 'M', 'applied'],
    ['b.txt', 'M', 'applied'],
    ['c.txt', 'M', 'applied'],
  ]);
  await completeTurnSnapshot(sessionId);
  await completeTurnSnapshot('complete-then-seal-other');
});

test('a worker re-seal queued while the turn start drains another lands before the next turn opens', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'drain-reseals';
  const repo = seedRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-1' });
  const first = beginAgentTurnReview(sessionId, 'drain-reseals-worker-1', { agent: 'worker' });
  const second = beginAgentTurnReview(sessionId, 'drain-reseals-worker-2', { agent: 'worker' });
  writeTree(repo, { 'a.txt': 'A\n' });
  await completeTurnSnapshot(sessionId);
  // Both workers' edits land after the Lead turn sealed.
  writeTree(repo, { 'b.txt': 'B\n', 'c.txt': 'C\n' });
  const secondPatch = 'diff --git a/c.txt b/c.txt\n--- a/c.txt\n+++ b/c.txt\n@@ -1 +1 @@\n-c\n+C\n';

  // An Undo holds the lock, the next turn start queues behind it, and only
  // then does the first worker report: the start step runs its re-seal.
  const reply = await getTurnChanges(sessionId, { checkpointId: 'cp-1' });
  const undo = revertTurnChanges(sessionId, 'cp-1', 'a.txt', reply.revision);
  const started = beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-2' });
  assert.equal(await completeAgentTurnReview(first, [workerPatch]), true);
  await withinDeadline(undo, 'undo');
  // Every microtask has run: the start step's re-seal is now awaiting Git.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await completeAgentTurnReview(second, [secondPatch]), true);
  await withinDeadline(started, 'turn start');

  const workers = ['drain-reseals-worker-1', 'drain-reseals-worker-2'];
  const opened = await loadTurnChangeRecord(sessionId, 'cp-1');
  assert.deepEqual(
    opened.agents.map((agent) => agent.sessionId),
    workers
  );
  // Flush every lock step queued meanwhile; none may rewrite cp-1.
  await withinDeadline(completeTurnSnapshot(sessionId), 'next turn seal');
  await withinDeadline(beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-3' }), 'flush');
  const later = await loadTurnChangeRecord(sessionId, 'cp-1');
  assert.deepEqual(
    later.agents.map((agent) => agent.sessionId),
    workers
  );
  assert.equal(later.revision, opened.revision);
  await completeTurnSnapshot(sessionId);
});

test('a late worker re-seal racing a new turn start never absorbs the next turn’s edits', { skip }, async () => {
  for (const order of ['reseal-then-start', 'start-queued-then-reseal']) {
    _resetTurnSnapshotForTest();
    const sessionId = `late-start-${order}`;
    const repo = seedRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-1' });
    const worker = beginAgentTurnReview(sessionId, `${sessionId}-worker`, { agent: 'worker' });
    writeTree(repo, { 'a.txt': 'A\n' });
    await completeTurnSnapshot(sessionId);
    // The worker's edit lands after the Lead turn sealed.
    writeTree(repo, { 'b.txt': 'B\n' });

    let started;
    let undo = null;
    if (order === 'reseal-then-start') {
      assert.equal(await completeAgentTurnReview(worker, [workerPatch]), true);
      started = beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-2' });
    } else {
      // An Undo holds the lock, the next turn start queues behind it, and
      // only then does the worker report (still bound to turn cp-1).
      const reply = await getTurnChanges(sessionId, { checkpointId: 'cp-1' });
      undo = revertTurnChanges(sessionId, 'cp-1', 'a.txt', reply.revision);
      started = beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-2' });
      assert.equal(await completeAgentTurnReview(worker, [workerPatch]), true);
    }
    await withinDeadline(started, `${order}: turn start`);
    if (undo) await withinDeadline(undo, `${order}: undo`);
    // The next turn edits as soon as it has started.
    writeTree(repo, { 'c.txt': 'C\n' });
    const previous = await settledChanges(sessionId, 'cp-1');
    await withinDeadline(completeTurnSnapshot(sessionId), `${order}: next turn seal`);

    assert.deepEqual(
      statesOf(previous),
      [
        ['a.txt', 'M', order === 'reseal-then-start' ? 'applied' : 'reverted'],
        ['b.txt', 'M', 'applied'],
      ],
      order
    );
    assert.deepEqual(statesOf(await settledChanges(sessionId, 'cp-1')), statesOf(previous), order);
    assert.deepEqual(statesOf(await settledChanges(sessionId, 'cp-2')), [['c.txt', 'M', 'applied']], order);
  }
});

test('a pending late-worker re-seal runs before the next turn opens', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'late-open';
  const repo = seedRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'd.txt': 'd\n' });
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-1' });
  const worker = beginAgentTurnReview(sessionId, 'late-open-worker', { agent: 'worker' });
  writeTree(repo, { 'a.txt': 'A\n' });
  await completeTurnSnapshot(sessionId);
  writeTree(repo, { 'b.txt': 'B\n' });

  // The seam edits the worktree the instant cp-2 opens — the earliest a next
  // turn could write. If cp-1's queued re-seal ran after that point, c.txt
  // would land in cp-1.
  const opened = [];
  _setTurnOpenedHookForTest((_id, checkpointId) => {
    opened.push(checkpointId);
    if (checkpointId === 'cp-2') writeTree(repo, { 'c.txt': 'C\n' });
  });
  const reply = await getTurnChanges(sessionId, { checkpointId: 'cp-1' });
  const undo = revertTurnChanges(sessionId, 'cp-1', 'a.txt', reply.revision);
  const started = beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-2' });
  // Reported after the start queued, while the worker is still bound to cp-1.
  assert.equal(await completeAgentTurnReview(worker, [workerPatch]), true);
  await withinDeadline(undo, 'undo');
  await withinDeadline(started, 'turn start');
  assert.deepEqual(opened, ['cp-2']);
  // The re-seal already landed inside the start step: nothing is pending.
  const previous = await getTurnChanges(sessionId, { checkpointId: 'cp-1' });
  assert.equal(previous.status, 'ready');
  assert.deepEqual(statesOf(previous), [
    ['a.txt', 'M', 'reverted'],
    ['b.txt', 'M', 'applied'],
  ]);
  writeTree(repo, { 'd.txt': 'D\n' });
  await withinDeadline(completeTurnSnapshot(sessionId), 'next turn seal');
  assert.deepEqual(statesOf(await settledChanges(sessionId, 'cp-1')), statesOf(previous));
  // c.txt predates cp-2's baseline, so neither record claims it.
  assert.deepEqual(statesOf(await settledChanges(sessionId, 'cp-2')), [['d.txt', 'M', 'applied']]);
});

test('a late worker re-seal racing an Undo stays consistent in either order', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const repo = seedRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const sessionId = 'late-undo';
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
  const first = beginAgentTurnReview(sessionId, 'late-undo-worker-1', { agent: 'worker' });
  const second = beginAgentTurnReview(sessionId, 'late-undo-worker-2', { agent: 'worker' });
  writeTree(repo, { 'a.txt': 'A\n' });
  await completeTurnSnapshot(sessionId);
  let reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.equal(reply.revision, 1);

  // Re-seal first: the Undo queued behind it sees the bumped revision.
  writeTree(repo, { 'b.txt': 'B\n' });
  assert.equal(await completeAgentTurnReview(first, [workerPatch]), true);
  await assert.rejects(
    withinDeadline(revertTurnChanges(sessionId, 'cp', 'a.txt', reply.revision), 'undo behind re-seal'),
    /turn changes changed; refresh/
  );
  reply = await settledChanges(sessionId, 'cp');
  assert.equal(reply.revision, 2);
  assert.deepEqual(statesOf(reply), [
    ['a.txt', 'M', 'applied'],
    ['b.txt', 'M', 'applied'],
  ]);

  // Undo first: the re-seal queued behind it reads the undone disk and keeps
  // the undone file reverted and reapplyable.
  const undo = revertTurnChanges(sessionId, 'cp', 'a.txt', reply.revision);
  assert.equal(await completeAgentTurnReview(second, [workerPatch.replaceAll('b.txt', 'b2.txt')]), true);
  reply = await withinDeadline(undo, 'undo ahead of re-seal');
  assert.equal(readTree(repo, ['a.txt'])['a.txt'], 'a\n');
  reply = await settledChanges(sessionId, 'cp');
  assert.deepEqual(statesOf(reply), [
    ['a.txt', 'M', 'reverted'],
    ['b.txt', 'M', 'applied'],
  ]);
  reply = await withinDeadline(reapplyTurnChanges(sessionId, 'cp', null, reply.revision), 'reapply');
  assert.deepEqual(readTree(repo, ['a.txt', 'b.txt']), { 'a.txt': 'A\n', 'b.txt': 'B\n' });
  assert.deepEqual(
    reply.files.map((file) => file.state),
    ['applied', 'applied']
  );
});

test('a completion wake re-seals the same checkpoint and keeps undone files reapplyable', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const repo = seedRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  await beginTurnSnapshot(repo, 'wake', { checkpointId: 'cp' });
  writeTree(repo, { 'a.txt': 'A\n' });
  await completeTurnSnapshot('wake');
  let reply = await getTurnChanges('wake', { checkpointId: 'cp' });
  assert.equal(reply.revision, 1);
  reply = await revertTurnChanges('wake', 'cp', 'a.txt', reply.revision);
  assert.equal(reply.revision, 2);

  // The wake carries no prompt id; it reopens the original turn.
  const token = await beginTurnSnapshot(repo, 'wake', { continueTurn: true });
  assert.equal(token.checkpointId, 'cp');
  writeTree(repo, { 'b.txt': 'B from a worker\n' });
  await completeTurnSnapshot('wake', token);
  reply = await getTurnChanges('wake', { checkpointId: 'cp' });
  assert.equal(reply.revision, 3);
  assert.deepEqual(
    reply.files.map((file) => [file.path, file.state]),
    [
      ['a.txt', 'reverted'],
      ['b.txt', 'applied'],
    ]
  );
  // An unchanged re-seal keeps the revision.
  await completeTurnSnapshot('wake');
  assert.equal((await getTurnChanges('wake', { checkpointId: 'cp' })).revision, 3);
  reply = await reapplyTurnChanges('wake', 'cp', null, reply.revision);
  assert.deepEqual(readTree(repo, ['a.txt', 'b.txt']), { 'a.txt': 'A\n', 'b.txt': 'B from a worker\n' });
});

test('a cancelled turn keeps its edits as a record; delayed cleanup never seals a newer turn', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const repo = seedRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const createTracker = createSnapshotTrackerFactory({
    getCurrentCwd: () => repo,
    beginTurnSnapshotForTurn: beginTurnSnapshot,
    completeTurnSnapshotForTurn: completeTurnSnapshot,
    turnCleanupSettleMs: 5_000,
  });
  const aborted = AbortSignal.abort();
  const awaitTurn = (task) => task();

  const cancelled = createTracker({ id: 'cp-cancel' });
  cancelled.start('cancel');
  await cancelled.promise;
  writeTree(repo, { 'a.txt': 'A\n' });
  await cancelled.finish(aborted, awaitTurn);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await getTurnChanges('cancel', { checkpointId: 'cp-cancel' })).status === 'ready') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const reply = await getTurnChanges('cancel', { checkpointId: 'cp-cancel' });
  assert.equal(reply.status, 'ready');
  assert.deepEqual(shape(reply), [['a.txt', '', 'M', 'applied']]);

  // Turn B begins before turn A's aborted cleanup runs: B's begin seals A,
  // and A's delayed cleanup (generation-bound) leaves B running.
  const turnA = createTracker({ id: 'cp-a' });
  turnA.start('cancel');
  await turnA.promise;
  writeTree(repo, { 'b.txt': 'B\n' });
  await beginTurnSnapshot(repo, 'cancel', { checkpointId: 'cp-b' });
  await turnA.finish(aborted, awaitTurn);
  await new Promise((resolve) => setTimeout(resolve, 200));
  let recordA = await getTurnChanges('cancel', { checkpointId: 'cp-a' });
  for (let attempt = 0; attempt < 200 && recordA.status !== 'ready'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    recordA = await getTurnChanges('cancel', { checkpointId: 'cp-a' });
  }
  assert.deepEqual(shape(recordA), [['b.txt', '', 'M', 'applied']]);
  assert.equal((await getTurnChanges('cancel', { checkpointId: 'cp-b' })).status, 'pending');
});

/** One turn's edits must undo to the exact original bytes and reapply to the
 *  exact post-turn bytes. */
async function assertRoundTrip(repo, sessionId, edits, expectedStatuses) {
  const paths = Object.keys(edits).concat(
    Object.keys(expectedStatuses).flatMap((path) => expectedStatuses[path].oldPath || [])
  );
  const unique = [...new Set(paths)];
  const before = readTree(repo, unique);
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
  writeTree(repo, edits);
  await completeTurnSnapshot(sessionId);
  const after = readTree(repo, unique);
  let reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.equal(reply.status, 'ready');
  assert.deepEqual(
    Object.fromEntries(reply.files.map((file) => [file.path, { status: file.status, oldPath: file.oldPath }])),
    Object.fromEntries(
      Object.entries(expectedStatuses).map(([path, value]) => [path, { status: value.status, oldPath: value.oldPath }])
    )
  );
  assert.equal(reply.canUndo, true, reply.reason);
  reply = await revertTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.deepEqual(readTree(repo, unique), before, 'undo restores the exact original bytes');
  reply = await reapplyTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.deepEqual(readTree(repo, unique), after, 'reapply restores the exact post-turn bytes');
  // Per file as well.
  const first = reply.files[0].path;
  reply = await revertTurnChanges(sessionId, 'cp', first, reply.revision);
  reply = await reapplyTurnChanges(sessionId, 'cp', first, reply.revision);
  assert.deepEqual(readTree(repo, unique), after);
}

const lineEndingEdits = {
  'crlf.txt': 'one\r\nTWO\r\nthree\r\n',
  'no-newline.txt': 'alpha\r\nbeta changed',
  '폴더 a/파일 b.txt': 'unicode\r\nspace path\r\nedited\r\n',
  'added file.txt': 'brand\r\nnew\r\n',
  'removed.txt': null,
  'renamed.txt': null,
  'renamed to.txt': 'rename body line 1\r\nrename body line 2\r\nrename body line 3\r\nrename body line 4\r\n',
};
const lineEndingSeed = {
  'crlf.txt': 'one\r\ntwo\r\nthree\r\n',
  'no-newline.txt': 'alpha\r\nbeta',
  '폴더 a/파일 b.txt': 'unicode\r\nspace path\r\n',
  'removed.txt': 'remove\r\nme\r\n',
  'renamed.txt': 'rename body line 1\r\nrename body line 2\r\nrename body line 3\r\nrename body line 4\r\n',
};
const lineEndingStatuses = {
  'added file.txt': { status: 'A' },
  'crlf.txt': { status: 'M' },
  'no-newline.txt': { status: 'M' },
  'removed.txt': { status: 'D' },
  'renamed to.txt': { status: 'R', oldPath: 'renamed.txt' },
  '폴더 a/파일 b.txt': { status: 'M' },
};

test('CRLF files committed raw (autocrlf=false) round-trip exactly', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const repo = seedRepo(lineEndingSeed);
  await assertRoundTrip(repo, 'eol-raw', lineEndingEdits, lineEndingStatuses);
});

test('core.autocrlf=true CRLF checkouts round-trip exactly', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const repo = seedRepo(lineEndingSeed, { config: { 'core.autocrlf': 'true' } });
  await assertRoundTrip(repo, 'eol-autocrlf', lineEndingEdits, lineEndingStatuses);
});

test('.gitattributes eol=crlf files round-trip exactly', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const repo = seedRepo(lineEndingSeed, { attributes: '* text eol=crlf\n' });
  await assertRoundTrip(repo, 'eol-attributes', lineEndingEdits, lineEndingStatuses);
});

test('a Git session records an edit outside its root and keeps it across a restart', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'git-outside';
  const repo = seedRepo({ 'a.txt': 'one\n' });
  const outside = join(base, `git-outside-${++seq}`, 'outside-note.txt');
  mkdirSync(dirname(outside), { recursive: true });
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
  writeTree(repo, { 'a.txt': 'one\ntwo\n' });
  writeFileSync(outside, 'out\n');
  recordTurnDiffChanges(sessionId, [
    { path: join(repo, 'a.txt'), displayPath: 'a.txt', before: 'one\n', after: 'one\ntwo\n' },
    { path: outside, displayPath: outside, before: null, after: 'out\n' },
  ]);
  await completeTurnSnapshot(sessionId);
  const { getSessionReviewDiff } = snapshotModule;
  const shape = (review) =>
    review.files.map((file) => [file.path.replaceAll('\\', '/'), file.status, file.additions]).sort();
  const expected = [
    ['a.txt', 'M', 1],
    [outside.replaceAll('\\', '/'), 'A', 1],
  ].sort();
  const live = await getSessionReviewDiff(repo, sessionId);
  assert.deepEqual(shape(live), expected);
  assert.equal(live.complete, true);
  _resetTurnSnapshotForTest();
  const restarted = await getSessionReviewDiff(repo, sessionId);
  assert.deepEqual(shape(restarted), expected);
  assert.ok(restarted.patch.includes('+out\n'));
  // The Git turn's whole-turn Undo is not blocked by the view-only outside edit.
  // The card lists it too (session and card agree), as a view-only entry.
  const reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.deepEqual(
    reply.files.map((file) => [file.path.replaceAll('\\', '/'), file.revertable]).sort(),
    [
      ['a.txt', true],
      [outside.replaceAll('\\', '/'), false],
    ].sort()
  );
  assert.equal(reply.canUndo, true);
  assert.equal(reply.files.find((file) => file.path !== 'a.txt').state, 'applied');
  const outsideReply = await getTurnChanges(sessionId, { checkpointId: 'cp', file: outside, patch: true });
  assert.ok(outsideReply.patch.includes('+out\n'));
  // Whole-turn Undo restores a.txt and never touches the outside file.
  const undone = await revertTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(readFileSync(outside, 'utf8'), 'out\n');
  assert.equal(undone.canUndo, false);
  assert.equal(undone.files.length, 2);
  await assert.rejects(revertTurnChanges(sessionId, 'cp', outside, undone.revision));
});
