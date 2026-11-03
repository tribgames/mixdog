// A managed worktree acts on the branch its checkout has now: a
// `git branch -m` (or switch) inside it is what the list, merge, removal and
// cleanup act on, read from HEAD at use time while the registry keeps the
// branch it was made on; a detached HEAD keeps the recorded branch. Removing
// the worktree deletes the recorded branch only when Mixdog created it, no
// worktree has it checked out and it is merged; any other branch stays.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, afterEach, beforeEach, test } from 'node:test';
import {
  configureWorktreeManager,
  findWorktreeContaining,
  forceDeleteBranch,
  getSessionWorktree,
  listManagedWorktrees,
  mergeWorktreeIntoProject,
  reconcileManagedWorktrees,
  removeManagedWorktree,
} from './manager.mjs';
import { getRecord, putRecord } from './registry.mjs';
import {
  cleanupTempDirs,
  commitFile,
  createTestWorktree as create,
  git,
  makeRepo,
  TEST_BRANCH_PREFIX,
  tempDir,
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

const unmergedOn = (branch) => (error) => {
  assert.equal(error.code, 'WORKTREE_UNMERGED');
  assert.equal(error.details.branch, branch);
  assert.equal(error.details.commits, 1);
  return true;
};

test('a branch renamed inside a managed worktree is the listed branch; the record keeps the one it was made on', async () => {
  const repo = makeRepo();
  const { entry, sessionId } = await create(repo);
  const before = await getRecord(entry.id);
  git(entry.path, 'branch', '-m', 'place');
  const [row] = await listManagedWorktrees();
  assert.equal(row.branch, 'place');
  assert.equal(row.mergeTarget, 'main');
  assert.deepEqual(await getRecord(entry.id), before, 'reading never rewrites the registry');
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
  // The recorded name is gone: the renamed branch is not Mixdog's to delete.
  assert.deepEqual(await removeManagedWorktree({ entryId: entry.id }), { removed: true });
  assert.equal(git(repo, 'rev-parse', 'place'), tip);
});

test('the cleanup keeps a renamed unmerged worktree and removes it once merged, its branch kept', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  commitFile(entry.path, 'work.txt', 'work\n');
  git(entry.path, 'branch', '-m', 'place');
  const first = await reconcileManagedWorktrees({ removeOrphans: true });
  assert.deepEqual(first.removed, []);
  assert.ok(first.kept.some((kept) => kept.id === entry.id && kept.reason === 'unmerged'));
  assert.ok(existsSync(entry.path));
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge place', 'place');
  const tip = git(repo, 'rev-parse', 'place');
  const second = await reconcileManagedWorktrees({ removeOrphans: true });
  assert.deepEqual(second.removed, [entry.id]);
  assert.equal(existsSync(entry.path), false);
  assert.equal(git(repo, 'rev-parse', 'place'), tip);
  assert.equal(git(repo, 'for-each-ref', 'refs/mixdog/'), '');
});

test('a detached HEAD keeps the recorded branch', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  commitFile(entry.path, 'work.txt', 'work\n');
  git(entry.path, 'switch', '-q', '--detach');
  const [row] = await listManagedWorktrees();
  assert.equal(row.branch, entry.branch);
  await assert.rejects(removeManagedWorktree({ entryId: entry.id }), unmergedOn(entry.branch));
});

const branchExists = (repo, name) => git(repo, 'branch', '--list', name) !== '';
const recoveryRef = (entry, commit) => `refs/mixdog/recovered/${entry.id}/${commit}`;

/** Remove the clean, merged worktree: `gone` are deleted, `kept` stay where they were. */
async function removeDeleting(repo, entry, { gone = [], kept = [] }) {
  const before = kept.map((name) => git(repo, 'rev-parse', name));
  const result = await removeManagedWorktree({ entryId: entry.id });
  assert.deepEqual(result, { removed: true, ...(gone.length ? { branchDeleted: true } : {}) });
  assert.equal(existsSync(entry.path), false);
  for (const name of gone) assert.equal(branchExists(repo, name), false, `${name} is deleted`);
  assert.deepEqual(
    kept.map((name) => git(repo, 'rev-parse', name)),
    before,
    'every other branch stays where it was'
  );
}

test('removal deletes the merged branch Mixdog created, by its recorded name only', async (t) => {
  await t.test('as made', async () => {
    const repo = makeRepo();
    const { entry } = await create(repo);
    await removeDeleting(repo, entry, { gone: [entry.branch] });
  });
  await t.test('renamed: the recorded name is gone, the renamed branch stays', async () => {
    const repo = makeRepo();
    const { entry } = await create(repo);
    git(entry.path, 'branch', '-m', 'place');
    await removeDeleting(repo, entry, { kept: ['place'] });
  });
  await t.test('copied, the copy checked out: the merged original goes, the copy stays', async () => {
    const repo = makeRepo();
    const { entry } = await create(repo);
    git(entry.path, 'branch', '-c', entry.branch, 'user-copy');
    git(entry.path, 'switch', '-q', 'user-copy');
    await removeDeleting(repo, entry, { gone: [entry.branch], kept: ['user-copy'] });
  });
  await t.test('copied, then the original deleted: the copy stays', async () => {
    const repo = makeRepo();
    const { entry } = await create(repo);
    git(entry.path, 'branch', '-c', entry.branch, 'user-copy');
    git(entry.path, 'switch', '-q', 'user-copy');
    git(repo, 'branch', '-D', entry.branch);
    await removeDeleting(repo, entry, { kept: ['user-copy'] });
  });
  await t.test('a merged user branch renamed onto the recorded name goes (the name decides)', async () => {
    const repo = makeRepo();
    git(repo, 'branch', 'user-owned');
    const { entry } = await create(repo);
    git(entry.path, 'switch', '-q', 'user-owned');
    git(repo, 'branch', '-D', entry.branch);
    git(entry.path, 'branch', '-m', entry.branch);
    await removeDeleting(repo, entry, { gone: [entry.branch] });
  });
  await t.test('switched to a new branch: the merged original goes, the new one stays', async () => {
    const repo = makeRepo();
    const { entry } = await create(repo);
    git(entry.path, 'switch', '-q', '-c', 'side');
    assert.equal((await listManagedWorktrees())[0].branch, 'side');
    await removeDeleting(repo, entry, { gone: [entry.branch], kept: ['side'] });
  });
  await t.test('detached', async () => {
    const repo = makeRepo();
    const { entry } = await create(repo);
    git(entry.path, 'switch', '-q', '--detach');
    await removeDeleting(repo, entry, { gone: [entry.branch] });
  });
  await t.test('opened on an existing branch (existingBranch): it stays', async () => {
    const repo = makeRepo();
    git(repo, 'branch', 'user-feature');
    const { entry } = await create(repo, { branch: 'user-feature', existingBranch: true });
    await removeDeleting(repo, entry, { kept: ['user-feature'] });
  });
  await t.test('checked out in another worktree: it stays', async () => {
    const repo = makeRepo();
    const { entry } = await create(repo);
    git(entry.path, 'switch', '-q', '--detach');
    const other = tempDir('mixdog-wt-other-');
    git(repo, 'worktree', 'add', '-q', other, entry.branch);
    await removeDeleting(repo, entry, { kept: [entry.branch] });
  });
});

test('a squash-merged branch goes after git proves its changes are in the target; its tip stays reachable', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  const tip = commitFile(entry.path, 'work.txt', 'work\n');
  git(repo, 'merge', '-q', '--squash', entry.branch);
  git(repo, 'commit', '-q', '-m', 'squash');
  assert.deepEqual(await removeManagedWorktree({ entryId: entry.id }), {
    removed: true,
    branchDeleted: true,
    recoveryRefs: [recoveryRef(entry, tip)],
  });
  assert.equal(branchExists(repo, entry.branch), false);
  assert.equal(git(repo, 'rev-parse', recoveryRef(entry, tip)), tip);
});

test('a reused worktree id adds its recovery ref beside the earlier one, never over it', async () => {
  const repo = makeRepo();
  const first = (await create(repo)).entry;
  const tip = commitFile(first.path, 'work.txt', 'work\n');
  git(repo, 'merge', '-q', '--squash', first.branch);
  git(repo, 'commit', '-q', '-m', 'squash');
  const [firstRef] = (await removeManagedWorktree({ entryId: first.id })).recoveryRefs ?? [];
  const again = (await create(repo)).entry;
  assert.equal(again.id, first.id, 'the freed id is reused');
  git(again.path, 'switch', '-q', '--detach');
  const head = commitFile(again.path, 'detached.txt', 'detached\n');
  const [againRef] = (await removeManagedWorktree({ entryId: again.id, force: true })).recoveryRefs ?? [];
  assert.notEqual(firstRef, againRef);
  const keeping = (commit) => git(repo, 'for-each-ref', '--format=%(refname)', '--contains', commit, 'refs/mixdog/');
  assert.equal(keeping(tip), recoveryRef(first, tip), 'the first recovered commit stays reachable');
  assert.equal(keeping(head), recoveryRef(again, head));
});

test('a shipped plain refs/mixdog/removed/<id> stays as it is while a new recovery ref for the same id is kept', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  const shipped = git(repo, 'commit-tree', '-m', 'kept by a shipped build', 'HEAD^{tree}');
  git(repo, 'update-ref', `refs/mixdog/removed/${entry.id}`, shipped);
  git(entry.path, 'switch', '-q', '--detach');
  const head = commitFile(entry.path, 'detached.txt', 'detached\n');
  assert.deepEqual((await removeManagedWorktree({ entryId: entry.id, force: true })).recoveryRefs, [
    recoveryRef(entry, head),
  ]);
  assert.deepEqual(git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/mixdog/').split('\n'), [
    `${recoveryRef(entry, head)} ${head}`,
    `refs/mixdog/removed/${entry.id} ${shipped}`,
  ]);
});

test('a squash-merged branch deleted away from a detached HEAD keeps its tip under the recovery ref', async () => {
  const repo = makeRepo();
  git(repo, 'branch', 'user-owned');
  const { entry } = await create(repo);
  git(entry.path, 'switch', '-q', 'user-owned');
  git(repo, 'branch', '-D', entry.branch);
  git(entry.path, 'branch', '-m', entry.branch);
  const tip = commitFile(entry.path, 'work.txt', 'work\n');
  git(entry.path, 'switch', '-q', '--detach', 'main');
  git(repo, 'merge', '-q', '--squash', entry.branch);
  git(repo, 'commit', '-q', '-m', 'squash');
  assert.deepEqual(await removeManagedWorktree({ entryId: entry.id }), {
    removed: true,
    branchDeleted: true,
    recoveryRefs: [recoveryRef(entry, tip)],
  });
  assert.equal(branchExists(repo, entry.branch), false);
  assert.equal(git(repo, 'rev-parse', recoveryRef(entry, tip)), tip);
});

test('forced past detached work while the squash-merged branch goes: HEAD and the tip each keep a ref', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  const tip = commitFile(entry.path, 'work.txt', 'work\n');
  git(repo, 'merge', '-q', '--squash', entry.branch);
  git(repo, 'commit', '-q', '-m', 'squash');
  git(entry.path, 'switch', '-q', '--detach', `${tip}~1`);
  const head = commitFile(entry.path, 'detached.txt', 'detached\n');
  assert.deepEqual(await removeManagedWorktree({ entryId: entry.id, force: true }), {
    removed: true,
    branchDeleted: true,
    recoveryRefs: [recoveryRef(entry, head), recoveryRef(entry, tip)],
  });
  assert.equal(git(repo, 'rev-parse', recoveryRef(entry, head)), head);
  assert.equal(git(repo, 'rev-parse', recoveryRef(entry, tip)), tip);
});

test('a record without the existingBranch flag keeps its merged branch and reports it kept', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  const { existingBranch, ...old } = await getRecord(entry.id);
  assert.equal(existingBranch, false, 'a creation records the flag explicitly');
  await putRecord(old);
  const head = git(repo, 'rev-parse', entry.branch);
  assert.deepEqual(await removeManagedWorktree({ entryId: entry.id }), {
    removed: true,
    preservedBranch: { name: entry.branch, head },
  });
  assert.equal(git(repo, 'rev-parse', entry.branch), head);
});

test('the head-guarded force delete refuses a branch that moved or is checked out', async () => {
  const repo = makeRepo();
  git(repo, 'branch', 'kept');
  const seen = git(repo, 'rev-parse', 'kept');
  git(repo, 'switch', '-q', 'kept');
  const moved = commitFile(repo, 'later.txt', 'later\n');
  await assert.rejects(forceDeleteBranch(repo, 'kept', moved), { code: 'WORKTREE_BRANCH_OCCUPIED' });
  git(repo, 'switch', '-q', 'main');
  await assert.rejects(forceDeleteBranch(repo, 'kept', seen), { code: 'WORKTREE_REVISION_CONFLICT' });
  assert.equal(git(repo, 'rev-parse', 'kept'), moved);
  await forceDeleteBranch(repo, 'kept', moved);
  assert.equal(branchExists(repo, 'kept'), false);
});

test('rename, detach and commit: the detached work refuses removal; forced, it stays under the recovery ref', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  git(entry.path, 'branch', '-m', 'place');
  const placeTip = git(entry.path, 'rev-parse', 'HEAD');
  git(entry.path, 'switch', '-q', '--detach');
  commitFile(entry.path, 'detached.txt', 'detached\n');
  const head = git(entry.path, 'rev-parse', 'HEAD');
  await assert.rejects(removeManagedWorktree({ entryId: entry.id }), (error) => error.code === 'WORKTREE_UNMERGED');
  assert.ok(existsSync(entry.path));
  const removed = await removeManagedWorktree({ entryId: entry.id, force: true });
  assert.deepEqual(removed, { removed: true, recoveryRefs: [recoveryRef(entry, head)] });
  assert.equal(git(repo, 'rev-parse', recoveryRef(entry, head)), head);
  assert.equal(git(repo, 'rev-parse', 'place'), placeTip);
});

test('forced past unmerged commits: the branch is kept and reported with its head, no recovery ref written', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  const tip = commitFile(entry.path, 'work.txt', 'work\n');
  await assert.rejects(removeManagedWorktree({ entryId: entry.id }), unmergedOn(entry.branch));
  assert.deepEqual(await removeManagedWorktree({ entryId: entry.id, force: true }), {
    removed: true,
    preservedBranch: { name: entry.branch, head: tip },
  });
  assert.equal(git(repo, 'rev-parse', entry.branch), tip);
  assert.equal(git(repo, 'for-each-ref', 'refs/mixdog/'), '');
});
