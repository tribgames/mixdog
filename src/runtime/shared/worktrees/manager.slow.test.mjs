import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { managedWorktreeRoot, repoHash } from './contract.mjs';
import {
  assertWorktreeRemovable,
  checkoutProjectBranch,
  claimWorktreeOwner,
  configureWorktreeManager,
  createManagedWorktree,
  getSessionWorktree,
  getWorktreeByPath,
  listBranchOccupancy,
  mergeWorktreeIntoProject,
  releaseWorktreeOwner,
  removeManagedWorktree,
} from './manager.mjs';
import { readOwnerLease } from './owner.mjs';
import { canonicalPath, samePath } from './paths.mjs';
import { getRecord, readRegistry, registryPath } from './registry.mjs';
import {
  cleanupTempDirs,
  commitFile,
  createTestWorktree,
  git,
  makeRepo,
  nextIds,
  prefixedBranches,
  tempDir,
  useTempDataDir,
  writeFile,
  writeHook,
} from './test-support.mjs';

// Creation, includes, occupancy, checkout and merge; removal and reconcile
// are manager-removal.slow.test.mjs (split to stay well inside one file's
// timeout under every documented runner).
let restore = () => {};

beforeEach(() => {
  useTempDataDir();
  restore = configureWorktreeManager({ settings: {}, freeBytes: async () => Number.MAX_SAFE_INTEGER });
});

afterEach(() => restore());
after(() => cleanupTempDirs());

const ids = nextIds;
const create = createTestWorktree;

test('creation makes a locked, owned worktree on a new prefixed branch from the current branch', async () => {
  const repo = makeRepo();
  const head = git(repo, 'rev-parse', 'HEAD');
  const { entry, sessionId, runtimeToken } = await create(repo);
  const commonDir = canonicalPath(join(repo, '.git'));

  assert.equal(entry.id, 'fix-the-login-page');
  assert.equal(entry.branch, 'mixdog/fix-the-login-page');
  assert.equal(entry.state, 'ready');
  assert.equal(entry.baseCommit, head);
  assert.equal(entry.mergeTarget, 'main');
  assert.equal(entry.ownerSessionId, sessionId);
  assert.ok(samePath(entry.repoCommonDir, commonDir));
  assert.ok(samePath(entry.path, join(managedWorktreeRoot(commonDir), entry.id)));
  assert.ok(entry.path.includes(join('worktrees-v1', repoHash(commonDir))));
  assert.equal(readFileSync(join(entry.path, 'README.md'), 'utf8'), 'hello\n');
  assert.equal(git(entry.path, 'symbolic-ref', '--short', 'HEAD'), entry.branch);

  const listing = git(repo, 'worktree', 'list', '--porcelain');
  assert.match(listing, new RegExp(`locked mixdog session=${sessionId}`));
  const lease = await readOwnerLease(entry);
  assert.equal(lease.sessionId, sessionId);
  assert.equal(lease.runtimeToken, runtimeToken);

  // `prepared` is the creation's one-off report for the first turn; the registry keeps the rest.
  const { prepared: _prepared, ...stored } = entry;
  assert.deepEqual(await getSessionWorktree(sessionId), stored);
  assert.equal(await getSessionWorktree('nobody'), null);
  // Path lookup is canonical: trailing separators, `..` segments and (on
  // Windows) other casing all find the entry.
  assert.equal((await getWorktreeByPath(`${entry.path}${process.platform === 'win32' ? '\\' : '/'}`))?.id, entry.id);
  assert.equal((await getWorktreeByPath(join(entry.path, 'sub', '..')))?.id, entry.id);
  if (process.platform === 'win32') assert.equal((await getWorktreeByPath(entry.path.toUpperCase()))?.id, entry.id);
  assert.equal(await getWorktreeByPath(repo), null);
  assert.equal(await getWorktreeByPath(''), null);
});

test('a retried transaction or a second request of the session returns the same worktree', async () => {
  const repo = makeRepo();
  const first = await create(repo);
  const retry = await createManagedWorktree({
    projectPath: repo,
    sessionId: first.sessionId,
    runtimeToken: first.runtimeToken,
    txId: first.txId,
    nameHint: 'something else',
  });
  const { prepared: _prepared, ...stored } = first.entry;
  assert.deepEqual(retry, stored);
  const again = await createManagedWorktree({
    projectPath: repo,
    sessionId: first.sessionId,
    runtimeToken: 'restarted-runtime',
    txId: 'another-tx',
    nameHint: 'something else',
  });
  assert.equal(again.id, first.entry.id);
  assert.deepEqual(prefixedBranches(repo), [first.entry.branch]);
  assert.equal((await readOwnerLease(again)).runtimeToken, 'restarted-runtime');

  // Concurrent duplicate sends serialize on the repository lock.
  const repo2 = makeRepo();
  const id = ids();
  const [a, b] = await Promise.all([
    createManagedWorktree({ projectPath: repo2, nameHint: 'dup', ...id }),
    createManagedWorktree({ projectPath: repo2, nameHint: 'dup', ...id }),
  ]);
  // Only the request that created it carries the one-off `prepared` report.
  const withoutReport = ({ prepared: _prepared, ...rest }) => rest;
  assert.deepEqual(withoutReport(a), withoutReport(b));
  assert.equal([a, b].filter((entry) => entry.prepared).length, 1);
  assert.deepEqual(prefixedBranches(repo2), ['mixdog/dup']);
});

test('slugs avoid existing branches and stay Windows-safe; pre-existing branches are untouched', async () => {
  const repo = makeRepo();
  git(repo, 'branch', 'mixdog/fix-the-login-page');
  const before = git(repo, 'rev-parse', 'mixdog/fix-the-login-page');
  const { entry } = await create(repo);
  assert.equal(entry.id, 'fix-the-login-page-2');
  const second = await create(repo, { nameHint: 'CON' });
  assert.equal(second.entry.id, 'con-task');
  const third = await create(repo, { nameHint: '로그인 고치기' });
  assert.equal(third.entry.id, 'task');
  await removeManagedWorktree({ entryId: entry.id });
  assert.equal(git(repo, 'rev-parse', 'mixdog/fix-the-login-page'), before);
});

test('a failed creation rolls back exactly what it made', async () => {
  const repo = makeRepo();
  git(repo, 'branch', 'keep-me');
  writeHook(repo, 'post-checkout', '#!/bin/sh\nexit 1\n');
  const id = ids();
  await assert.rejects(createManagedWorktree({ projectPath: repo, nameHint: 'boom', ...id }), /post-checkout|failed/i);
  assert.deepEqual(prefixedBranches(repo), []);
  assert.equal(git(repo, 'branch', '--list', 'keep-me'), 'keep-me');
  assert.deepEqual((await readRegistry()).entries, {});
  const commonDir = canonicalPath(join(repo, '.git'));
  assert.equal(existsSync(join(managedWorktreeRoot(commonDir), 'boom')), false);
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  assert.equal(await getSessionWorktree(id.sessionId), null);
});

test('unsupported repositories, disk shortage and large repositories fail before allocation', async () => {
  const empty = makeRepo({ commit: false });
  await assert.rejects(create(empty), { code: 'WORKTREE_UNSUPPORTED_REPO' });
  const bare = tempDir('mixdog-wt-bare-');
  git(bare, 'init', '-q', '--bare');
  await assert.rejects(create(bare), { code: 'WORKTREE_UNSUPPORTED_REPO' });
  await assert.rejects(create(tempDir('mixdog-wt-plain-')), { code: 'WORKTREE_UNSUPPORTED_REPO' });

  const repo = makeRepo();
  commitFile(repo, 'big.bin', 'x'.repeat(4096));
  configureWorktreeManager({ freeBytes: async () => 1024 });
  await assert.rejects(create(repo), (error) => {
    assert.equal(error.code, 'WORKTREE_DISK_INSUFFICIENT');
    assert.ok(error.details.requiredBytes > error.details.freeBytes);
    return true;
  });
  configureWorktreeManager({ freeBytes: async () => Number.MAX_SAFE_INTEGER, settings: { sizeWarnBytes: 1000 } });
  await assert.rejects(create(repo), (error) => {
    assert.equal(error.code, 'WORKTREE_LARGE_REPO_CONFIRM');
    assert.ok(error.details.estimateBytes > 4096);
    assert.equal(error.details.thresholdBytes, 1000);
    return true;
  });
  assert.deepEqual((await readRegistry()).entries, {});
  assert.deepEqual(prefixedBranches(repo), []);
  const { entry } = await create(repo, { confirmLarge: true });
  assert.equal(entry.state, 'ready');
});

test('submodules are allowed with a warning flag', async () => {
  const repo = makeRepo();
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${head},vendor/lib`);
  git(repo, 'commit', '-q', '-m', 'add gitlink');
  const { entry } = await create(repo);
  assert.ok(entry.warnings.includes('submodules'));
});

test('branch occupancy distinguishes current, session, external and free branches', async () => {
  const repo = makeRepo();
  git(repo, 'branch', 'idle');
  git(repo, 'branch', 'elsewhere');
  const external = join(tempDir('mixdog-wt-ext-'), 'checkout');
  git(repo, 'worktree', 'add', '-q', external, 'elsewhere');
  const { entry, sessionId } = await create(repo);

  const result = await listBranchOccupancy({ projectPath: repo, sessionId });
  const byBranch = Object.fromEntries(result.occupancy.map((item) => [item.branch, item]));
  assert.equal(byBranch.main.kind, 'current');
  assert.equal(byBranch.idle.kind, 'free');
  assert.equal(byBranch.elsewhere.kind, 'external');
  assert.ok(samePath(byBranch.elsewhere.path, external));
  assert.equal(byBranch[entry.branch].kind, 'session');
  assert.equal(byBranch[entry.branch].sessionId, sessionId);
  assert.deepEqual(result.branches.sort(), ['elsewhere', 'idle', 'main', entry.branch].sort());
  assert.equal(result.retainedWorktree?.id, entry.id);
  assert.equal((await listBranchOccupancy({ projectPath: repo, sessionId: 'other' })).retainedWorktree, null);

  await assert.rejects(checkoutProjectBranch({ projectPath: repo, branch: 'elsewhere' }), (error) => {
    assert.equal(error.code, 'WORKTREE_BRANCH_OCCUPIED');
    assert.equal(error.details.kind, 'external');
    return true;
  });
  await assert.rejects(checkoutProjectBranch({ projectPath: repo, branch: entry.branch }), (error) => {
    assert.equal(error.code, 'WORKTREE_BRANCH_OCCUPIED');
    assert.equal(error.details.sessionId, sessionId);
    return true;
  });
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal((await checkoutProjectBranch({ projectPath: repo, branch: 'idle' })).changed, true);
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'idle');
  await checkoutProjectBranch({ projectPath: repo, branch: 'fresh', create: true });
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'fresh');
  assert.equal((await checkoutProjectBranch({ projectPath: repo, branch: 'fresh' })).changed, false);
});

test('a project-folder checkout never carries uncommitted changes to the other branch', async () => {
  const repo = makeRepo();
  // Identical tracked content on both branches: `git switch` alone would
  // succeed and silently carry the modification over.
  git(repo, 'branch', 'twin');
  writeFile(repo, 'README.md', 'edited\n');
  for (const input of [
    { projectPath: repo, branch: 'twin' },
    { projectPath: repo, branch: 'brand-new', create: true },
  ]) {
    await assert.rejects(checkoutProjectBranch(input), (error) => {
      assert.equal(error.code, 'WORKTREE_DIRTY');
      assert.equal(error.details.reason, 'project-dirty');
      assert.deepEqual(error.details.files, ['README.md']);
      return true;
    });
  }
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(repo, 'branch', '--list', 'brand-new'), '');
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'edited\n', 'the change stays where it was made');
  // Staying on the checked-out branch is not a switch.
  assert.equal((await checkoutProjectBranch({ projectPath: repo, branch: 'main' })).changed, false);
  git(repo, 'checkout', '-q', '--', 'README.md');
  assert.equal((await checkoutProjectBranch({ projectPath: repo, branch: 'twin' })).changed, true);
});

test('a remote branch checks out its local branch, created to track the remote branch when missing', async () => {
  const repo = makeRepo();
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'remote', 'add', 'origin', tempDir('mixdog-wt-origin-'));
  git(repo, 'update-ref', 'refs/remotes/origin/review', head);
  const created = await checkoutProjectBranch({ projectPath: repo, branch: 'origin/review', remote: true });
  assert.equal(created.branch, 'review');
  assert.equal(created.changed, true);
  assert.equal(created.tracking, 'origin/review');
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'review');
  assert.equal(git(repo, 'config', 'branch.review.remote'), 'origin');
  assert.equal(git(repo, 'config', 'branch.review.merge'), 'refs/heads/review');
  // The local branch exists now: a second remote checkout just switches to it.
  await checkoutProjectBranch({ projectPath: repo, branch: 'main' });
  const again = await checkoutProjectBranch({ projectPath: repo, branch: 'origin/review', remote: true });
  assert.deepEqual([again.branch, again.changed, again.tracking], ['review', true, undefined]);
  await assert.rejects(
    checkoutProjectBranch({ projectPath: repo, branch: 'origin/missing', remote: true }),
    /does not exist/
  );
  // The same no-carry rule applies.
  await checkoutProjectBranch({ projectPath: repo, branch: 'main' });
  writeFile(repo, 'README.md', 'edited\n');
  await assert.rejects(checkoutProjectBranch({ projectPath: repo, branch: 'origin/review', remote: true }), {
    code: 'WORKTREE_DIRTY',
  });
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('assertWorktreeRemovable reports the refusal removal would raise, without changing anything', async () => {
  const repo = makeRepo();
  const { entry } = await create(repo);
  await assertWorktreeRemovable({ entryId: entry.id });
  writeFile(entry.path, 'scratch.txt', 'wip\n');
  await assert.rejects(assertWorktreeRemovable({ entryId: entry.id }), { code: 'WORKTREE_DIRTY' });
  await assertWorktreeRemovable({ entryId: entry.id, force: true });
  await assert.rejects(assertWorktreeRemovable({ entryId: 'nope' }), { code: 'WORKTREE_MISSING' });
  assert.equal((await getRecord(entry.id)).state, 'ready');
  assert.ok(existsSync(join(entry.path, 'scratch.txt')));
});

test('.worktreeinclude copies and links into the checkout and removal unlinks without touching targets', async () => {
  const repo = makeRepo();
  writeFile(repo, '.gitignore', '.env\ncache/\nshared/\n');
  writeFile(repo, 'tracked.txt', 'tracked\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'files');
  writeFile(repo, '.env', 'SECRET=1\n');
  writeFile(repo, 'cache/data.txt', 'cached\n');
  writeFile(repo, 'shared/big.txt', 'shared\n');
  writeFile(
    repo,
    '.worktreeinclude',
    '# local files\ncopy .env\ncopy cache\nlink shared\ncopy tracked.txt\ncopy absent.txt\n'
  );

  const { entry } = await create(repo);
  assert.equal(readFileSync(join(entry.path, '.env'), 'utf8'), 'SECRET=1\n');
  assert.equal(readFileSync(join(entry.path, 'cache', 'data.txt'), 'utf8'), 'cached\n');
  assert.equal(readFileSync(join(entry.path, 'shared', 'big.txt'), 'utf8'), 'shared\n');
  assert.ok(entry.warnings.includes('include-exists:tracked.txt'));
  assert.ok(entry.warnings.includes('include-missing:absent.txt'));
  assert.equal(readFileSync(join(entry.path, 'tracked.txt'), 'utf8'), 'tracked\n');

  // An unchanged copy is not data loss; a modified one is.
  writeFileSync(join(entry.path, '.env'), 'SECRET=changed-in-worktree\n');
  await assert.rejects(removeManagedWorktree({ entryId: entry.id }), (error) => {
    assert.equal(error.code, 'WORKTREE_DIRTY');
    assert.deepEqual(error.details.files, ['.env']);
    return true;
  });
  const result = await removeManagedWorktree({ entryId: entry.id, force: true });
  assert.equal(result.removed, true);
  assert.equal(existsSync(entry.path), false);
  assert.equal(readFileSync(join(repo, 'shared', 'big.txt'), 'utf8'), 'shared\n');
  assert.equal(readFileSync(join(repo, '.env'), 'utf8'), 'SECRET=1\n');
});

test('.worktreeinclude skips unsafe entries with a warning: creation goes on, nothing is copied or linked', async () => {
  const outside = tempDir('mixdog-wt-outside-');
  writeFile(outside, 'secret.txt', 'outside\n');
  for (const [content, warning, target] of [
    ['copy /etc/passwd\n', 'include-invalid:1', 'etc'],
    ['copy C:\\Windows\n', 'include-invalid:1', 'Windows'],
    ['copy ../x\n', 'include-invalid:1', 'x'],
    ['link .git/config\n', 'include-invalid:1', 'config'],
    ['copy escape\n', 'include-skipped:escape', 'escape'],
    ['copy Game/Library\n', 'include-skipped:Game/Library', 'Game/Library'],
    ['link Game\n', 'include-skipped:Game', 'Game/Library'],
  ]) {
    const repo = makeRepo();
    symlinkSync(outside, join(repo, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFile(repo, 'Game/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3\n');
    writeFile(repo, 'Game/Library/huge.bin', 'cache');
    writeFile(repo, '.worktreeinclude', content);
    const { entry } = await create(repo);
    assert.equal(entry.state, 'ready', content);
    assert.ok(entry.warnings.includes(warning), `${content}: ${entry.warnings}`);
    assert.equal(existsSync(join(entry.path, ...target.split('/'))), false, content);
    assert.equal(entry.path.includes(outside), false);
    await removeManagedWorktree({ entryId: entry.id, force: true });
  }
  assert.deepEqual((await readRegistry()).entries, {});

  // Copying a Unity project folder skips its Library.
  const repo = makeRepo();
  writeFile(repo, 'Game/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3\n');
  writeFile(repo, 'Game/Assets/a.txt', 'asset\n');
  writeFile(repo, 'Game/Library/huge.bin', 'cache');
  writeFile(repo, '.worktreeinclude', 'copy Game\n');
  const { entry } = await create(repo);
  assert.equal(readFileSync(join(entry.path, 'Game', 'Assets', 'a.txt'), 'utf8'), 'asset\n');
  assert.equal(existsSync(join(entry.path, 'Game', 'Library')), false);
});

test('owner leases compare the exact owner, not the pid', async () => {
  const repo = makeRepo();
  const { entry, sessionId, runtimeToken } = await create(repo);
  assert.deepEqual(await releaseWorktreeOwner(entry.id, { sessionId, runtimeToken: 'stale', pid: process.pid }), {
    released: false,
  });
  assert.ok(await readOwnerLease(entry));
  const claimed = await claimWorktreeOwner(entry.id, { sessionId, runtimeToken: 'next', pid: 1 });
  assert.equal(claimed.lease.runtimeToken, 'next');
  assert.equal(claimed.replaced.runtimeToken, runtimeToken);
  assert.deepEqual(await releaseWorktreeOwner(entry.id, { sessionId, runtimeToken, pid: process.pid }), {
    released: false,
  });
  assert.deepEqual(await releaseWorktreeOwner(entry.id, { sessionId, runtimeToken: 'next', pid: 999 }), {
    released: true,
  });
  assert.equal(await readOwnerLease(entry), null);
  // Durable ownership survives the lease.
  assert.equal((await getSessionWorktree(sessionId)).id, entry.id);
  const shared = await claimWorktreeOwner(entry.id, { sessionId: 'peer', runtimeToken: 'x', pid: null });
  assert.equal(shared.entry.id, entry.id);
  assert.equal(shared.lease.sessionId, 'peer');
  assert.equal(await readOwnerLease(entry), null, 'a peer does not replace the creator lease');
  assert.deepEqual(await releaseWorktreeOwner(entry.id, { sessionId: 'peer', runtimeToken: 'stale' }), {
    released: false,
  });
  assert.deepEqual(await releaseWorktreeOwner(entry.id, { sessionId: 'peer', runtimeToken: 'x' }), {
    released: true,
  });
});

test('merge into the project folder: clean, conflict, dirty target and target mismatch', async () => {
  const repo = makeRepo();
  commitFile(repo, 'shared.txt', 'base\n');
  const { entry } = await create(repo);
  commitFile(entry.path, 'feature.txt', 'feature\n');
  const tip = git(entry.path, 'rev-parse', 'HEAD');

  await assert.rejects(mergeWorktreeIntoProject({ entryId: entry.id, target: 'main', confirmed: false }), {
    code: 'WORKTREE_CONFIRM_REQUIRED',
  });
  await assert.rejects(mergeWorktreeIntoProject({ entryId: entry.id, target: 'develop', confirmed: true }), {
    code: 'WORKTREE_TARGET_MISMATCH',
  });
  writeFileSync(join(repo, 'stray.txt'), 'untracked\n');
  await assert.rejects(mergeWorktreeIntoProject({ entryId: entry.id, target: 'main', confirmed: true }), {
    code: 'MERGE_TARGET_DIRTY',
  });
  git(repo, 'clean', '-fq');

  const merged = await mergeWorktreeIntoProject({ entryId: entry.id, target: 'main', confirmed: true });
  assert.equal(merged.merged, true);
  assert.equal(merged.commit, git(repo, 'rev-parse', 'HEAD'));
  assert.equal(git(repo, 'rev-parse', 'HEAD^2'), tip);
  assert.equal(readFileSync(join(repo, 'feature.txt'), 'utf8'), 'feature\n');
  assert.equal((await mergeWorktreeIntoProject({ entryId: entry.id, target: 'main', confirmed: true })).upToDate, true);

  commitFile(entry.path, 'shared.txt', 'worktree\n');
  commitFile(repo, 'shared.txt', 'project\n');
  const head = git(repo, 'rev-parse', 'HEAD');
  const conflict = await mergeWorktreeIntoProject({ entryId: entry.id, target: 'main', confirmed: true });
  assert.deepEqual(conflict, { merged: false, commit: null, target: 'main', conflicts: ['shared.txt'] });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(repo, '.git', 'MERGE_HEAD')), false);

  // The caller's guarded destination must be the record's own project folder.
  await assert.rejects(
    mergeWorktreeIntoProject({ entryId: entry.id, target: 'main', confirmed: true, projectPath: makeRepo() }),
    { code: 'WORKTREE_PROJECT_MISMATCH' }
  );
});

test('a claude-code style .worktreeinclude (bare patterns) creates and copies ignored local files', async () => {
  const repo = makeRepo();
  writeFile(repo, '.gitignore', '.env*\nnode_modules/\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'ignore');
  writeFile(repo, '.env.local', 'SECRET=1\n');
  writeFile(repo, '.env.example', 'SECRET=\n');
  writeFile(repo, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
  writeFile(repo, '.worktreeinclude', '# from another tool\n.env*\n!.env.example\nnot a [valid\n');
  const { entry } = await create(repo);
  assert.equal(entry.state, 'ready');
  assert.equal(readFileSync(join(entry.path, '.env.local'), 'utf8'), 'SECRET=1\n');
  assert.equal(existsSync(join(entry.path, '.env.example')), false);
  assert.equal(existsSync(join(entry.path, 'node_modules')), false, 'only what a pattern names');
  // A copied, unchanged ignored file is not dirt.
  assert.equal((await removeManagedWorktree({ entryId: entry.id })).removed, true);
});

test('a full disk during worktree add is WORKTREE_DISK_INSUFFICIENT and rolls back even when the registry cannot be written', async () => {
  const repo = makeRepo();
  const registry = registryPath().replace(/\\/g, '/');
  // The hook runs inside `git worktree add`: it breaks the registry (a directory
  // where the file was) and fails the way a full disk does.
  writeHook(
    repo,
    'post-checkout',
    `#!/bin/sh\nrm -f '${registry}'\nmkdir -p '${registry}'\necho 'fatal: No space left on device' >&2\nexit 1\n`
  );
  await assert.rejects(create(repo, { nameHint: 'full' }), (error) => {
    assert.equal(error.code, 'WORKTREE_DISK_INSUFFICIENT');
    assert.equal(typeof error.details.requiredBytes, 'number');
    assert.match(error.details.reason, /No space left on device/);
    return true;
  });
  const root = managedWorktreeRoot(canonicalPath(join(repo, '.git')));
  assert.equal(existsSync(join(root, 'full')), false, 'the checkout is gone');
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  assert.deepEqual(prefixedBranches(repo), []);
});

test('a branch opened at a history commit goes through the guarded checkout', async () => {
  const repo = makeRepo();
  const base = commitFile(repo, 'history.txt', 'base\n');
  const later = commitFile(repo, 'history.txt', 'later\n');
  const created = await checkoutProjectBranch({
    projectPath: repo,
    branch: 'from-history',
    create: true,
    startPoint: base,
  });
  assert.deepEqual(created, { branch: 'from-history', changed: true, commit: base });
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'from-history');
  git(repo, 'switch', '-q', 'main');

  // A branch spelled like the commit's short id never shadows the commit.
  const shadow = base.slice(0, 7);
  git(repo, 'branch', shadow, later);
  await checkoutProjectBranch({ projectPath: repo, branch: 'from-shadow', create: true, startPoint: shadow });
  assert.equal(git(repo, 'rev-parse', 'refs/heads/from-shadow'), base);
  git(repo, 'switch', '-q', 'main');

  // Same guards as any checkout: uncommitted tracked work refuses, nothing moves.
  writeFileSync(join(repo, 'history.txt'), 'local work\n');
  await assert.rejects(
    checkoutProjectBranch({ projectPath: repo, branch: 'dirty-try', create: true, startPoint: base }),
    (error) => error.code === 'WORKTREE_DIRTY' && error.details.reason === 'project-dirty'
  );
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(repo, 'branch', '--list', 'dirty-try'), '');
  git(repo, 'checkout', '-q', '--', 'history.txt');

  for (const startPoint of ['--force', 'main', 'abcdef1234567']) {
    await assert.rejects(
      checkoutProjectBranch({ projectPath: repo, branch: 'later-try', create: true, startPoint }),
      TypeError,
      startPoint
    );
  }
  await assert.rejects(checkoutProjectBranch({ projectPath: repo, branch: 'main', startPoint: base }), TypeError);
  await assert.rejects(
    checkoutProjectBranch({ projectPath: repo, branch: 'bad name', create: true, startPoint: base }),
    TypeError
  );
  assert.equal(git(repo, 'branch', '--list', 'later-try'), '');
});

test('a history commit checked out detached goes through the guarded checkout', async () => {
  const repo = makeRepo();
  const base = commitFile(repo, 'history.txt', 'base\n');
  const later = commitFile(repo, 'history.txt', 'later\n');
  assert.deepEqual(await checkoutProjectBranch({ projectPath: repo, detach: base }), {
    branch: null,
    changed: true,
    commit: base,
    detached: true,
  });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), base);
  assert.throws(() => git(repo, 'symbolic-ref', '-q', 'HEAD'), 'HEAD is detached');
  assert.equal(readFileSync(join(repo, 'history.txt'), 'utf8'), 'base\n');
  assert.equal((await checkoutProjectBranch({ projectPath: repo, detach: base })).changed, false);
  git(repo, 'switch', '-q', 'main');

  // A branch spelled like the commit's short id never shadows the commit.
  const shadow = base.slice(0, 7);
  git(repo, 'branch', shadow, later);
  assert.equal((await checkoutProjectBranch({ projectPath: repo, detach: shadow })).commit, base);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), base);
  git(repo, 'switch', '-q', 'main');

  // Untracked files ride along; uncommitted tracked work refuses and nothing moves.
  writeFileSync(join(repo, 'scratch.txt'), 'local\n');
  await checkoutProjectBranch({ projectPath: repo, detach: base });
  assert.equal(readFileSync(join(repo, 'scratch.txt'), 'utf8'), 'local\n');
  git(repo, 'switch', '-q', 'main');
  writeFileSync(join(repo, 'history.txt'), 'later\nlocal work\n');
  await assert.rejects(
    checkoutProjectBranch({ projectPath: repo, detach: base }),
    (error) => error.code === 'WORKTREE_DIRTY' && error.details.reason === 'project-dirty'
  );
  assert.equal(git(repo, 'rev-parse', 'HEAD'), later);
  assert.equal(readFileSync(join(repo, 'history.txt'), 'utf8'), 'later\nlocal work\n');
  git(repo, 'checkout', '-q', '--', 'history.txt');

  // Object ids only; never an option, a ref name, or a ref-only hex name.
  git(repo, 'branch', 'abcdef1234567', later);
  for (const detach of ['--detach', 'main', 'abcdef1234567']) {
    await assert.rejects(checkoutProjectBranch({ projectPath: repo, detach }), TypeError, detach);
  }
  for (const extra of [{ branch: 'main' }, { create: true }, { remote: true }, { startPoint: base }]) {
    await assert.rejects(checkoutProjectBranch({ projectPath: repo, detach: base, ...extra }), TypeError);
  }
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('a branch name taken after the reservation is retried once with the next free name', async () => {
  const repo = makeRepo();
  // Listed under another name, this ref blocks creating mixdog/fix-the-login-page.
  git(repo, 'branch', 'mixdog/fix-the-login-page/old');
  const { entry } = await create(repo);
  assert.equal(entry.branch, 'mixdog/fix-the-login-page-2');
  assert.ok(existsSync(entry.path));
  assert.equal((await readRegistry()).entries[entry.id].state, 'ready');
  assert.equal(Object.keys((await readRegistry()).entries).length, 1, 'the lost reservation was dropped');
});
