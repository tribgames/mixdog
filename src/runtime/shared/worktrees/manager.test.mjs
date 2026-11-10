import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { managedWorktreePath } from './contract.mjs';
import { inspectRepo } from './git.mjs';
import { getSessionWorktree, getWorktreeByPath, listBranchOccupancy, withRepoLock } from './manager.mjs';
import { putRecord } from './registry.mjs';
import { cleanupTempDirs, git, makeRepo, tempDir, useTempDataDir } from './test-support.mjs';
import { gitRepoLockKey } from '../../agent/orchestrator/tools/builtin/git-repo-rw-lock.mjs';
import { canonicalPath } from './paths.mjs';

beforeEach(() => useTempDataDir());
after(() => cleanupTempDirs());

const COMMIT = 'a'.repeat(40);

function record(repoCommonDir, id, extra = {}) {
  return {
    id,
    txId: `tx-${id}`,
    repoCommonDir,
    projectPath: join(repoCommonDir, '..'),
    path: managedWorktreePath(repoCommonDir, id),
    branch: `mixdog/${id}`,
    baseCommit: COMMIT,
    mergeTarget: 'main',
    createdAt: 1,
    ownerSessionId: `session-${id}`,
    state: 'ready',
    resources: { includes: [] },
    ...extra,
  };
}

test('getWorktreeByPath matches the canonical path, case-insensitively on Windows', async () => {
  const repoCommonDir = join(tempDir(), 'repo', '.git');
  const entry = record(repoCommonDir, 'alpha');
  mkdirSync(entry.path, { recursive: true });
  await putRecord(entry);
  await putRecord(record(repoCommonDir, 'beta'));

  const found = await getWorktreeByPath(entry.path);
  assert.equal(found?.id, 'alpha');
  assert.equal(found.state, 'ready');
  assert.equal(found.mergeTarget, 'main');
  assert.equal((await getWorktreeByPath(join(entry.path, 'nested', '..')))?.id, 'alpha');
  assert.equal((await getWorktreeByPath(`${entry.path}/`))?.id, 'alpha');
  assert.equal((await getWorktreeByPath(canonicalPath(entry.path)))?.id, 'alpha');
  if (process.platform === 'win32') {
    assert.equal((await getWorktreeByPath(entry.path.toUpperCase()))?.id, 'alpha');
    assert.equal((await getWorktreeByPath(entry.path.replace(/\\/g, '/')))?.id, 'alpha');
  }
  assert.equal(await getWorktreeByPath(join(entry.path, 'inside')), null);
  assert.equal(await getWorktreeByPath(join(entry.path, '..')), null);
  assert.equal(await getWorktreeByPath(''), null);
  assert.equal(await getWorktreeByPath(undefined), null);

  assert.equal((await getSessionWorktree('session-beta'))?.id, 'beta');
});

test('a project folder gone from disk is WORKTREE_PROJECT_UNKNOWN (missing), never a raw fs error', async () => {
  const repo = makeRepo();
  const asFile = join(tempDir(), 'was-a-folder');
  writeFileSync(asFile, 'not a folder');
  rmSync(repo, { recursive: true, force: true });
  for (const projectPath of [repo, asFile]) {
    const missing = (error) => {
      assert.equal(error.code, 'WORKTREE_PROJECT_UNKNOWN');
      assert.deepEqual(error.details, { projectPath: canonicalPath(projectPath), reason: 'missing' });
      assert.doesNotMatch(error.message, /ENOENT|ENOTDIR|stat/);
      return true;
    };
    // The session menu and the session-less menu both start here.
    await assert.rejects(listBranchOccupancy({ projectPath, sessionId: 's' }), missing);
    await assert.rejects(listBranchOccupancy({ projectPath, sessionId: null }), missing);
    await assert.rejects(inspectRepo(projectPath), missing);
  }
});

test('getSessionWorktree prefers the ready entry of a session', async () => {
  const repoCommonDir = join(tempDir(), 'repo', '.git');
  await putRecord(record(repoCommonDir, 'old', { ownerSessionId: 's', state: 'recovery' }));
  await putRecord(record(repoCommonDir, 'live', { ownerSessionId: 's' }));
  assert.equal((await getSessionWorktree('s'))?.id, 'live');
});

test('withRepoLock serializes the main checkout and its linked worktrees on the common dir', async () => {
  const repo = makeRepo();
  const linked = join(tempDir(), 'linked');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', linked);
  const fromMain = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const fromLinked = git(linked, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  assert.equal(gitRepoLockKey(fromMain), gitRepoLockKey(fromLinked));

  const events = [];
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const first = withRepoLock(fromMain, async () => {
    events.push('main:start');
    await held;
    events.push('main:end');
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = withRepoLock(fromLinked, async () => {
    events.push('linked:start');
    // Re-entrant within the holder's call chain.
    await withRepoLock(fromMain, () => events.push('linked:nested'));
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(events, ['main:start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['main:start', 'main:end', 'linked:start', 'linked:nested']);
});
