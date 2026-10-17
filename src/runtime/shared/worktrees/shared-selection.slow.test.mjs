import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import {
  resolveBranchWorkspace,
  removeManagedWorktree,
  claimWorktreeOwner,
  releaseWorktreeOwner,
  forgetSharedWorktreeSession,
  reconcileManagedWorktrees,
  createManagedWorktree,
} from './manager.mjs';
import { readRegistry } from './registry.mjs';
import { cleanupTempDirs, git, makeRepo, nextIds, useTempDataDir, writeFile } from './test-support.mjs';

beforeEach(() => useTempDataDir());
after(() => cleanupTempDirs());

test('branch selection creates an exact branch checkout and preserves the dirty shared folder', async () => {
  const projectPath = makeRepo();
  writeFile(projectPath, 'README.md', 'unfinished source work\n');
  const target = await resolveBranchWorkspace({
    projectPath,
    branch: 'feature/login',
    create: true,
    ...nextIds(),
  });
  assert.equal(git(projectPath, 'branch', '--show-current'), 'main');
  assert.equal(readFileSync(join(projectPath, 'README.md'), 'utf8'), 'unfinished source work\n');
  assert.equal(git(target.path, 'branch', '--show-current'), 'feature/login');
  assert.equal(readFileSync(join(target.path, 'README.md'), 'utf8'), 'hello\n');
});

test('retry after checkout creation reuses it, and cancelling a new sharing claim restores its reference', async () => {
  const projectPath = makeRepo();
  const first = nextIds();
  const request = { projectPath, branch: 'feature/retry', create: true, ...first };
  const target = await resolveBranchWorkspace(request);
  const retry = await resolveBranchWorkspace(request);
  assert.equal(retry.path, target.path);
  const peer = nextIds();
  const joined = await resolveBranchWorkspace({ projectPath, branch: request.branch, ...peer });
  assert.equal(joined.referenceAdded, true);
  await releaseWorktreeOwner(target.entry.id, peer, { forgetReference: true });
  const record = (await readRegistry()).entries[target.entry.id];
  assert.deepEqual(record.sharedSessionIds, []);
  assert.equal((await removeManagedWorktree({ entryId: target.entry.id })).removed, true);
});

test('two sessions share one checkout and neither force deletion nor prune removes it', async () => {
  const projectPath = makeRepo();
  const first = nextIds();
  const second = nextIds();
  const target = await resolveBranchWorkspace({ projectPath, branch: 'feature/shared', create: true, ...first });
  const shared = await resolveBranchWorkspace({ projectPath, branch: 'feature/shared', ...second });
  assert.equal(shared.path, target.path);
  assert.equal(Object.keys((await readRegistry()).entries).length, 1);
  await assert.rejects(removeManagedWorktree({ entryId: target.entry.id, force: true }), {
    code: 'WORKTREE_BUSY_JOBS',
  });
  await releaseWorktreeOwner(target.entry.id, second);
  await reconcileManagedWorktrees({ removeOrphans: true });
  assert.ok(existsSync(target.path), 'idle shared session still retains its folder');
  await claimWorktreeOwner(target.entry.id, { ...second, pid: process.pid });
  await assert.rejects(removeManagedWorktree({ entryId: target.entry.id, sessionId: second.sessionId, force: true }), {
    code: 'WORKTREE_BUSY_JOBS',
  });
  await forgetSharedWorktreeSession(second.sessionId);
  assert.equal((await removeManagedWorktree({ entryId: target.entry.id })).removed, true);
});

test('an existing free branch gets a folder, while the main branch reuses its existing folder', async () => {
  const projectPath = makeRepo();
  git(projectPath, 'branch', 'feature/existing');
  const target = await resolveBranchWorkspace({ projectPath, branch: 'feature/existing', ...nextIds() });
  assert.equal(git(target.path, 'branch', '--show-current'), 'feature/existing');
  assert.equal((await removeManagedWorktree({ entryId: target.entry.id })).removed, true);
  assert.equal(git(projectPath, 'rev-parse', 'feature/existing'), git(projectPath, 'rev-parse', 'main'));
  const main = await resolveBranchWorkspace({ projectPath, branch: 'main', ...nextIds() });
  assert.equal(main.entry, null);
  assert.equal(git(main.path, 'branch', '--show-current'), 'main');
});

test('a failed exact-name creation never deletes a branch that already exists', async () => {
  const projectPath = makeRepo();
  git(projectPath, 'branch', 'feature/taken');
  const tip = git(projectPath, 'rev-parse', 'feature/taken');
  await assert.rejects(
    createManagedWorktree({
      projectPath,
      branch: 'feature/taken',
      nameHint: 'taken',
      ...nextIds(),
    }),
    /already exists/i
  );
  assert.equal(git(projectPath, 'rev-parse', 'feature/taken'), tip);
  assert.equal(Object.keys((await readRegistry()).entries).length, 0);
});
