// Managed read-only snapshots against real git: a detached checkout in the
// managed store bound to no session, idempotent per transaction, removed with
// its holder's turn (removeSessionSnapshots), by the session deletion cleanup,
// and by the prune / startup reconcile once its holder is gone. Also the
// explicit start point of a new branch worktree (`git worktree add -b <b> <p> <c>`).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, afterEach, beforeEach, test } from 'node:test';
import { managedWorktreeRoot } from './contract.mjs';
import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from './activity-gate.mjs';
import {
  claimWorktreeSetup,
  configureWorktreeManager,
  createSnapshotWorktree,
  getSessionWorktree,
  listManagedWorktrees,
  reconcileManagedWorktrees,
  removeManagedWorktree,
  removeSessionSnapshots,
  removeSnapshotWorktree,
  resolveBranchWorkspace,
} from './manager.mjs';
import { cleanupDeletedSessionWorktree, pruneWorktrees } from './maintenance.mjs';
import { canonicalPath, isWithin, samePath } from './paths.mjs';
import { getRecord, putRecord } from './registry.mjs';
import {
  cleanupTempDirs,
  commitFile,
  git,
  makeRepo,
  nextIds,
  tempDir,
  useTempDataDir,
  writeFile,
  writeHook,
} from './test-support.mjs';

let restore = () => {};

beforeEach(() => {
  useTempDataDir();
  restore = configureWorktreeManager({
    settings: {},
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: () => false,
  });
});
afterEach(() => restore());
after(() => cleanupTempDirs());

const worktreeCount = (repo) => git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length;

async function snapshot(repo, extra = {}) {
  const ids = nextIds();
  const entry = await createSnapshotWorktree({ projectPath: repo, ...ids, ...extra });
  return { entry, ...ids };
}

test('a snapshot is a locked, detached managed checkout of the commit, bound to no session', async () => {
  const repo = makeRepo();
  const first = git(repo, 'rev-parse', 'HEAD');
  commitFile(repo, 'later.txt', 'later\n');
  const { entry, sessionId, runtimeToken, txId } = await snapshot(repo, { commit: first.slice(0, 12) });
  assert.equal(entry.kind, 'snapshot');
  assert.equal(entry.branch, null);
  assert.equal(entry.ownerSessionId, null);
  assert.equal(entry.holderSessionId, sessionId);
  assert.equal(entry.baseCommit, first);
  assert.ok(isWithin(managedWorktreeRoot(canonicalPath(join(repo, '.git'))), entry.path));
  assert.equal(git(entry.path, 'rev-parse', 'HEAD'), first);
  assert.equal(existsSync(join(entry.path, 'later.txt')), false);
  const listed = git(repo, 'worktree', 'list', '--porcelain');
  assert.match(listed, /detached/);
  assert.match(listed, /locked mixdog snapshot session=/);
  assert.equal(await getSessionWorktree(sessionId), null, 'the holder retains no worktree');
  // The same transaction answers with the same snapshot.
  const again = await createSnapshotWorktree({ projectPath: repo, sessionId, runtimeToken, txId, commit: first });
  assert.equal(again.id, entry.id);
  assert.equal(worktreeCount(repo), 2);
  await assert.rejects(
    createSnapshotWorktree({ projectPath: repo, sessionId: 'someone-else', runtimeToken, txId, commit: first }),
    { code: 'WORKTREE_REVISION_CONFLICT' }
  );
  await assert.rejects(snapshot(repo, { commit: 'no-such-commit' }), /does not exist/);
});

test('a snapshot honours the size confirmation like every managed checkout', async () => {
  const repo = makeRepo();
  restore();
  restore = configureWorktreeManager({
    settings: { sizeWarnBytes: 1 },
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: () => false,
  });
  await assert.rejects(snapshot(repo), (error) => {
    assert.equal(error.code, 'WORKTREE_LARGE_REPO_CONFIRM');
    assert.ok(error.details.estimateBytes > 1);
    return true;
  });
  assert.equal(worktreeCount(repo), 1, 'nothing was made');
  const { entry } = await snapshot(repo, { confirmLarge: true });
  assert.equal(existsSync(entry.path), true);
});

test('the holder turn end removes its snapshots, dirty or not; explicit removal guards like any worktree', async () => {
  const repo = makeRepo();
  const branchesBefore = git(repo, 'branch', '--list');
  const { entry, sessionId } = await snapshot(repo);
  const other = await snapshot(repo);
  writeFile(entry.path, 'README.md', 'scribbled\n');
  const report = await removeSessionSnapshots(sessionId);
  assert.deepEqual(report, { removed: [entry.id], kept: [] });
  assert.equal(existsSync(entry.path), false);
  assert.equal(await getRecord(entry.id), null);
  assert.equal(existsSync(other.entry.path), true, "another holder's snapshot stays");
  assert.equal(git(repo, 'branch', '--list'), branchesBefore, 'no branch is touched');

  writeFile(other.entry.path, 'README.md', 'changed\n');
  await assert.rejects(removeManagedWorktree({ entryId: other.entry.id }), { code: 'WORKTREE_DIRTY' });
  assert.equal((await removeManagedWorktree({ entryId: other.entry.id, force: true })).removed, true);
  assert.equal(worktreeCount(repo), 1);
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'hello\n');
});

test('prune and startup reconcile remove a snapshot whose holder is gone; a deleted session takes its own', async () => {
  const repo = makeRepo();
  const live = await snapshot(repo);
  const gone = await snapshot(repo);
  const rows = await listManagedWorktrees({ liveSessionIds: [live.sessionId] });
  const removable = Object.fromEntries(rows.map((row) => [row.id, row.removable]));
  assert.deepEqual(removable, { [live.entry.id]: false, [gone.entry.id]: true });
  // Whatever autoCleanup says: removeOrphans false is the startup default.
  const report = await reconcileManagedWorktrees({ liveSessionIds: [live.sessionId], removeOrphans: false });
  assert.deepEqual(report.removed, [gone.entry.id]);
  assert.deepEqual(report.kept, [{ id: live.entry.id, reason: 'snapshot-in-use' }]);
  assert.equal(existsSync(live.entry.path), true);

  assert.equal(await cleanupDeletedSessionWorktree(live.sessionId, { autoCleanup: false }), null);
  assert.equal(existsSync(live.entry.path), false);
  assert.equal(worktreeCount(repo), 1);
});

test('a snapshot a worker turn or background shell still runs in is kept until they end', async () => {
  const repo = makeRepo();
  const { entry, sessionId, txId } = await snapshot(repo);
  const txIds = [txId];
  // The leases a worker turn (ask-session) and a background shell take on their cwd.
  const leaveWorker = tryAdmitWorkspaceActivity('sess_worker', entry.path, { kind: 'turn' });
  const leaveShell = tryAdmitWorkspaceActivity('sess_worker', entry.path, { kind: 'command' });
  assert.deepEqual(await removeSessionSnapshots(sessionId, { txIds }), {
    removed: [],
    kept: [{ id: entry.id, txId, reason: 'in-use' }],
  });
  await assert.rejects(removeSnapshotWorktree({ entryId: entry.id, force: true }), (error) => {
    assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
    assert.equal(error.details.reason, 'folder-in-use');
    return true;
  });
  const report = await reconcileManagedWorktrees({ liveSessionIds: [], removeOrphans: true });
  assert.deepEqual(report.kept, [{ id: entry.id, reason: 'snapshot-in-use' }]);
  leaveWorker();
  assert.equal((await removeSessionSnapshots(sessionId, { txIds })).kept[0].reason, 'in-use');
  assert.equal(existsSync(entry.path), true);
  leaveShell();
  assert.deepEqual(await removeSessionSnapshots(sessionId, { txIds }), { removed: [entry.id], kept: [] });
  assert.equal(existsSync(entry.path), false);
  // A later turn's snapshot reuses the freed slug, yet the earlier turn's
  // transactions never name it.
  const later = await snapshot(repo, { sessionId });
  assert.equal(later.entry.id, entry.id);
  assert.deepEqual(await removeSessionSnapshots(sessionId, { txIds }), { removed: [], kept: [] });
  assert.equal(existsSync(later.entry.path), true);
});

test('a resumed (deleting) snapshot removal still waits for whatever entered the surviving folder', async () => {
  const repo = makeRepo();
  const { entry, sessionId, txId } = await snapshot(repo);
  // An earlier deletion stopped after it was decided: the folder survives.
  const record = await getRecord(entry.id);
  await putRecord({
    ...record,
    state: 'deleting',
    deleting: { force: true, startedAt: Date.now(), remaining: [{ kind: 'error', error: 'interrupted' }] },
  });
  const leave = tryAdmitWorkspaceActivity('sess_worker', entry.path, { kind: 'command' });
  assert.equal(typeof leave, 'function', 'a consumer entered the surviving folder');
  await assert.rejects(removeSnapshotWorktree({ entryId: entry.id, force: true }), (error) => {
    assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
    assert.equal(error.details.reason, 'folder-in-use');
    return true;
  });
  assert.equal((await removeSessionSnapshots(sessionId, { txIds: [txId] })).kept[0].reason, 'in-use');
  const report = await reconcileManagedWorktrees({ liveSessionIds: [], removeOrphans: true });
  assert.deepEqual(report.kept, [{ id: entry.id, reason: 'snapshot-in-use' }]);
  assert.equal(existsSync(join(entry.path, 'README.md')), true, 'never deleted under the consumer');
  leave();
  assert.deepEqual((await reconcileManagedWorktrees({ liveSessionIds: [] })).removed, [entry.id]);
  assert.equal(existsSync(entry.path), false);
});

test('a git write of another process in a snapshot and its removal never overlap', async () => {
  const repo = makeRepo();
  const { entry } = await snapshot(repo);
  // The child's commit runs a hook that announces itself, then holds the write open.
  const started = join(tempDir('mixdog-wt-signal-'), 'started');
  const hooks = tempDir('mixdog-wt-hooks-');
  writeHook(hooks, 'pre-commit', `#!/bin/sh\necho started > "${started.replaceAll('\\', '/')}"\nsleep 3\n`);
  git(repo, 'config', 'core.hooksPath', join(hooks, '.git', 'hooks').replaceAll('\\', '/'));
  const gitTool = new URL('../../agent/orchestrator/tools/builtin/git-command-tool.mjs', import.meta.url).href;
  // A git tool call in another process, run in `cwd`.
  const commitIn = (cwd) => `
    import { executeGitTool } from ${JSON.stringify(gitTool)};
    const result = await executeGitTool(
      { command: 'git commit --allow-empty -q -m during-removal' },
      ${JSON.stringify(cwd)},
      { sessionId: 'sess_child' }
    );
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', commitIn(entry.path)], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  for (let i = 0; i < 300 && !existsSync(started); i++) await delay(50);
  assert.equal(existsSync(started), true, `the child's write started (${stderr})`);
  // Mid-write, the removal refuses: the write holds the snapshot's workspace lease.
  await assert.rejects(removeSnapshotWorktree({ entryId: entry.id, force: true }), (error) => {
    assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
    assert.equal(error.details.reason, 'folder-in-use');
    return true;
  });
  assert.equal(await exited, 0, stderr);
  const result = JSON.parse(stdout);
  assert.doesNotMatch(String(result.text ?? result), /removed|nothing ran/);
  assert.equal(git(entry.path, 'log', '-1', '--format=%s'), 'during-removal', 'the write completed in place');
  assert.equal((await removeSnapshotWorktree({ entryId: entry.id, force: true })).removed, true);

  // The other way round: while a removal holds the folder, a write of another
  // process is refused before it runs.
  const second = (await snapshot(repo)).entry;
  const hold = holdWorkspaceActivity([second.path]);
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', commitIn(second.path)], {
      encoding: 'utf8',
    });
    assert.match(out, /is being removed; nothing ran/);
  } finally {
    hold();
  }
  assert.equal(
    git(second.path, 'log', '-1', '--format=%s'),
    git(repo, 'log', '-1', '--format=%s'),
    'nothing was committed'
  );
});

test('every new branch checkout keeps its first-turn setup pending in the registry until claimed once', async () => {
  const repo = makeRepo();
  const resolved = await resolveBranchWorkspace({ projectPath: repo, branch: 'raw-add', create: true, ...nextIds() });
  assert.equal((await getRecord(resolved.entry.id)).setup.pending, true);
  const claimed = await claimWorktreeSetup(resolved.entry.id);
  assert.ok(samePath(claimed.prepared.root, repo));
  assert.equal(await claimWorktreeSetup(resolved.entry.id), null, 'once');
  const { entry } = await snapshot(repo);
  assert.equal(await claimWorktreeSetup(entry.id), null, 'a snapshot has no setup');
});

test('a new branch worktree can start at an explicit commit', async () => {
  const repo = makeRepo();
  const first = git(repo, 'rev-parse', 'HEAD');
  commitFile(repo, 'later.txt', 'later\n');
  const resolved = await resolveBranchWorkspace({
    projectPath: repo,
    branch: 'from-first',
    create: true,
    startPoint: first,
    ...nextIds(),
  });
  assert.equal(resolved.created, true);
  assert.equal(git(repo, 'rev-parse', 'from-first'), first);
  assert.equal(resolved.entry.baseCommit, first);
  assert.equal(resolved.entry.mergeTarget, 'main');
  await assert.rejects(
    resolveBranchWorkspace({ projectPath: repo, branch: 'x', startPoint: first, ...nextIds() }),
    /startPoint needs create/
  );
});

test('a stale snapshot cleanup never removes the snapshot that replaced it', async () => {
  const repo = makeRepo();
  const stale = await snapshot(repo);
  const staleExpected = { kind: 'snapshot', txId: stale.txId, holderSessionId: stale.sessionId };
  await removeManagedWorktree({ entryId: stale.entry.id, force: true });
  // Another turn / session's snapshot now stands where the selected record was.
  const replacement = await snapshot(repo);
  const result = await removeSnapshotWorktree({
    entryId: replacement.entry.id,
    force: true,
    expected: staleExpected,
  });
  assert.deepEqual(result, { removed: false, skipped: true });
  assert.equal(existsSync(replacement.entry.path), true);
  assert.equal((await getRecord(replacement.entry.id)).txId, replacement.txId);
  // The same call with the replacement's own identity removes it.
  const own = { kind: 'snapshot', txId: replacement.txId, holderSessionId: replacement.sessionId };
  assert.equal(
    (await removeSnapshotWorktree({ entryId: replacement.entry.id, force: true, expected: own })).removed,
    true
  );
  // A record already gone is skipped through the snapshot wrapper too, not an error.
  assert.deepEqual(await removeSnapshotWorktree({ entryId: stale.entry.id, force: true, expected: staleExpected }), {
    removed: false,
    skipped: true,
  });
  // Without `expected` the wrapper keeps its guard.
  await assert.rejects(removeSnapshotWorktree({ entryId: stale.entry.id, force: true }), { code: 'WORKTREE_MISSING' });
});

test('a stale snapshot cleanup skips an entry that is now a branch worktree', async () => {
  const repo = makeRepo();
  const stale = await snapshot(repo);
  const staleExpected = { kind: 'snapshot', txId: stale.txId, holderSessionId: stale.sessionId };
  const resolved = await resolveBranchWorkspace({ projectPath: repo, branch: 'kept', create: true, ...nextIds() });
  assert.deepEqual(await removeSnapshotWorktree({ entryId: resolved.entry.id, force: true, expected: staleExpected }), {
    removed: false,
    skipped: true,
  });
  assert.equal(existsSync(resolved.entry.path), true);
  assert.equal((await getRecord(resolved.entry.id)).kind, resolved.entry.kind);
  await assert.rejects(removeSnapshotWorktree({ entryId: resolved.entry.id, force: true }), {
    code: 'WORKTREE_MISSING',
  });
});

test('a prune limited to one repository leaves another repository worktrees alone', async () => {
  const mine = makeRepo();
  const other = makeRepo();
  const mineSnapshot = await snapshot(mine);
  const otherSnapshot = await snapshot(other);
  // Both holders are gone, so a global prune would remove both.
  const report = await pruneWorktrees({
    listSessionIds: async () => [],
    repoCommonDir: canonicalPath(join(mine, '.git')),
  });
  assert.deepEqual(report.removed, [mineSnapshot.entry.id]);
  assert.equal(existsSync(mineSnapshot.entry.path), false);
  assert.equal(existsSync(otherSnapshot.entry.path), true);
  assert.equal(worktreeCount(other), 2);
  const everything = await pruneWorktrees({ listSessionIds: async () => [] });
  assert.deepEqual(everything.removed, [otherSnapshot.entry.id]);
});
