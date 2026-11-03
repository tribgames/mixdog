// A managed worktree's record follows the branch its checkout has now: a
// `git branch -m` (or switch) inside it is what the list, merge, removal and
// cleanup act on, and a followed branch is never deleted with the worktree;
// a detached HEAD keeps the recorded branch.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, afterEach, beforeEach, test } from 'node:test';
import {
  configureWorktreeManager,
  findWorktreeContaining,
  getSessionWorktree,
  listManagedWorktrees,
  mergeWorktreeIntoProject,
  reconcileManagedWorktrees,
  removeManagedWorktree,
  withRepoLock,
} from './manager.mjs';
import { getRecord, putRecord } from './registry.mjs';
import {
  cleanupTempDirs,
  commitFile,
  createTestWorktree as create,
  git,
  makeRepo,
  TEST_BRANCH_PREFIX,
  useTempDataDir,
} from './test-support.mjs';

let restore = () => {};

beforeEach(() => {
  useTempDataDir();
  restore = configureWorktreeManager({
    settings: { branchPrefix: TEST_BRANCH_PREFIX },
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: () => false,
  });
});

afterEach(() => restore());
after(() => cleanupTempDirs());

const branchExists = (repo, name) => git(repo, 'branch', '--list', name) !== '';

const unmergedOn = (branch) => (error) => {
  assert.equal(error.code, 'WORKTREE_UNMERGED');
  assert.equal(error.details.branch, branch);
  assert.equal(error.details.commits, 1);
  return true;
};

test('a branch renamed inside a managed worktree is the listed and persisted branch; the merge target stays', async () => {
  const repo = makeRepo();
  const { entry, sessionId } = await create(repo);
  git(entry.path, 'branch', '-m', 'place');
  const [row] = await listManagedWorktrees();
  assert.equal(row.branch, 'place');
  assert.equal(row.mergeTarget, 'main');
  const stored = await getRecord(entry.id);
  assert.equal(stored.branch, 'place');
  assert.equal(stored.mergeTarget, 'main');
  assert.equal(stored.existingBranch, true);
  assert.equal((await findWorktreeContaining(entry.path)).branch, 'place');
  assert.equal((await getSessionWorktree(sessionId)).branch, 'place');
});

test('removal and merge of a renamed worktree act on the renamed branch', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  commitFile(entry.path, 'work.txt', 'work\n');
  git(entry.path, 'branch', '-m', 'place');
  // Its unmerged commit keeps it (a stale name would read as nothing unmerged).
  await assert.rejects(removeManagedWorktree({ entryId: entry.id }), unmergedOn('place'));
  assert.ok(existsSync(entry.path));
  const merged = await mergeWorktreeIntoProject({ entryId: entry.id, target: 'main', confirmed: true });
  assert.equal(merged.merged, true);
  assert.equal(git(repo, 'show', 'main:work.txt'), 'work');
  const tip = git(entry.path, 'rev-parse', 'HEAD');
  assert.deepEqual(await removeManagedWorktree({ entryId: entry.id }), { removed: true, branchDeleted: false });
  assert.equal(git(repo, 'rev-parse', 'place'), tip);
});

test('the cleanup keeps a renamed unmerged worktree and removes it once merged, keeping the branch', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  commitFile(entry.path, 'work.txt', 'work\n');
  git(entry.path, 'branch', '-m', 'place');
  const first = await reconcileManagedWorktrees({ removeOrphans: true, keepTip: true });
  assert.deepEqual(first.removed, []);
  assert.ok(first.kept.some((kept) => kept.id === entry.id && kept.reason === 'unmerged'));
  assert.ok(existsSync(entry.path));
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge place', 'place');
  const tip = git(repo, 'rev-parse', 'place');
  const second = await reconcileManagedWorktrees({ removeOrphans: true, keepTip: true });
  assert.deepEqual(second.removed, [entry.id]);
  assert.equal(existsSync(entry.path), false);
  assert.equal(git(repo, 'rev-parse', 'place'), tip);
});

test('a detached HEAD keeps the last recorded branch', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  commitFile(entry.path, 'work.txt', 'work\n');
  git(entry.path, 'branch', '-m', 'place');
  await listManagedWorktrees();
  git(entry.path, 'switch', '-q', '--detach');
  const [row] = await listManagedWorktrees();
  assert.equal(row.branch, 'place');
  assert.equal((await getRecord(entry.id)).branch, 'place');
  await assert.rejects(removeManagedWorktree({ entryId: entry.id }), unmergedOn('place'));
});

test('a rename back is followed too, and the branch stays with the worktree gone', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  const original = entry.branch;
  git(entry.path, 'branch', '-m', 'place');
  assert.equal((await listManagedWorktrees())[0].branch, 'place');
  git(entry.path, 'branch', '-m', original);
  assert.equal((await listManagedWorktrees())[0].branch, original);
  assert.equal((await getRecord(entry.id)).existingBranch, true);
  const removed = await removeManagedWorktree({ entryId: entry.id });
  assert.equal(removed.removed, true);
  assert.equal(removed.branchDeleted, false);
  assert.ok(branchExists(repo, original));
  assert.equal(branchExists(repo, 'place'), false);
});

test('a switch to a user branch whose original was then deleted never deletes the user branch', async () => {
  const repo = makeRepo();
  git(repo, 'branch', 'user-owned');
  const { entry } = await create(repo);
  git(entry.path, 'switch', '-q', 'user-owned');
  git(repo, 'branch', '-D', entry.branch);
  const [row] = await listManagedWorktrees();
  assert.equal(row.branch, 'user-owned');
  assert.equal((await getRecord(entry.id)).existingBranch, true);
  const removed = await removeManagedWorktree({ entryId: entry.id });
  assert.equal(removed.removed, true);
  assert.equal(removed.branchDeleted, false);
  assert.ok(branchExists(repo, 'user-owned'));
});

test('a user branch renamed through the recorded name is followed and never deleted', async () => {
  const repo = makeRepo();
  git(repo, 'branch', 'user-owned');
  const { entry } = await create(repo);
  const original = entry.branch;
  git(entry.path, 'switch', '-q', 'user-owned');
  git(repo, 'branch', '-D', original);
  git(entry.path, 'branch', '-m', original);
  git(entry.path, 'branch', '-m', 'user-renamed');
  const [row] = await listManagedWorktrees();
  assert.equal(row.branch, 'user-renamed');
  assert.equal((await getRecord(entry.id)).existingBranch, true);
  const removed = await removeManagedWorktree({ entryId: entry.id });
  assert.equal(removed.removed, true);
  assert.equal(removed.branchDeleted, false);
  assert.ok(branchExists(repo, 'user-renamed'));
});

test('a chained rename is followed to its last name, which stays with the worktree gone', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  const original = entry.branch;
  git(entry.path, 'branch', '-m', 'place');
  git(repo, 'branch', original);
  git(entry.path, 'branch', '-m', 'place-review');
  const [row] = await listManagedWorktrees();
  assert.equal(row.branch, 'place-review');
  assert.equal((await getRecord(entry.id)).existingBranch, true);
  const removed = await removeManagedWorktree({ entryId: entry.id });
  assert.equal(removed.removed, true);
  assert.equal(removed.branchDeleted, false);
  assert.ok(branchExists(repo, 'place-review'));
  assert.ok(branchExists(repo, original), "the user's branch of the old name stays");
});

test('a whole-record write paused under the repository lock never reverts a follow', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  const original = entry.branch;
  const { repoCommonDir } = await getRecord(entry.id);
  git(entry.path, 'branch', '-m', 'place');
  // markWorktreeDisposable's read → write under the lock, paused between the two.
  let locked;
  const hasLock = new Promise((resolve) => (locked = resolve));
  let resume;
  const paused = new Promise((resolve) => (resume = resolve));
  const writer = withRepoLock(repoCommonDir, async () => {
    const current = await getRecord(entry.id);
    locked();
    await paused;
    current.disposable = true;
    await putRecord(current);
  });
  await hasLock;
  const listing = listManagedWorktrees();
  await Promise.race([listing, new Promise((resolve) => setTimeout(resolve, 500))]);
  resume();
  await writer;
  assert.equal((await listing)[0].branch, 'place');
  const stored = await getRecord(entry.id);
  assert.equal(stored.branch, 'place');
  assert.equal(stored.existingBranch, true);
  assert.equal(stored.disposable, true);
  // Renamed back onto the recorded-before name: still never deleted.
  git(entry.path, 'branch', '-m', original);
  const removed = await removeManagedWorktree({ entryId: entry.id });
  assert.equal(removed.branchDeleted, false);
  assert.ok(branchExists(repo, original));
});

test('a stale whole-record write never turns existingBranch back to false', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  const stale = await getRecord(entry.id);
  git(entry.path, 'branch', '-m', 'place');
  await listManagedWorktrees();
  await putRecord({ ...stale, disposable: true });
  assert.equal((await getRecord(entry.id)).existingBranch, true);
  git(entry.path, 'branch', '-m', entry.branch);
  const removed = await removeManagedWorktree({ entryId: entry.id });
  assert.equal(removed.removed, true);
  assert.equal(removed.branchDeleted, false);
  assert.ok(branchExists(repo, entry.branch));
});

test('a switch to another branch is followed, and neither branch is deleted with the worktree', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  const original = entry.branch;
  git(entry.path, 'switch', '-q', '-c', 'side');
  const [row] = await listManagedWorktrees();
  assert.equal(row.branch, 'side');
  assert.equal((await getRecord(entry.id)).existingBranch, true);
  const removed = await removeManagedWorktree({ entryId: entry.id });
  assert.equal(removed.removed, true);
  assert.equal(removed.branchDeleted, false);
  assert.ok(branchExists(repo, 'side'));
  assert.ok(branchExists(repo, original));
});
