// Managed worktree removal, reconcile, prune and the deleted-session cleanup
// against real git (creation and merge: manager.slow.test.mjs).
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { managedWorktreeRoot, registerRootCleanup, registerRootReleaser } from './contract.mjs';
import {
  checkoutProjectBranch,
  configureWorktreeManager,
  getSessionWorktree,
  listBranchOccupancy,
  listManagedWorktrees,
  markWorktreeDisposable,
  mergeWorktreeIntoProject,
  reconcileManagedWorktrees,
  removeManagedWorktree,
} from './manager.mjs';
import {
  cleanupDeletedSessionWorktree,
  previewWorktreeCleanup,
  pruneWorktrees,
  reconcileWorktreesAtStartup,
  reconcileWorktreesAtStartup as reconcileAtStartup,
  setArchivedSessionWorktrees,
} from './maintenance.mjs';
import { readOwnerLease } from './owner.mjs';
import { canonicalPath, samePath } from './paths.mjs';
import { getRecord, putRecord, readRegistry } from './registry.mjs';
import {
  cleanupTempDirs,
  commitFile,
  createTestWorktree as create,
  git,
  makeRepo,
  prefixedBranches,
  TEST_BRANCH_PREFIX,
  tempDir,
  useTempDataDir,
  writeFile,
  writeHook,
} from './test-support.mjs';

let restore = () => {};
let counter = 0;

beforeEach(() => {
  counter += 1;
  useTempDataDir();
  // Every lease here is written by this test process: treat its holders as gone
  // unless a test says otherwise.
  restore = configureWorktreeManager({
    settings: { branchPrefix: TEST_BRANCH_PREFIX },
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: () => false,
  });
});

afterEach(() => restore());
after(() => cleanupTempDirs());

const worktreeCount = (repo) => git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length;

test('removal refuses dirty or unmerged worktrees, deletes the merged branch, and keeps an unmerged one forced', async () => {
  const repo = makeRepo();
  const cleanups = [];
  const unregister = registerRootCleanup(`test-${counter}`, (root) => cleanups.push(root));
  try {
    const { entry } = await create(repo);
    writeFileSync(join(entry.path, 'scratch.txt'), 'untracked\n');
    await assert.rejects(removeManagedWorktree({ entryId: entry.id }), { code: 'WORKTREE_DIRTY' });
    git(entry.path, 'add', 'scratch.txt');
    git(entry.path, 'commit', '-q', '-m', 'work');
    await assert.rejects(removeManagedWorktree({ entryId: entry.id }), (error) => {
      assert.equal(error.code, 'WORKTREE_UNMERGED');
      assert.equal(error.details.commits, 1);
      return true;
    });
    assert.equal((await getRecord(entry.id)).state, 'ready');

    const merged = await mergeWorktreeIntoProject({ entryId: entry.id, target: 'main', confirmed: true });
    assert.equal(merged.merged, true);
    const removed = await removeManagedWorktree({ entryId: entry.id });
    assert.deepEqual(removed, { removed: true, branchDeleted: true });
    assert.equal(existsSync(entry.path), false);
    assert.deepEqual(prefixedBranches(repo), []);
    assert.equal(await getRecord(entry.id), null);
    assert.ok(cleanups.some((root) => samePath(root, entry.path)));
    assert.equal(worktreeCount(repo), 1);

    // Forced past unmerged work: its branch keeps the commits and is reported.
    const forced = await create(repo, { nameHint: 'forced' });
    const lostTip = commitFile(forced.entry.path, 'lost.txt', 'lost\n');
    writeFileSync(join(forced.entry.path, 'dirty.txt'), 'dirty\n');
    assert.deepEqual(await removeManagedWorktree({ entryId: forced.entry.id, force: true }), {
      removed: true,
      preservedBranch: { name: forced.entry.branch, head: lostTip },
    });
    assert.equal(git(repo, 'rev-parse', forced.entry.branch), lostTip);
    assert.equal(git(repo, 'show', `${forced.entry.branch}:lost.txt`), 'lost');
    await assert.rejects(removeManagedWorktree({ entryId: forced.entry.id }), { code: 'WORKTREE_MISSING' });
  } finally {
    unregister();
  }
});

test("removing a repository's last worktree drops its empty store folder, never while others remain", async () => {
  const repo = makeRepo();
  const root = managedWorktreeRoot(canonicalPath(join(repo, '.git')));
  const first = await create(repo, { nameHint: 'first' });
  const second = await create(repo, { nameHint: 'second' });
  assert.ok(existsSync(join(root, '.owners')));
  await removeManagedWorktree({ entryId: first.entry.id, force: true });
  assert.ok(existsSync(join(root, '.owners')), 'the other worktree still owns the folder');
  assert.ok(existsSync(second.entry.path));
  // A stray file keeps the folder even after the last worktree goes.
  writeFileSync(join(root, 'stray.txt'), 'keep\n');
  await removeManagedWorktree({ entryId: second.entry.id, force: true });
  assert.equal(existsSync(join(root, '.owners')), false, 'the empty owners folder is gone');
  assert.ok(existsSync(join(root, 'stray.txt')), 'a non-empty folder stays');
  rmSync(join(root, 'stray.txt'));
  // The last removal of a clean store leaves nothing behind; a new worktree recreates it.
  const third = await create(repo, { nameHint: 'third' });
  await removeManagedWorktree({ entryId: third.entry.id, force: true });
  assert.equal(existsSync(root), false);
  // A failed creation rolls back to nothing too.
  writeHook(repo, 'post-checkout', '#!/bin/sh\nexit 1\n');
  await assert.rejects(create(repo, { nameHint: 'boom' }));
  assert.equal(existsSync(root), false);
});

test("removing a worktree leaves its turns' change records listed but without Undo/Reapply", async () => {
  const { WORKTREE_CACHE_CLEANUPS } = await import('./cache-cleanups.mjs');
  const { storedChangeFile } = await import('../turn-changes.mjs');
  const { updateTurnChangeRecord, upsertTurnChangeRecord } = await import('../turn-snapshot-store.mjs');
  const { getTurnChanges, reapplyTurnChanges, revertTurnChanges } = await import('../turn-snapshot.mjs');
  const repo = makeRepo();
  const { entry, sessionId } = await create(repo);
  const off = registerRootCleanup(`changes-${counter}`, WORKTREE_CACHE_CLEANUPS['turn-snapshot-store']);
  try {
    const file = (path, state) => ({
      ...storedChangeFile({
        path,
        status: 'A',
        additions: 1,
        deletions: 0,
        revertable: true,
        patch: Buffer.from(
          `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`
        ),
      }),
      state,
    });
    await upsertTurnChangeRecord(sessionId, {
      checkpointId: 'cp',
      kind: 'git',
      root: entry.path,
      files: [file('a.txt')],
    });
    await updateTurnChangeRecord(sessionId, 'cp', (record) => [...record.files, file('b.txt', 'reverted')]);
    const before = await getTurnChanges(sessionId, { checkpointId: 'cp' });
    assert.equal(before.canUndo, true);
    assert.equal(before.canReapply, true);

    assert.equal((await removeManagedWorktree({ entryId: entry.id, force: true })).removed, true);
    assert.equal(existsSync(entry.path), false);

    const removed = await getTurnChanges(sessionId, { checkpointId: 'cp' });
    assert.equal(removed.status, 'ready');
    assert.equal(removed.revision, before.revision + 1);
    assert.deepEqual(
      removed.files.map((row) => [row.path, row.state, row.revertable, row.reason]),
      [
        ['a.txt', 'applied', false, 'its worktree was removed'],
        ['b.txt', 'reverted', false, 'its worktree was removed'],
      ]
    );
    assert.equal(removed.canUndo, false);
    assert.equal(removed.canReapply, false);
    assert.equal((await getTurnChanges(sessionId, { checkpointId: 'cp', patch: true })).patch, '');
    await assert.rejects(revertTurnChanges(sessionId, 'cp', null, removed.revision), /its worktree was removed/);
    await assert.rejects(reapplyTurnChanges(sessionId, 'cp', 'b.txt', removed.revision), /its worktree was removed/);
    assert.equal(existsSync(entry.path), false, 'a refused Undo/Reapply never recreates the folder');
  } finally {
    off();
  }
});

test('git runs with command-scoped long paths, read-only status probes and a stopped fsmonitor', async () => {
  const repo = makeRepo();
  // Trace2 `start` events record each git process's full argv, global options included.
  const trace = join(tempDir('mixdog-wt-trace-'), 'git.trace2');
  const previous = process.env.GIT_TRACE2;
  process.env.GIT_TRACE2 = trace;
  try {
    const { entry } = await create(repo);
    await removeManagedWorktree({ entryId: entry.id });
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2;
    else process.env.GIT_TRACE2 = previous;
  }
  const starts = readFileSync(trace, 'utf8')
    .split(/\r?\n/)
    .filter((line) => / start /.test(line));
  assert.ok(
    starts.some((line) => /-c core\.longpaths=true worktree add /.test(line)),
    'worktree add'
  );
  assert.ok(
    starts.some((line) => /--no-optional-locks -c core\.fsmonitor=false -c core\.longpaths=true status /.test(line)),
    'read-only status'
  );
  assert.ok(
    starts.some((line) => /fsmonitor--daemon stop/.test(line)),
    'fsmonitor stopped before removal'
  );
  // Nothing was written to the repository config.
  assert.throws(() => git(repo, 'config', '--local', '--get', 'core.longpaths'));
});

test('a Project in a repository subfolder: its identity copy is not dirt and its session root is cleaned', async () => {
  const repo = makeRepo();
  commitFile(repo, 'packages/app/index.js', 'export {};\n');
  const sub = join(repo, 'packages', 'app');
  const { entry } = await create(sub);
  assert.equal(entry.projectSubdir, 'packages/app');
  assert.ok(samePath(entry.projectPath, sub));
  const cleaned = [];
  const off = registerRootCleanup(`sub-${counter}`, (root) => cleaned.push(root));
  try {
    writeFile(entry.path, 'packages/app/.mixdog/project.id', 'project-123\n');
    assert.equal((await removeManagedWorktree({ entryId: entry.id })).removed, true);
    assert.ok(cleaned.some((root) => samePath(root, entry.path)));
    assert.ok(cleaned.some((root) => samePath(root, join(entry.path, 'packages', 'app'))));
  } finally {
    off();
  }
});

test('the session project id copy is ignored by the dirty check, and only that path; removal releases handles, then drops caches, then removes the checkout', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  writeFile(entry.path, '.mixdog/project.id', 'project-123\n');
  writeFile(entry.path, '.mixdog/other.json', '{}\n');
  await assert.rejects(removeManagedWorktree({ entryId: entry.id }), (error) => {
    assert.equal(error.code, 'WORKTREE_DIRTY');
    assert.deepEqual(error.details.files, ['.mixdog/other.json']);
    return true;
  });
  rmSync(join(entry.path, '.mixdog', 'other.json'));
  const order = [];
  const offReleaser = registerRootReleaser(`terminals-${counter}`, (root) => {
    order.push(['release', samePath(root, entry.path), existsSync(entry.path)]);
  });
  const offCleanup = registerRootCleanup(`cache-${counter}`, (root) => {
    order.push(['cleanup', samePath(root, entry.path), existsSync(entry.path)]);
  });
  try {
    assert.equal((await removeManagedWorktree({ entryId: entry.id })).removed, true);
    assert.deepEqual(order, [
      ['release', true, true],
      ['cleanup', true, true],
    ]);
    assert.equal(existsSync(entry.path), false);
  } finally {
    offReleaser();
    offCleanup();
  }
});

test('a deletion that cannot finish stays durable and resumes', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  let failures = 1;
  const unregister = registerRootCleanup(`flaky-${counter}`, () => {
    if (failures-- > 0) throw Object.assign(new Error('still in use'), { code: 'EBUSY' });
  });
  try {
    const partial = await removeManagedWorktree({ entryId: entry.id });
    assert.equal(partial.removed, false);
    assert.equal(partial.retryable, true);
    assert.deepEqual(
      partial.remaining.map((item) => item.kind),
      ['cleanup']
    );
    const record = await getRecord(entry.id);
    assert.equal(record.state, 'deleting');
    assert.equal(await getSessionWorktree(entry.ownerSessionId).then((view) => view.state), 'deleting');
    assert.equal((await removeManagedWorktree({ entryId: entry.id })).removed, true);
    assert.equal(await getRecord(entry.id), null);
  } finally {
    unregister();
  }
});

test('nothing outside a managed checkout of this repository is ever deleted (WORKTREE_PATH_UNSAFE)', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  const record = await getRecord(entry.id);
  // A record pointing outside the managed root.
  const victim = tempDir('mixdog-wt-victim-');
  writeFileSync(join(victim, 'precious.txt'), 'keep\n');
  await putRecord({ ...record, path: victim });
  await assert.rejects(removeManagedWorktree({ entryId: entry.id, force: true }), (error) => {
    assert.equal(error.code, 'WORKTREE_PATH_UNSAFE');
    assert.equal(error.details.reason, 'outside-managed-root');
    return true;
  });
  assert.equal(readFileSync(join(victim, 'precious.txt'), 'utf8'), 'keep\n');
  assert.equal((await getRecord(entry.id)).state, 'ready', 'nothing was decided');
  // The managed path, but its .git links into another repository.
  await putRecord(record);
  const dotGit = join(entry.path, '.git');
  const original = readFileSync(dotGit, 'utf8');
  const other = makeRepo();
  // Git hides the .git file on Windows: replace it rather than overwrite it.
  rmSync(dotGit, { force: true });
  writeFileSync(dotGit, `gitdir: ${join(other, '.git', 'worktrees', 'x')}\n`);
  await assert.rejects(removeManagedWorktree({ entryId: entry.id, force: true }), (error) => {
    assert.equal(error.code, 'WORKTREE_PATH_UNSAFE');
    assert.equal(error.details.reason, 'foreign-back-link');
    return true;
  });
  assert.ok(existsSync(join(entry.path, 'README.md')));
  rmSync(dotGit, { force: true });
  writeFileSync(dotGit, original);
  assert.equal((await removeManagedWorktree({ entryId: entry.id, force: true })).removed, true);
});

test('stale registrations: locked ones are kept, a prunable external one never occupies its branch', async () => {
  const repo = makeRepo();
  // A managed worktree deleted behind Mixdog's back stays locked: reconcile keeps its registration.
  const vanished = await create(repo, { nameHint: 'vanished' });
  rmSync(vanished.entry.path, { recursive: true, force: true });
  const report = await reconcileManagedWorktrees({ retainedSessionIds: [vanished.sessionId] });
  assert.deepEqual(report.pruned, []);
  assert.deepEqual(report.missing, [vanished.entry.id]);
  assert.equal(worktreeCount(repo), 2);
  // Removing that record (it is being deleted) prunes its own locked registration.
  assert.equal((await removeManagedWorktree({ entryId: vanished.entry.id, force: true })).removed, true);
  assert.equal(worktreeCount(repo), 1);

  // An unmanaged worktree whose folder is gone is `prunable`: its branch is free.
  const external = join(tempDir('mixdog-wt-ext-'), 'side');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', external);
  rmSync(external, { recursive: true, force: true });
  const menu = await listBranchOccupancy({ projectPath: repo });
  assert.equal(menu.occupancy.find((row) => row.branch === 'side').kind, 'free');
  const switched = await checkoutProjectBranch({ projectPath: repo, branch: 'side' });
  assert.equal(switched.changed, true);
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'side');
  assert.equal(worktreeCount(repo), 1, 'exactly that registration was pruned');
});

test('startup reconcile recovers interrupted creations, resumes deletions and keeps retained worktrees', async () => {
  const repo = makeRepo();
  const crashed = await create(repo, { nameHint: 'crashed' });
  const retainedCrash = await create(repo, { nameHint: 'retained crash' });
  const disposable = await create(repo, { nameHint: 'disposable' });
  const dirtyDisposable = await create(repo, { nameHint: 'dirty disposable' });
  const kept = await create(repo, { nameHint: 'kept' });
  const orphan = await create(repo, { nameHint: 'orphan' });
  const retained = await create(repo, { nameHint: 'retained' });
  const interrupted = await create(repo, { nameHint: 'interrupted' });

  // Simulate crashes mid-creation (ledger proves this transaction made them).
  for (const { entry } of [crashed, retainedCrash]) {
    const record = await getRecord(entry.id);
    await putRecord({ ...record, state: 'creating' });
  }
  // A deletion the session already decided, interrupted: resumed even though its session is stored.
  await putRecord({
    ...(await getRecord(interrupted.entry.id)),
    state: 'deleting',
    deleting: { force: false, startedAt: 1, remaining: [] },
  });
  await markWorktreeDisposable(disposable.entry.id);
  await markWorktreeDisposable(dirtyDisposable.entry.id);
  writeFileSync(join(dirtyDisposable.entry.path, 'notes.txt'), 'keep me\n');

  const stored = [retainedCrash.sessionId, kept.sessionId, retained.sessionId, interrupted.sessionId];
  // autoCleanup off: nothing is removed automatically.
  const cautious = await reconcileManagedWorktrees({ liveSessionIds: [kept.sessionId], retainedSessionIds: stored });
  assert.deepEqual(cautious.removed, [interrupted.entry.id]);
  assert.deepEqual(cautious.recovered, [crashed.entry.id]);
  assert.ok(existsSync(disposable.entry.path));
  assert.ok(existsSync(orphan.entry.path));

  const report = await reconcileManagedWorktrees({
    liveSessionIds: [kept.sessionId],
    retainedSessionIds: stored,
    removeOrphans: true,
  });
  assert.deepEqual(report.removed.sort(), [disposable.entry.id, orphan.entry.id].sort());
  assert.ok(report.kept.some((item) => item.id === retainedCrash.entry.id && item.reason === 'retained'));
  assert.ok(report.kept.some((item) => item.id === dirtyDisposable.entry.id && item.reason === 'dirty'));
  assert.deepEqual(report.errors, []);
  // Leases of owners neither live nor running are released; durable ownership stays.
  assert.ok(cautious.leasesReleased.includes(dirtyDisposable.entry.id));
  assert.equal(await readOwnerLease(dirtyDisposable.entry), null);
  assert.ok(await readOwnerLease(kept.entry));
  assert.equal((await getSessionWorktree(dirtyDisposable.sessionId)).id, dirtyDisposable.entry.id);

  for (const gone of [crashed, disposable, orphan, interrupted]) assert.equal(existsSync(gone.entry.path), false);
  for (const stays of [retainedCrash, dirtyDisposable, kept, retained]) assert.ok(existsSync(stays.entry.path));
  const branches = prefixedBranches(repo);
  assert.ok(branches.includes(retainedCrash.entry.branch));
  assert.ok(branches.includes(retained.entry.branch));
  assert.equal(branches.includes(orphan.entry.branch), false, "a removed worktree's merged branch goes");
});

test('a lease held by a running process keeps its worktree through reconcile and prune', async () => {
  restore();
  restore = configureWorktreeManager({
    settings: { branchPrefix: TEST_BRANCH_PREFIX },
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: (pid) => pid === process.pid,
  });
  const repo = makeRepo();
  const running = await create(repo, { nameHint: 'running' });
  const report = await reconcileManagedWorktrees({ retainedSessionIds: [], removeOrphans: true });
  assert.deepEqual(report.removed, []);
  assert.deepEqual(report.leasesReleased, []);
  assert.ok(existsSync(running.entry.path));
  const [row] = await listManagedWorktrees({ retainedSessionIds: [] });
  assert.equal(row.ownerLive, true);
  assert.equal(row.removable, false);
});

test('reconcile keeps a branch that moved during an interrupted creation', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo, { nameHint: 'moved' });
  commitFile(entry.path, 'work.txt', 'work\n');
  const record = await getRecord(entry.id);
  await putRecord({ ...record, state: 'recovery' });
  const report = await reconcileManagedWorktrees({ liveSessionIds: [], retainedSessionIds: [] });
  assert.deepEqual(report.recovered, []);
  assert.ok(report.kept.some((item) => item.id === entry.id && item.reason === 'recovery'));
  assert.ok(prefixedBranches(repo).includes(entry.branch));
  const recovery = await getRecord(entry.id);
  assert.equal(recovery.state, 'recovery');
  assert.equal(recovery.recovery.txId, record.txId);
  assert.deepEqual(
    recovery.recovery.remaining.map((item) => item.reason),
    ['moved']
  );
});

test('maintenance: startup honors autoCleanup and stored sessions; prune and deleted-session cleanup', async () => {
  const repo = makeRepo();
  const stored = await create(repo, { nameHint: 'stored' });
  const orphan = await create(repo, { nameHint: 'orphan' });
  const listSessionIds = async () => [stored.sessionId];

  restore();
  restore = configureWorktreeManager({
    settings: { branchPrefix: TEST_BRANCH_PREFIX, autoCleanup: false },
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: () => false,
  });
  assert.deepEqual((await reconcileWorktreesAtStartup({ listSessionIds })).removed, []);
  const rows = await listManagedWorktreesRows(listSessionIds);
  assert.deepEqual(
    rows.map((row) => [row.id, row.retained, row.removable]).sort(),
    [
      [orphan.entry.id, false, true],
      [stored.entry.id, true, false],
    ].sort()
  );
  // A manual prune is explicit: it removes the orphan even with autoCleanup off, never the stored one.
  assert.deepEqual((await pruneWorktrees({ listSessionIds })).removed, [orphan.entry.id]);
  assert.ok(existsSync(stored.entry.path));

  // The stored session is deleted: off → kept; on → removed when clean and merged.
  assert.deepEqual(await cleanupDeletedSessionWorktree(stored.sessionId), {
    entryId: stored.entry.id,
    removed: false,
    reason: 'auto-cleanup-off',
  });
  writeFileSync(join(stored.entry.path, 'wip.txt'), 'wip\n');
  const dirty = await cleanupDeletedSessionWorktree(stored.sessionId, { autoCleanup: true });
  assert.deepEqual(dirty, { entryId: stored.entry.id, removed: false, reason: 'WORKTREE_DIRTY' });
  assert.equal((await getRecord(stored.entry.id)).disposable, true, 'kept for a later prune once clean');
  rmSync(join(stored.entry.path, 'wip.txt'));
  restore();
  restore = configureWorktreeManager({
    settings: { branchPrefix: TEST_BRANCH_PREFIX, autoCleanup: true },
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: () => false,
  });
  // Disposable (its session was deleted): startup removes it even though a tombstone is still stored.
  assert.deepEqual((await reconcileWorktreesAtStartup({ listSessionIds })).removed, [stored.entry.id]);
  assert.deepEqual((await readRegistry()).entries, {});
});

test('a squash- or cherry-merged branch counts as merged; partly merged, reverted-in-target or own-merge work refuses', async () => {
  const repo = makeRepo();
  // Two commits squashed into one on main.
  const squashed = await create(repo, { nameHint: 'squashed' });
  commitFile(squashed.entry.path, 'a.txt', 'a\n');
  commitFile(squashed.entry.path, 'b.txt', 'b\n');
  git(repo, 'merge', '--squash', squashed.entry.branch);
  git(repo, 'commit', '-q', '-m', 'squash');
  commitFile(repo, 'later.txt', 'later\n');
  // One commit cherry-picked onto main.
  const picked = await create(repo, { nameHint: 'picked' });
  const pickedTip = commitFile(picked.entry.path, 'c.txt', 'c\n');
  // -x: a pick within the same second onto the branch's own base would otherwise be the very same commit.
  git(repo, 'cherry-pick', '-x', pickedTip);
  // Two commits of which only the first reached main.
  const partial = await create(repo, { nameHint: 'partial' });
  const first = commitFile(partial.entry.path, 'd.txt', 'd\n');
  commitFile(partial.entry.path, 'e.txt', 'e\n');
  git(repo, 'cherry-pick', '-x', first);
  // A change cherry-picked onto main and reverted there afterwards: patch-equivalent, but not in main.
  const reverted = await create(repo, { nameHint: 'reverted' });
  const revertedTip = commitFile(reverted.entry.path, 'f.txt', 'f\n');
  git(repo, 'cherry-pick', '-x', revertedTip);
  git(repo, 'revert', '--no-edit', 'HEAD');
  // A merge commit of the branch's own that main never reached, though main has the merged change too.
  const merging = await create(repo, { nameHint: 'merging' });
  git(repo, 'checkout', '-q', '-b', 'side');
  commitFile(repo, 'g.txt', 'g\n');
  git(repo, 'checkout', '-q', 'main');
  git(merging.entry.path, 'merge', '-q', '--no-ff', '-m', 'merge side here', 'side');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge side into main', 'side');

  const refuses = async (entry, commits) =>
    assert.rejects(removeManagedWorktree({ entryId: entry.id }), (error) => {
      assert.equal(error.code, 'WORKTREE_UNMERGED');
      assert.equal(error.details.commits, commits);
      return true;
    });
  await refuses(partial.entry, 2);
  await refuses(reverted.entry, 1);
  await refuses(merging.entry, 1);
  const report = await reconcileManagedWorktrees({ retainedSessionIds: [], removeOrphans: true });
  assert.deepEqual(report.removed.sort(), [squashed.entry.id, picked.entry.id].sort());
  for (const { entry } of [partial, reverted, merging]) {
    assert.ok(
      report.kept.some((item) => item.id === entry.id && item.reason === 'unmerged'),
      entry.id
    );
    assert.ok(existsSync(entry.path), entry.id);
  }
  assert.deepEqual(
    prefixedBranches(repo).sort(),
    [partial.entry.branch, reverted.entry.branch, merging.entry.branch].sort(),
    'the squash- and cherry-merged branches go with their worktrees'
  );
  assert.equal(git(reverted.entry.path, 'rev-parse', 'HEAD'), revertedTip, 'the reverted change is kept');
});

test('reconcile prunes every registration whose folder is gone, unmanaged ones too, but keeps locked ones', async () => {
  const repo = makeRepo();
  const managed = await create(repo, { nameHint: 'managed' });
  const scratch = tempDir('mixdog-wt-scratch-');
  const gone = join(scratch, 'gone');
  const lockedGone = join(scratch, 'locked');
  git(repo, 'worktree', 'add', '-q', '--detach', gone);
  git(repo, 'worktree', 'add', '-q', '--detach', lockedGone);
  git(repo, 'worktree', 'lock', lockedGone);
  rmSync(gone, { recursive: true, force: true });
  rmSync(lockedGone, { recursive: true, force: true });
  assert.equal(worktreeCount(repo), 4);
  // Bookkeeping only: it runs with autoCleanup off as well.
  restore();
  restore = configureWorktreeManager({
    settings: { branchPrefix: TEST_BRANCH_PREFIX, autoCleanup: false },
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: () => false,
  });
  const report = await reconcileWorktreesAtStartup({ listSessionIds: async () => [managed.sessionId] });
  assert.deepEqual(report.pruned, [canonicalPath(gone)]);
  assert.equal(worktreeCount(repo), 3, 'the locked registration and the managed checkout stay');
  assert.ok(existsSync(managed.entry.path));
});

test('cleanup preview: candidates are unretained worktrees and gone registrations, nothing else, and it changes nothing', async () => {
  const repo = makeRepo();
  const stored = await create(repo, { nameHint: 'stored' });
  const orphan = await create(repo, { nameHint: 'orphan' });
  const listSessionIds = async () => [stored.sessionId];
  restore();
  restore = configureWorktreeManager({
    settings: { branchPrefix: TEST_BRANCH_PREFIX, autoCleanup: false },
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: () => false,
  });
  const preview = (extra = {}) =>
    previewWorktreeCleanup({
      listSessionIds,
      listJobs: async () => [],
      settings: { autoCleanup: false },
      repoCommonDir: stored.entry.repoCommonDir,
      ...extra,
    });
  assert.deepEqual(await preview(), { hasCandidates: true, ids: [orphan.entry.id], stale: [] });
  assert.ok(existsSync(orphan.entry.path), 'a preview removes nothing');
  // Another repository's worktrees are out of scope.
  assert.equal((await preview({ repoCommonDir: join(tempDir('mixdog-wt-other-'), '.git') })).hasCandidates, false);
  await pruneWorktrees({ listSessionIds });
  assert.equal((await preview()).hasCandidates, false, 'only the retained worktree is left');

  const scratch = tempDir('mixdog-wt-scratch-');
  const gone = join(scratch, 'gone');
  git(repo, 'worktree', 'add', '-q', '--detach', gone);
  assert.equal((await preview()).hasCandidates, false, 'a registration whose folder exists is not stale');
  rmSync(gone, { recursive: true, force: true });
  assert.deepEqual((await preview()).stale, [canonicalPath(gone)]);
  await pruneWorktrees({ listSessionIds });
  assert.equal((await preview()).hasCandidates, false);

  // autoCleanup on with a count limit selects the retained worktree without any git status check.
  const limited = await preview({
    settings: { autoCleanup: true, maxWorktrees: 0, unusedDays: 0 },
    readFavorites: async () => [],
  });
  assert.equal(limited.hasCandidates, false, 'no limit set: nothing selected');
  await putRecord({ ...(await getRecord(stored.entry.id)), createdAt: 1 });
  const aged = await preview({
    settings: { autoCleanup: true, maxWorktrees: 0, unusedDays: 1 },
    readFavorites: async () => [],
    readActivity: async () => ({}),
  });
  assert.deepEqual(aged.ids, [stored.entry.id]);
});

test("archiving marks a session's worktrees disposable only with autoCleanup on; startup then removes clean, merged ones", async () => {
  const repo = makeRepo();
  const clean = await create(repo, { nameHint: 'clean' });
  const dirty = await create(repo, { nameHint: 'dirty' });
  const unmerged = await create(repo, { nameHint: 'unmerged' });
  writeFileSync(join(dirty.entry.path, 'wip.txt'), 'wip\n');
  commitFile(unmerged.entry.path, 'work.txt', 'work\n');
  const sessions = [clean.sessionId, dirty.sessionId, unmerged.sessionId];
  // Older than the cleanup's one-hour minimum.
  for (const { entry } of [clean, dirty, unmerged]) {
    await putRecord({ ...(await getRecord(entry.id)), createdAt: Date.now() - 2 * 60 * 60_000 });
  }
  // Archived sessions stay in the store; a desktop reports no favorites.
  const storedIds = async () => sessions;
  const reconcileWorktreesAtStartup = (options) =>
    reconcileAtStartup({ ...options, readFavorites: async () => [], listJobs: async () => [] });
  const listSessionIds = storedIds;
  const configure = (autoCleanup) => {
    restore();
    restore = configureWorktreeManager({
      settings: { branchPrefix: TEST_BRANCH_PREFIX, autoCleanup },
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      processAlive: () => false,
    });
  };

  // Off: nothing is marked and startup removes nothing.
  configure(false);
  assert.deepEqual(await setArchivedSessionWorktrees(sessions, true), { changed: [], reason: 'auto-cleanup-off' });
  assert.deepEqual((await reconcileWorktreesAtStartup({ listSessionIds })).removed, []);
  for (const { entry } of [clean, dirty, unmerged]) assert.equal((await getRecord(entry.id)).disposable, false);

  // On: marked; a restore unmarks again.
  configure(true);
  assert.equal((await setArchivedSessionWorktrees(sessions, true)).changed.length, 3);
  assert.equal((await setArchivedSessionWorktrees([clean.sessionId], false)).changed.length, 1);
  assert.deepEqual((await reconcileWorktreesAtStartup({ listSessionIds })).removed, []);
  assert.ok(existsSync(clean.entry.path));
  await setArchivedSessionWorktrees([clean.sessionId], true);
  // Marked while on, then the toggle goes off: startup removes nothing.
  configure(false);
  assert.deepEqual((await reconcileWorktreesAtStartup({ listSessionIds })).removed, []);
  configure(true);
  const report = await reconcileWorktreesAtStartup({ listSessionIds });
  assert.deepEqual(report.removed, [clean.entry.id]);
  assert.ok(report.kept.some((item) => item.id === dirty.entry.id && item.reason === 'dirty'));
  assert.ok(report.kept.some((item) => item.id === unmerged.entry.id && item.reason === 'unmerged'));
  assert.ok(existsSync(dirty.entry.path));
  assert.ok(existsSync(join(dirty.entry.path, 'wip.txt')));
  assert.ok(prefixedBranches(repo).includes(unmerged.entry.branch));
});

async function listManagedWorktreesRows(listSessionIds) {
  return listManagedWorktrees({ retainedSessionIds: await listSessionIds() });
}

test('an interrupted removal of a half-deleted folder still finishes', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  // A previous attempt deleted .git but not the rest of the folder.
  await putRecord({
    ...(await getRecord(entry.id)),
    state: 'deleting',
    deleting: { force: true, startedAt: 1, remaining: [], lastAttemptAt: 2 },
  });
  rmSync(join(entry.path, '.git'));
  mkdirSync(join(entry.path, 'left-over'), { recursive: true });
  assert.equal((await removeManagedWorktree({ entryId: entry.id })).removed, true);
  assert.equal(existsSync(entry.path), false);
});

test('forced removal refuses an unrecorded directory link and never touches its target', async () => {
  const repo = makeRepo();
  const { entry, sessionId } = await create(repo);
  const target = tempDir('mixdog-wt-link-target-');
  writeFileSync(join(target, 'precious.txt'), 'keep\n');
  writeFileSync(join(entry.path, 'scratch.txt'), 'dirty\n');
  const linkPath = join(entry.path, 'out');
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  const refused = await removeManagedWorktree({ entryId: entry.id, sessionId, force: true });
  assert.equal(refused.removed, false, JSON.stringify(refused));
  assert.equal(refused.remaining.length, 1);
  assert.match(refused.remaining[0].error, /linked folders it did not create \(out\)/);
  assert.equal(readFileSync(join(target, 'precious.txt'), 'utf8'), 'keep\n');
  assert.ok(existsSync(join(entry.path, 'README.md')), 'nothing was deleted');
  assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
  rmSync(linkPath);
  const removed = await removeManagedWorktree({ entryId: entry.id, sessionId, force: true });
  assert.equal(removed.removed, true, JSON.stringify(removed));
  assert.equal(existsSync(entry.path), false);
  assert.equal(readFileSync(join(target, 'precious.txt'), 'utf8'), 'keep\n');
});

test('folder-only removal refuses an unrecorded directory link and never touches its target', async () => {
  const repo = makeRepo();
  commitFile(repo, '.gitignore', 'build/\n');
  const { entry, sessionId } = await create(repo);
  const target = tempDir('mixdog-wt-link-target-');
  writeFileSync(join(target, 'precious.txt'), 'keep\n');
  // An ignored junction a build tool made: the ledger does not know it.
  const linkPath = join(entry.path, 'build', 'out');
  mkdirSync(join(entry.path, 'build'), { recursive: true });
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  const refused = await removeManagedWorktree({ entryId: entry.id, sessionId, safeOnly: true });
  assert.equal(refused.removed, false, JSON.stringify(refused));
  assert.equal(refused.remaining.length, 1);
  assert.match(refused.remaining[0].error, /build\/out/);
  assert.equal(readFileSync(join(target, 'precious.txt'), 'utf8'), 'keep\n');
  assert.ok(existsSync(join(entry.path, 'README.md')), 'nothing was deleted');
  assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
  // With the link itself gone, the cleanup finishes and the target stays.
  rmSync(linkPath);
  const removed = await removeManagedWorktree({ entryId: entry.id, sessionId, safeOnly: true });
  assert.equal(removed.removed, true, JSON.stringify(removed));
  assert.equal(existsSync(entry.path), false);
  assert.equal(readFileSync(join(target, 'precious.txt'), 'utf8'), 'keep\n');
});

test('a failed folder-only removal restores a file link with its own type and the session lock', async () => {
  const repo = makeRepo();
  commitFile(repo, '.gitignore', 'config.json\n');
  writeFile(repo, 'config.json', '{"cfg":1}\n');
  // An explicit copy of an untracked, unignored file: not dirt to the manager,
  // but `git worktree remove` (no --force) refuses the untracked file.
  writeFile(repo, 'notes.txt', 'notes\n');
  writeFile(repo, '.worktreeinclude', 'copy notes.txt\nlink config.json\n');
  const { entry, sessionId } = await create(repo);
  const linked = join(entry.path, 'config.json');
  const symbolic = lstatSync(linked).isSymbolicLink();
  const record = await getRecord(entry.id);
  const ledger = record.resources.includes.find((item) => item.rel === 'config.json');
  assert.equal(ledger.linkType, symbolic ? 'file' : 'hard');

  const failed = await removeManagedWorktree({ entryId: entry.id, sessionId, safeOnly: true });
  assert.equal(failed.removed, false, JSON.stringify(failed));
  assert.deepEqual(
    failed.remaining.map((item) => item.kind),
    ['error']
  );
  assert.doesNotMatch(failed.remaining[0].error, /Not restored/);
  const info = lstatSync(linked);
  assert.equal(info.isSymbolicLink(), symbolic, 'the same kind of link is back');
  assert.equal(info.isDirectory(), false);
  if (!symbolic) assert.equal(info.ino, lstatSync(join(repo, 'config.json')).ino, 'the same hard-linked file');
  assert.equal(readFileSync(linked, 'utf8'), '{"cfg":1}\n');
  assert.match(git(repo, 'worktree', 'list', '--porcelain'), new RegExp(`locked mixdog session=${sessionId}`));
  assert.equal(readFileSync(join(repo, 'config.json'), 'utf8'), '{"cfg":1}\n');
});

const inProgressRefusal = (error) => error.code === 'WORKTREE_DIRTY' && /Git operation/.test(error.message);

test('a merge in progress over clean files refuses removal and keeps the checkout in cleanup', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  const mergeHead = git(entry.path, 'rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD');
  writeFileSync(mergeHead, `${git(repo, 'rev-parse', 'main')}\n`);
  assert.equal(git(entry.path, 'status', '--porcelain'), '');
  await assert.rejects(removeManagedWorktree({ entryId: entry.id }), inProgressRefusal);
  const report = await reconcileManagedWorktrees({ removeOrphans: true });
  assert.ok(report.kept.some((item) => item.id === entry.id && item.reason === 'dirty'));
  assert.ok(existsSync(entry.path));
  rmSync(mergeHead);
  assert.equal((await removeManagedWorktree({ entryId: entry.id })).removed, true);
});

test('a rebase in progress refuses removal', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  // The todo list becomes one `break`: the rebase stops with clean files and HEAD on main.
  const editor = `"${process.execPath.replaceAll('\\', '/')}" -e "require('fs').writeFileSync(process.argv[1], 'break\\n')"`;
  git(entry.path, '-c', `sequence.editor=${editor}`, 'rebase', '-q', '-i', 'main');
  assert.ok(existsSync(git(entry.path, 'rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge')));
  await assert.rejects(removeManagedWorktree({ entryId: entry.id }), inProgressRefusal);
  assert.ok(existsSync(entry.path));
});
