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
  revertTurnReviewFile,
} = snapshotModule;
const { createSnapshotTrackerFactory } = await import('../../session-runtime/turn/turn-run/snapshot-tracker.mjs');
const { loadTurnChangeRecord } = await import('./turn-snapshot-store.mjs');
const { registerEditToolUiDiff } = await import('../agent/orchestrator/tools/patch/ui-diff.mjs');
const { tryExecuteExternalToolAdapter } = await import(
  '../agent/orchestrator/tools/builtin/external-tool-adapters.mjs'
);

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

let callSeq = 0;
/** Edit `files` through `sessionId`'s own file tools: each write reaches the
 *  turn review with its before/after and its own line counts. */
function editTree(sessionId, root, files) {
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    const before = existsSync(fullPath) ? readFileSync(fullPath) : null;
    writeTree(root, { [path]: content });
    registerEditToolUiDiff({
      callId: `edit-${++callSeq}`,
      sessionId,
      basePath: root,
      fullPath,
      before,
      after: content === null ? null : Buffer.from(content),
    });
  }
}

/** An own-tool move of `from` to `to` with unchanged content. */
function moveTree(sessionId, root, from, to) {
  const content = readFileSync(join(root, from));
  writeTree(root, { [from]: null, [to]: content });
  recordTurnDiffChanges(sessionId, [
    {
      path: join(root, from),
      displayPath: from,
      newPath: join(root, to),
      newDisplayPath: to,
      before: content,
      after: content,
      additions: 0,
      deletions: 0,
    },
  ]);
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
  editTree('freeze', repo, { 'a.txt': 'one\nTWO\n', 'b.txt': null });
  moveTree('freeze', repo, 'c.txt', 'd.txt');
  editTree('freeze', repo, { 'bin.dat': Buffer.from([0, 1, 2, 255, 0, 10]) });
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
  editTree('undo', repo, { 'a.txt': 'A\n', 'b.txt': null, 'new.txt': 'new\n' });
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
  editTree('conflict', repo, { 'a.txt': 'A\n', 'b.txt': 'B\n' });
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
  editTree('busy', repo, { 'a.txt': 'A\n' });
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
  editTree('race', repo, { 'a.txt': 'A\n' });
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
  editTree('review-git', repo, { 'a.txt': 'A\n', 'b.txt': 'B\n' });
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
  completeAgentTurnReview(worker);
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

/** A non-pending record at the expected revision, when a queued re-seal must land. */
async function settledChanges(sessionId, checkpointId, expectedRevision) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const reply = await getTurnChanges(sessionId, { checkpointId });
    if (reply.status !== 'pending' && (expectedRevision === undefined || reply.revision === expectedRevision)) {
      return reply;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`deadlock: ${checkpointId} did not settle`);
}

const workerPatch = 'diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-b\n+B\n';
const statesOf = (reply) => reply.files.map((file) => [file.path, file.status, file.state]);

test('composer whole-turn Undo on a contended worktree undoes the Lead’s and its completed worker’s own files', { skip }, async () => {
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
  assert.equal(completeAgentTurnReview(worker), true);
  await completeTurnSnapshot(sessionId);
  let reply = await settledChanges(sessionId, 'cp');
  assert.deepEqual(statesOf(reply), [
    ['a.txt', 'M', 'applied'],
    ['b.txt', 'M', 'applied'],
  ]);

  // The completed worker's b.txt joined the Lead's own changes.
  await revertTurnReview(repo, sessionId, 'cp');
  assert.deepEqual(readTree(repo, ['a.txt', 'b.txt']), { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.deepEqual(statesOf(reply), [
    ['a.txt', 'M', 'reverted'],
    ['b.txt', 'M', 'reverted'],
  ]);
  assert.equal(reply.canUndo, false);
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
  edit('complete-then-seal-worker-1', 'b.txt');
  edit('complete-then-seal-worker-2', 'c.txt');
  // Completed, then sealed at once; the second completes while that seal freezes.
  assert.equal(completeAgentTurnReview(before), true);
  const sealed = completeTurnSnapshot(sessionId);
  assert.equal(completeAgentTurnReview(during), true);
  assert.equal(await withinDeadline(sealed, 'seal'), true);
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
  editTree(sessionId, repo, { 'a.txt': 'A\n' });
  await completeTurnSnapshot(sessionId);
  // Both workers' edits land after the Lead turn sealed.
  editTree('drain-reseals-worker-1', repo, { 'b.txt': 'B\n' });
  editTree('drain-reseals-worker-2', repo, { 'c.txt': 'C\n' });
  const secondPatch = 'diff --git a/c.txt b/c.txt\n--- a/c.txt\n+++ b/c.txt\n@@ -1 +1 @@\n-c\n+C\n';

  // An Undo holds the lock, the next turn start queues behind it, and only
  // then does the first worker report: the start step runs its re-seal.
  const reply = await getTurnChanges(sessionId, { checkpointId: 'cp-1' });
  const undo = revertTurnChanges(sessionId, 'cp-1', 'a.txt', reply.revision);
  const started = beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-2' });
  assert.equal(completeAgentTurnReview(first, [workerPatch]), true);
  await withinDeadline(undo, 'undo');
  // Every microtask has run: the start step's re-seal is now awaiting Git.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completeAgentTurnReview(second, [secondPatch]), true);
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
    editTree(sessionId, repo, { 'a.txt': 'A\n' });
    await completeTurnSnapshot(sessionId);
    // The worker's edit lands after the Lead turn sealed.
    editTree(`${sessionId}-worker`, repo, { 'b.txt': 'B\n' });

    let started;
    let undo = null;
    if (order === 'reseal-then-start') {
      assert.equal(completeAgentTurnReview(worker, [workerPatch]), true);
      started = beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-2' });
    } else {
      // An Undo holds the lock, the next turn start queues behind it, and
      // only then does the worker report (still bound to turn cp-1).
      const reply = await getTurnChanges(sessionId, { checkpointId: 'cp-1' });
      undo = revertTurnChanges(sessionId, 'cp-1', 'a.txt', reply.revision);
      started = beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-2' });
      assert.equal(completeAgentTurnReview(worker, [workerPatch]), true);
    }
    await withinDeadline(started, `${order}: turn start`);
    if (undo) await withinDeadline(undo, `${order}: undo`);
    // The next turn edits as soon as it has started.
    editTree(sessionId, repo, { 'c.txt': 'C\n' });
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
  editTree(sessionId, repo, { 'a.txt': 'A\n' });
  await completeTurnSnapshot(sessionId);
  editTree('late-open-worker', repo, { 'b.txt': 'B\n' });

  // The seam edits the worktree the instant cp-2 opens — the earliest a next
  // turn could write. If cp-1's queued re-seal ran after that point, cp-1
  // would record cp-2's edit of b.txt.
  const opened = [];
  _setTurnOpenedHookForTest((_id, checkpointId) => {
    opened.push(checkpointId);
    if (checkpointId === 'cp-2') editTree(sessionId, repo, { 'b.txt': 'B2\n' });
  });
  const reply = await getTurnChanges(sessionId, { checkpointId: 'cp-1' });
  const undo = revertTurnChanges(sessionId, 'cp-1', 'a.txt', reply.revision);
  const started = beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp-2' });
  // Reported after the start queued, while the worker is still bound to cp-1.
  assert.equal(completeAgentTurnReview(worker, [workerPatch]), true);
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
  const workerPatchOf = async () =>
    (await getTurnChanges(sessionId, { checkpointId: 'cp-1', patch: true, file: 'b.txt' })).patch;
  assert.match(await workerPatchOf(), /-b\n\+B\n/);
  editTree(sessionId, repo, { 'd.txt': 'D\n' });
  await withinDeadline(completeTurnSnapshot(sessionId), 'next turn seal');
  assert.deepEqual(statesOf(await settledChanges(sessionId, 'cp-1')), statesOf(previous));
  assert.match(await workerPatchOf(), /-b\n\+B\n/);
  // cp-2's own b.txt edit (made the instant it opened) is cp-2's, never cp-1's.
  assert.deepEqual(statesOf(await settledChanges(sessionId, 'cp-2')), [
    ['b.txt', 'M', 'applied'],
    ['d.txt', 'M', 'applied'],
  ]);
});

test('a late worker re-seal racing an Undo stays consistent in either order', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const repo = seedRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const sessionId = 'late-undo';
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
  const first = beginAgentTurnReview(sessionId, 'late-undo-worker-1', { agent: 'worker' });
  const second = beginAgentTurnReview(sessionId, 'late-undo-worker-2', { agent: 'worker' });
  editTree(sessionId, repo, { 'a.txt': 'A\n' });
  await completeTurnSnapshot(sessionId);
  let reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.equal(reply.revision, 1);

  // Re-seal first: the Undo queued behind it sees the bumped revision.
  editTree('late-undo-worker-1', repo, { 'b.txt': 'B\n' });
  assert.equal(completeAgentTurnReview(first, [workerPatch]), true);
  await assert.rejects(
    withinDeadline(revertTurnChanges(sessionId, 'cp', 'a.txt', reply.revision), 'undo behind re-seal'),
    /turn changes changed; refresh/
  );
  reply = await settledChanges(sessionId, 'cp', 2);
  assert.equal(reply.revision, 2);
  assert.deepEqual(statesOf(reply), [
    ['a.txt', 'M', 'applied'],
    ['b.txt', 'M', 'applied'],
  ]);

  // Undo first: the re-seal queued behind it reads the undone disk and keeps
  // the undone file reverted and reapplyable.
  const undo = revertTurnChanges(sessionId, 'cp', 'a.txt', reply.revision);
  assert.equal(completeAgentTurnReview(second, [workerPatch.replaceAll('b.txt', 'b2.txt')]), true);
  reply = await withinDeadline(undo, 'undo ahead of re-seal');
  assert.equal(reply.revision, 3);
  assert.equal(readTree(repo, ['a.txt'])['a.txt'], 'a\n');
  // A read begun during re-seal can answer ready with the Undo's old revision.
  // The second worker's attribution must reach revision 4 before Reapply.
  reply = await settledChanges(sessionId, 'cp', 4);
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
  editTree('wake', repo, { 'a.txt': 'A\n' });
  await completeTurnSnapshot('wake');
  let reply = await getTurnChanges('wake', { checkpointId: 'cp' });
  assert.equal(reply.revision, 1);
  reply = await revertTurnChanges('wake', 'cp', 'a.txt', reply.revision);
  assert.equal(reply.revision, 2);

  // The wake carries no prompt id; it reopens the original turn.
  const token = await beginTurnSnapshot(repo, 'wake', { continueTurn: true });
  assert.equal(token.checkpointId, 'cp');
  editTree('wake', repo, { 'b.txt': 'B from a worker\n' });
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
  editTree('cancel', repo, { 'a.txt': 'A\n' });
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
  editTree('cancel', repo, { 'b.txt': 'B\n' });
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
  editTree(sessionId, repo, edits);
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
// The record keeps the tools' own writes: a delete and an add of the same
// body stay a delete and an add (a tool move records R; see the freeze case).
const lineEndingStatuses = {
  'added file.txt': { status: 'A' },
  'crlf.txt': { status: 'M' },
  'no-newline.txt': { status: 'M' },
  'removed.txt': { status: 'D' },
  'renamed to.txt': { status: 'A' },
  'renamed.txt': { status: 'D' },
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

// ── Own-write scope and counts ──────────────────────────────────────────────

const counts = (files) => files.map((file) => [file.path, file.status, file.additions, file.deletions]);

test('a turn reviews and records only its own writes; a foreign write in the same turn is left out', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'own-only';
  const repo = seedRepo({ 'a.txt': 'a\n', 'shell.txt': 's\n' });
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
  editTree(sessionId, repo, { 'a.txt': 'a\nA2\n' });
  // A shell command, the user or another session: no own file tool wrote these.
  writeTree(repo, { 'shell.txt': 'shell edit\n', 'foreign.txt': 'foreign\n' });
  const live = await getTurnReviewDiff(repo, sessionId);
  assert.deepEqual(counts(live.files), [['a.txt', 'M', 1, 0]]);
  assert.match(live.patch, /\+A2\n/);
  assert.doesNotMatch(live.patch, /shell|foreign/);
  await completeTurnSnapshot(sessionId);
  assert.deepEqual(counts((await getTurnChanges(sessionId, { checkpointId: 'cp' })).files), [['a.txt', 'M', 1, 0]]);
  assert.deepEqual(
    (await getSessionReviewDiff(repo, sessionId)).files.map((file) => file.path),
    ['a.txt']
  );
  // The recorded review keeps the same scope after a restart.
  _resetTurnSnapshotForTest();
  const recorded = await getTurnReviewDiff(repo, sessionId);
  assert.equal(recorded.reason, 'recorded');
  assert.deepEqual(counts(recorded.files), [['a.txt', 'M', 1, 0]]);
});

test('two own edits of one file count their summed deltas; the patch stays the net diff', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'own-sum';
  const repo = seedRepo({ 'a.txt': 'one\n' });
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
  editTree(sessionId, repo, { 'a.txt': 'one\ntwo\n' });
  editTree(sessionId, repo, { 'a.txt': 'one\nthree\n' });
  const live = await getTurnReviewDiff(repo, sessionId);
  assert.deepEqual(counts(live.files), [['a.txt', 'M', 2, 1]]);
  assert.match(live.patch, /^ one\n\+three\n/m);
  assert.doesNotMatch(live.patch, /two/);
  await completeTurnSnapshot(sessionId);
  let reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.deepEqual(counts(reply.files), [['a.txt', 'M', 2, 1]]);
  _resetTurnSnapshotForTest();
  assert.deepEqual(counts((await getTurnReviewDiff(repo, sessionId)).files), [['a.txt', 'M', 2, 1]]);
  // Undo and Reapply replay the net patch.
  reply = await revertTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.equal(readTree(repo, ['a.txt'])['a.txt'], 'one\n');
  await reapplyTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.equal(readTree(repo, ['a.txt'])['a.txt'], 'one\nthree\n');
});

test('Undo restores only the files the session’s own tools wrote', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'own-undo';
  const repo = seedRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const paths = ['a.txt', 'new.txt', 'b.txt', 'foreign.txt'];
  const foreign = { 'b.txt': 'foreign\n', 'foreign.txt': 'foreign\n' };
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
  editTree(sessionId, repo, { 'a.txt': 'A\n', 'new.txt': 'new\n' });
  writeTree(repo, foreign);
  await completeTurnSnapshot(sessionId);
  let reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.deepEqual(
    reply.files.map((file) => file.path),
    ['a.txt', 'new.txt']
  );

  await assert.rejects(revertTurnReviewFile(repo, sessionId, 'b.txt', 'cp'), /cannot attribute this file/);
  await revertTurnReview(repo, sessionId, 'cp');
  assert.deepEqual(readTree(repo, paths), { 'a.txt': 'a\n', 'new.txt': null, ...foreign });
  reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.deepEqual(
    reply.files.map((file) => [file.path, file.state]),
    [
      ['a.txt', 'reverted'],
      ['new.txt', 'reverted'],
    ]
  );

  reply = await reapplyTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.deepEqual(readTree(repo, paths), { 'a.txt': 'A\n', 'new.txt': 'new\n', ...foreign });
  await revertTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.deepEqual(readTree(repo, paths), { 'a.txt': 'a\n', 'new.txt': null, ...foreign });
});

test('a worker’s own edits count for its Lead turn', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'own-worker-lead';
  const workerId = `${lead}-worker`;
  const repo = seedRepo({ 'lead.txt': 'l\n', 'w.txt': 'w\n' });
  await beginTurnSnapshot(repo, lead, { checkpointId: 'cp' });
  const worker = beginAgentTurnReview(lead, workerId, { agent: 'worker' });
  editTree(lead, repo, { 'lead.txt': 'l\nL2\n' });
  editTree(workerId, repo, { 'w.txt': 'w\nW2\n' });
  editTree(workerId, repo, { 'w.txt': 'w\nW3\n' });
  assert.equal(completeAgentTurnReview(worker), true);
  const expected = [
    ['lead.txt', 'M', 1, 0],
    ['w.txt', 'M', 2, 1],
  ];
  assert.deepEqual(counts((await getTurnReviewDiff(repo, lead)).files), expected);
  await completeTurnSnapshot(lead);
  assert.deepEqual(counts((await getTurnChanges(lead, { checkpointId: 'cp' })).files), expected);
});

test('write tool edits are counted and undoable like edit tools', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'own-write';
  const repo = seedRepo({ 'a.txt': 'a\n' });
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
  for (const [file_path, contents, toolCallId] of [
    ['a.txt', 'a\nb\n', 'write-1'],
    ['new.txt', 'x\ny\n', 'write-2'],
  ]) {
    const result = await tryExecuteExternalToolAdapter('write', { file_path, contents }, repo, {
      sessionId,
      toolCallId,
    });
    assert.doesNotMatch(String(result), /^Error/);
  }
  const expected = [
    ['a.txt', 'M', 1, 0],
    ['new.txt', 'A', 2, 0],
  ];
  assert.deepEqual(counts((await getTurnReviewDiff(repo, sessionId)).files), expected);
  await completeTurnSnapshot(sessionId);
  const reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.deepEqual(counts(reply.files), expected);
  assert.equal(reply.canUndo, true, reply.reason);
  await revertTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.deepEqual(readTree(repo, ['a.txt', 'new.txt']), { 'a.txt': 'a\n', 'new.txt': null });
});

// ── Undo reverse-applies the turn's own diff ────────────────────────────────

const tenLines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}\n`).join('');
const ownLineTwo = tenLines.replace('line 2\n', 'LINE 2\n');

/** Undo the turn's a.txt: `record` (historical Undo), `composer` (latest
 *  sealed turn) or `live` (the running turn, before it seals). */
async function undoTurn(how, repo, sessionId) {
  if (how === 'record') {
    const reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
    return await revertTurnChanges(sessionId, 'cp', null, reply.revision);
  }
  return await revertTurnReview(repo, sessionId, 'cp');
}

test('a foreign append made during or after the turn survives Undo of the own edit in that file', { skip }, async () => {
  for (const [when, how] of [
    ['during', 'record'],
    ['after', 'record'],
    ['during', 'composer'],
    ['after', 'composer'],
    ['during', 'live'],
  ]) {
    _resetTurnSnapshotForTest();
    const sessionId = `foreign-append-${when}-${how}`;
    const repo = seedRepo({ 'a.txt': tenLines });
    await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
    editTree(sessionId, repo, { 'a.txt': ownLineTwo });
    const append = () => writeTree(repo, { 'a.txt': `${readTree(repo, ['a.txt'])['a.txt']}foreign tail\n` });
    if (when === 'during') append();
    if (how !== 'live') {
      await completeTurnSnapshot(sessionId);
      if (when === 'after') append();
      // The record holds the own edit only, never the foreign append.
      const recorded = (await getTurnChanges(sessionId, { checkpointId: 'cp', patch: true })).patch;
      assert.match(recorded, /-line 2\n\+LINE 2\n/, `${when}/${how}`);
      assert.doesNotMatch(recorded, /foreign/, `${when}/${how}`);
    }
    await undoTurn(how, repo, sessionId);
    assert.equal(readTree(repo, ['a.txt'])['a.txt'], `${tenLines}foreign tail\n`, `${when}/${how}`);
    if (how === 'live') {
      // The undone own change leaves the running turn's review and record.
      assert.deepEqual((await getTurnReviewDiff(repo, sessionId)).files, [], how);
      await completeTurnSnapshot(sessionId);
      assert.equal((await getTurnChanges(sessionId, { checkpointId: 'cp' })).status, 'none', how);
      continue;
    }
    const reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
    assert.deepEqual(statesOf(reply), [['a.txt', 'M', 'reverted']], `${when}/${how}`);
    // Reapply puts the own edit back beside the foreign one.
    await reapplyTurnChanges(sessionId, 'cp', null, reply.revision);
    assert.equal(readTree(repo, ['a.txt'])['a.txt'], `${ownLineTwo}foreign tail\n`, `${when}/${how}`);
  }
});

test('an Undo whose hunk a foreign edit overlaps fails with a conflict and overwrites nothing', { skip }, async () => {
  for (const how of ['record', 'composer', 'live']) {
    _resetTurnSnapshotForTest();
    const sessionId = `foreign-overlap-${how}`;
    const repo = seedRepo({ 'a.txt': tenLines });
    await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
    editTree(sessionId, repo, { 'a.txt': ownLineTwo });
    if (how !== 'live') await completeTurnSnapshot(sessionId);
    const foreign = ownLineTwo.replace('LINE 2\n', 'foreign 2\n');
    writeTree(repo, { 'a.txt': foreign });
    await assert.rejects(undoTurn(how, repo, sessionId), /undo failed; the worktree was not changed/, how);
    assert.equal(readTree(repo, ['a.txt'])['a.txt'], foreign, how);
    if (how === 'live') {
      assert.deepEqual(
        (await getTurnReviewDiff(repo, sessionId)).files.map((file) => file.path),
        ['a.txt'],
        how
      );
      await completeTurnSnapshot(sessionId);
    }
    assert.deepEqual(statesOf(await getTurnChanges(sessionId, { checkpointId: 'cp' })), [['a.txt', 'M', 'applied']], how);
  }
});

test('a non-Git worker’s edits join its Lead’s record and undo with it', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'plain-worker-lead';
  const workerId = `${lead}-worker`;
  const root = join(base, `plain-worker-${++seq}`);
  mkdirSync(root, { recursive: true });
  writeTree(root, { 'lead.txt': 'l\n', 'w.txt': 'w\n' });
  await beginTurnSnapshot(root, lead, { checkpointId: 'cp' });
  const worker = beginAgentTurnReview(lead, workerId, { agent: 'worker' });
  editTree(lead, root, { 'lead.txt': 'l\nL\n' });
  editTree(workerId, root, { 'w.txt': 'w\nW\n', 'w-new.txt': 'new\n' });
  assert.equal(completeAgentTurnReview(worker), true);
  const expected = [
    ['lead.txt', 'M', 1, 0],
    ['w-new.txt', 'A', 1, 0],
    ['w.txt', 'M', 1, 0],
  ];
  assert.deepEqual(counts((await getTurnReviewDiff(root, lead)).files), expected);
  await completeTurnSnapshot(lead);
  const reply = await getTurnChanges(lead, { checkpointId: 'cp' });
  assert.deepEqual(counts(reply.files), expected);
  assert.equal(reply.canUndo, true, reply.reason);
  await revertTurnChanges(lead, 'cp', null, reply.revision);
  assert.deepEqual(readTree(root, ['lead.txt', 'w.txt', 'w-new.txt']), {
    'lead.txt': 'l\n',
    'w.txt': 'w\n',
    'w-new.txt': null,
  });
});

// ── A foreign edit between two own writes of one file ───────────────────────

const thirtyLines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`).join('');
const swapLine = (text, line, to) => text.replace(`line ${line}\n`, `${to}\n`);

/** Own edit of line 2, a foreign edit of `foreignLine`, own edit of line 22. */
function editAroundForeign(sessionId, repo, foreignLine) {
  editTree(sessionId, repo, { 'a.txt': swapLine(thirtyLines, 2, 'OWN 2') });
  const foreign = swapLine(readTree(repo, ['a.txt'])['a.txt'], foreignLine, `FOREIGN ${foreignLine}`);
  writeTree(repo, { 'a.txt': foreign });
  editTree(sessionId, repo, { 'a.txt': swapLine(foreign, 22, 'OWN 22') });
}

test('a foreign edit between two own writes of a file stays out of its record and survives Undo', { skip }, async () => {
  const foreignOnly = swapLine(thirtyLines, 12, 'FOREIGN 12');
  const allEdits = swapLine(swapLine(foreignOnly, 2, 'OWN 2'), 22, 'OWN 22');
  for (const how of ['record', 'composer', 'live']) {
    _resetTurnSnapshotForTest();
    const sessionId = `foreign-between-${how}`;
    const repo = seedRepo({ 'a.txt': thirtyLines });
    await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
    editAroundForeign(sessionId, repo, 12);
    assert.equal(readTree(repo, ['a.txt'])['a.txt'], allEdits, how);
    if (how !== 'live') {
      await completeTurnSnapshot(sessionId);
      const reply = await getTurnChanges(sessionId, { checkpointId: 'cp', patch: true });
      assert.deepEqual(counts(reply.files), [['a.txt', 'M', 2, 2]], how);
      assert.match(reply.patch, /-line 2\n\+OWN 2\n/, how);
      assert.match(reply.patch, /-line 22\n\+OWN 22\n/, how);
      assert.doesNotMatch(reply.patch, /^[-+].*12$/m, how);
    }
    await undoTurn(how, repo, sessionId);
    assert.equal(readTree(repo, ['a.txt'])['a.txt'], foreignOnly, how);
    if (how !== 'record') continue;
    // Reapply replays both own segments, oldest first, around the foreign edit.
    const undone = await getTurnChanges(sessionId, { checkpointId: 'cp' });
    await reapplyTurnChanges(sessionId, 'cp', null, undone.revision);
    assert.equal(readTree(repo, ['a.txt'])['a.txt'], allEdits, how);
  }
});

test('an Undo whose older own segment the foreign gap overlaps fails whole and overwrites nothing', { skip }, async () => {
  for (const how of ['record', 'composer', 'live']) {
    _resetTurnSnapshotForTest();
    const sessionId = `foreign-gap-overlap-${how}`;
    const repo = seedRepo({ 'a.txt': thirtyLines });
    await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
    // Line 3 is context of the line 2 hunk: undoing that segment would need it.
    editAroundForeign(sessionId, repo, 3);
    if (how !== 'live') await completeTurnSnapshot(sessionId);
    const before = readTree(repo, ['a.txt'])['a.txt'];
    await assert.rejects(undoTurn(how, repo, sessionId), /undo failed; the worktree was not changed/, how);
    assert.equal(readTree(repo, ['a.txt'])['a.txt'], before, how);
    if (how === 'live') await completeTurnSnapshot(sessionId);
    assert.deepEqual(statesOf(await getTurnChanges(sessionId, { checkpointId: 'cp' })), [['a.txt', 'M', 'applied']], how);
  }
});

test('a binary file rewritten between own writes undoes only its last own write, and only while unchanged', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'binary-gap';
  const bytes = (...values) => Buffer.from([0, ...values]);
  const repo = seedRepo({ 'blob.bin': bytes(1) });
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
  editTree(sessionId, repo, { 'blob.bin': bytes(2) });
  writeTree(repo, { 'blob.bin': bytes(3) });
  editTree(sessionId, repo, { 'blob.bin': bytes(4) });
  await completeTurnSnapshot(sessionId);
  const reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.equal(reply.canUndo, true, reply.reason);
  // Changed since: the Undo is refused and the bytes stay.
  writeTree(repo, { 'blob.bin': bytes(5) });
  await assert.rejects(revertTurnChanges(sessionId, 'cp', null, reply.revision), /undo failed/);
  assert.equal(readTree(repo, ['blob.bin'])['blob.bin'], bytes(5).toString('latin1'));
  // Unchanged: the last own write is undone back to the foreign bytes.
  writeTree(repo, { 'blob.bin': bytes(4) });
  await revertTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.equal(readTree(repo, ['blob.bin'])['blob.bin'], bytes(3).toString('latin1'));
});

test('the live and the restarted turn review show own edits only, never a foreign edit inside an own file', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const sessionId = 'review-own-segments';
  const repo = seedRepo({ 'a.txt': thirtyLines });
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
  editAroundForeign(sessionId, repo, 12);
  // A foreign append after the last own write, too.
  writeTree(repo, { 'a.txt': `${readTree(repo, ['a.txt'])['a.txt']}foreign tail\n` });
  const assertOwnOnly = (review, label) => {
    assert.deepEqual(counts(review.files), [['a.txt', 'M', 2, 2]], label);
    assert.match(review.patch, /^\+OWN 2$/m, label);
    assert.match(review.patch, /^\+OWN 22$/m, label);
    assert.doesNotMatch(review.patch, /FOREIGN|foreign tail/, label);
  };
  assertOwnOnly(await getTurnReviewDiff(repo, sessionId), 'live');
  await completeTurnSnapshot(sessionId);
  assertOwnOnly(await getTurnReviewDiff(repo, sessionId), 'sealed');
  _resetTurnSnapshotForTest();
  const recorded = await getTurnReviewDiff(repo, sessionId);
  assert.equal(recorded.reason, 'recorded');
  assertOwnOnly(recorded, 'restarted');
});

test('Undo of a pure binary rename refuses a file whose bytes changed since', { skip }, async () => {
  for (const how of ['record', 'composer']) {
    _resetTurnSnapshotForTest();
    const sessionId = `binary-rename-${how}`;
    const original = Buffer.from([0, 1, 2, 3]);
    const repo = seedRepo({ 'a.bin': original });
    await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
    moveTree(sessionId, repo, 'a.bin', 'b.bin');
    await completeTurnSnapshot(sessionId);
    const changed = Buffer.from([0, 9, 9]);
    writeTree(repo, { 'b.bin': changed });
    await assert.rejects(undoTurn(how, repo, sessionId), /undo failed; the worktree was not changed/, how);
    assert.deepEqual(readTree(repo, ['a.bin', 'b.bin']), { 'a.bin': null, 'b.bin': changed.toString('latin1') }, how);
    // Holding the moved bytes again, it moves back.
    writeTree(repo, { 'b.bin': original });
    await undoTurn(how, repo, sessionId);
    assert.deepEqual(readTree(repo, ['a.bin', 'b.bin']), { 'a.bin': original.toString('latin1'), 'b.bin': null }, how);
  }
});
