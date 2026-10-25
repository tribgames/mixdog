import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gitStatusRunner } from './git.mjs';
import { mergeBranchIntoCheckout } from './merge.mjs';
import { cleanupTempDirs, commitFile, git, makeRepo, writeHook } from './test-support.mjs';

after(() => cleanupTempDirs());

const merge = (cwd, source, extra = {}) =>
  mergeBranchIntoCheckout({ git: gitStatusRunner, cwd, source, confirmed: true, ...extra });

test('a merge that fails after a clean preflight aborts only its own merge and throws', async () => {
  const repo = makeRepo();
  git(repo, 'checkout', '-q', '-b', 'topic');
  commitFile(repo, 'topic.txt', 'topic\n');
  git(repo, 'checkout', '-q', 'main');
  const head = git(repo, 'rev-parse', 'HEAD');
  writeHook(repo, 'pre-merge-commit', '#!/bin/sh\necho refused >&2\nexit 1\n');
  await assert.rejects(merge(repo, 'topic', { target: 'main' }), (error) => {
    assert.equal(error.code, 'MERGE_FAILED');
    assert.equal(error.aborted, true);
    return true;
  });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(repo, '.git', 'MERGE_HEAD')), false);
});

test('preconditions: confirmation, branch target, no operation in progress', async () => {
  const repo = makeRepo();
  git(repo, 'branch', 'topic');
  await assert.rejects(merge(repo, 'topic', { confirmed: false }), { code: 'WORKTREE_CONFIRM_REQUIRED' });
  await assert.rejects(merge(repo, 'missing'), (error) => {
    assert.equal(error.code, 'MERGE_FAILED');
    assert.equal(error.details.reason, 'source-missing');
    return true;
  });
  await assert.rejects(merge(repo, 'topic', { target: 'release' }), (error) => {
    assert.equal(error.code, 'WORKTREE_TARGET_MISMATCH');
    assert.deepEqual(error.details, { expected: 'release', actual: 'main' });
    return true;
  });
  assert.deepEqual(await merge(repo, 'topic'), {
    merged: true,
    commit: git(repo, 'rev-parse', 'HEAD'),
    target: 'main',
    upToDate: true,
  });

  git(repo, 'checkout', '-q', '-b', 'left');
  commitFile(repo, 'c.txt', 'left\n');
  git(repo, 'checkout', '-q', 'main');
  commitFile(repo, 'c.txt', 'main\n');
  try {
    git(repo, 'merge', 'left');
  } catch {
    /* conflict leaves MERGE_HEAD */
  }
  await assert.rejects(merge(repo, 'topic'), (error) => {
    assert.equal(error.code, 'MERGE_TARGET_DIRTY');
    assert.equal(error.details.operation, 'merge');
    return true;
  });
  git(repo, 'merge', '--abort');

  git(repo, 'checkout', '-q', '--detach');
  await assert.rejects(merge(repo, 'topic', { target: 'main' }), { code: 'WORKTREE_TARGET_MISMATCH' });
  await assert.rejects(merge(repo, 'topic'), { code: 'MERGE_FAILED', message: /Check out a branch/ });
});
