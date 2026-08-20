// Turn review revert contract.
//
// The review bar disables its Undo affordances purely from `revertMode`, so a
// review that loses its revert source silently degrades into an unusable bar.
// These cases pin the two ways that used to happen: a sibling session opening a
// turn in the same worktree, and a worktree that has no Git baseline at all.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  _resetTurnSnapshotForTest,
  beginTurnSnapshot,
  completeTurnSnapshot,
  getTurnReviewDiff,
  recordTurnDiffChanges,
  revertTurnReviewFile,
} from '../src/runtime/shared/turn-snapshot.mjs';

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

async function createDirectory(prefix) {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function createRepository() {
  const root = await createDirectory('mixdog-turn-review-');
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Turn Review Test']);
  git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(root, 'file.txt'), 'one\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('a sibling session turn leaves a completed review revertable', async () => {
  const root = await createRepository();
  _resetTurnSnapshotForTest();
  try {
    await beginTurnSnapshot(root, 'session-a');
    await writeFile(join(root, 'file.txt'), 'one\ntwo\n');
    assert.equal((await getTurnReviewDiff(root, 'session-a')).revertMode, 'worktree');
    await completeTurnSnapshot('session-a');

    // Opening a turn in the SAME worktree from another session used to flip
    // the sealed tracker to contended. That review had already released its
    // exact-mutation buffers, so it lost every revert source at once.
    await beginTurnSnapshot(root, 'session-b');
    const review = await getTurnReviewDiff(root, 'session-a');
    assert.equal(review.snapshotKind, 'worktree');
    assert.equal(review.revertMode, 'worktree');

    await revertTurnReviewFile(root, 'session-a', 'file.txt');
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'one\n');
  } finally {
    _resetTurnSnapshotForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('overlapping live turns still fall back to exact apply_patch tracking', async () => {
  const root = await createRepository();
  _resetTurnSnapshotForTest();
  try {
    await beginTurnSnapshot(root, 'live-a');
    await beginTurnSnapshot(root, 'live-b');
    await writeFile(join(root, 'file.txt'), 'one\ntwo\n');
    recordTurnDiffChanges('live-a', [{
      path: join(root, 'file.txt'),
      displayPath: 'file.txt',
      before: 'one\n',
      after: 'one\ntwo\n',
    }]);

    const review = await getTurnReviewDiff(root, 'live-a');
    assert.equal(review.snapshotKind, 'tool');
    assert.equal(review.revertMode, 'tracked');

    await revertTurnReviewFile(root, 'live-a', 'file.txt');
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'one\n');
  } finally {
    _resetTurnSnapshotForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('a worktree without a Git baseline keeps the tracked revert', async () => {
  const root = await createDirectory('mixdog-turn-review-plain-');
  _resetTurnSnapshotForTest();
  try {
    await beginTurnSnapshot(root, 'session-c');
    await writeFile(join(root, 'note.txt'), 'after\n');
    recordTurnDiffChanges('session-c', [{
      path: join(root, 'note.txt'),
      displayPath: 'note.txt',
      before: null,
      after: 'after\n',
    }]);
    await completeTurnSnapshot('session-c');

    const review = await getTurnReviewDiff(root, 'session-c');
    assert.equal(review.snapshotKind, 'tool');
    assert.equal(review.revertMode, 'tracked');

    await revertTurnReviewFile(root, 'session-c', 'note.txt');
    assert.equal(await exists(join(root, 'note.txt')), false);
  } finally {
    _resetTurnSnapshotForTest();
    await rm(root, { recursive: true, force: true });
  }
});
