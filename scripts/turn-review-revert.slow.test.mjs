// Turn review revert contract.
//
// The review bar disables its Undo affordances purely from `revertMode`, so a
// review that loses its revert source silently degrades into an unusable bar.
// These cases pin the two ways that used to happen: a sibling session opening a
// turn in the same worktree, and a worktree that has no Git baseline at all.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  _resetTurnSnapshotForTest,
  beginTurnSnapshot,
  completeTurnSnapshot,
  getSessionReviewDiff,
  getTurnReviewDiff,
  recordTurnDiffChanges,
  revertTurnReview,
  revertTurnReviewFile,
} from '../src/runtime/shared/turn-snapshot.mjs';
import { _setTurnSnapshotStoreRootForTest } from '../src/runtime/shared/turn-snapshot-store.mjs';

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
    await beginTurnSnapshot(root, 'session-a', { checkpointId: 'prompt-a' });
    await writeFile(join(root, 'file.txt'), 'one\ntwo\n');
    const initialReview = await getTurnReviewDiff(root, 'session-a');
    assert.equal(initialReview.revertMode, 'worktree');
    assert.equal(initialReview.checkpointId, 'prompt-a');
    await completeTurnSnapshot('session-a');

    // Opening a turn in the SAME worktree from another session used to flip
    // the sealed tracker to contended. That review had already released its
    // exact-mutation buffers, so it lost every revert source at once.
    await beginTurnSnapshot(root, 'session-b');
    const review = await getTurnReviewDiff(root, 'session-a');
    assert.equal(review.snapshotKind, 'worktree');
    assert.equal(review.revertMode, 'worktree');

    await assert.rejects(
      revertTurnReviewFile(root, 'session-a', 'file.txt', 'prompt-b'),
      /checkpoint changed/,
    );
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'one\ntwo\n');

    await revertTurnReviewFile(root, 'session-a', 'file.txt', 'prompt-a');
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

test('only the next outer prompt replaces the checkpoint', async () => {
  const root = await createRepository();
  _resetTurnSnapshotForTest();
  try {
    await beginTurnSnapshot(root, 'follow-up', { checkpointId: 'prompt-1' });
    await writeFile(join(root, 'file.txt'), 'one\ntwo\n');
    assert.equal((await getTurnReviewDiff(root, 'follow-up')).checkpointId, 'prompt-1');

    // Mid-loop steering does not call beginTurnSnapshot, so every refresh in
    // the outer loop keeps the original prompt checkpoint.
    assert.equal((await getTurnReviewDiff(root, 'follow-up')).checkpointId, 'prompt-1');
    await completeTurnSnapshot('follow-up');

    await beginTurnSnapshot(root, 'follow-up', { checkpointId: 'prompt-2' });
    await writeFile(join(root, 'file.txt'), 'one\ntwo\nthree\n');
    assert.equal((await getTurnReviewDiff(root, 'follow-up')).checkpointId, 'prompt-2');

    await assert.rejects(
      revertTurnReview(root, 'follow-up', 'prompt-1'),
      /checkpoint changed/,
    );
    await revertTurnReview(root, 'follow-up', 'prompt-2');
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'one\ntwo\n');
  } finally {
    _resetTurnSnapshotForTest();
    await rm(root, { recursive: true, force: true });
  }
});

// The two ways a review used to lose its revert while the baseline tree was
// still on disk: the runtime dropped the tracker (next turn, cache eviction,
// restart), and a shared worktree made the whole-tree diff unattributable.
test('a completed review survives losing its in-memory tracker', async () => {
  const root = await createRepository();
  const store = await createDirectory('mixdog-turn-review-store-');
  _resetTurnSnapshotForTest();
  _setTurnSnapshotStoreRootForTest(store);
  try {
    await beginTurnSnapshot(root, 'restart-a', { checkpointId: 'prompt-restart' });
    await writeFile(join(root, 'file.txt'), 'one\ntwo\n');
    recordTurnDiffChanges('restart-a', [{
      path: join(root, 'file.txt'),
      displayPath: 'file.txt',
      before: 'one\n',
      after: 'one\ntwo\n',
    }]);
    await completeTurnSnapshot('restart-a');

    // Everything the runtime held about this turn is gone.
    _resetTurnSnapshotForTest();

    const review = await getTurnReviewDiff(root, 'restart-a');
    assert.equal(review.snapshotKind, 'scoped');
    assert.equal(review.revertMode, 'scoped');
    assert.equal(review.checkpointId, 'prompt-restart');
    assert.deepEqual(review.files.map((file) => file.path), ['file.txt']);

    await assert.rejects(
      revertTurnReview(root, 'restart-a', 'wrong-prompt'),
      /checkpoint changed/,
    );
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'one\ntwo\n');

    await revertTurnReview(root, 'restart-a', 'prompt-restart');
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'one\n');
  } finally {
    _resetTurnSnapshotForTest();
    _setTurnSnapshotStoreRootForTest('');
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('a shared worktree reverts only the session-owned paths', async () => {
  const root = await createRepository();
  const store = await createDirectory('mixdog-turn-review-store-');
  _resetTurnSnapshotForTest();
  _setTurnSnapshotStoreRootForTest(store);
  try {
    await beginTurnSnapshot(root, 'shared-a');
    await beginTurnSnapshot(root, 'shared-b');
    await writeFile(join(root, 'file.txt'), 'one\ntwo\n');
    await writeFile(join(root, 'sibling.txt'), 'sibling\n');
    recordTurnDiffChanges('shared-a', [{
      path: join(root, 'file.txt'),
      displayPath: 'file.txt',
      before: 'one\n',
      after: 'one\ntwo\n',
    }]);
    await completeTurnSnapshot('shared-a');
    _resetTurnSnapshotForTest();

    const review = await getTurnReviewDiff(root, 'shared-a');
    assert.equal(review.revertMode, 'scoped');
    // sibling.txt lives in the same baseline and is deliberately absent: it is
    // not this session's to review or to revert.
    assert.deepEqual(review.files.map((file) => file.path), ['file.txt']);

    await revertTurnReview(root, 'shared-a');
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'one\n');
    assert.equal(await readFile(join(root, 'sibling.txt'), 'utf8'), 'sibling\n');
  } finally {
    _resetTurnSnapshotForTest();
    _setTurnSnapshotStoreRootForTest('');
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('a session review accumulates every checkpoint change across turns without widening to the worktree', async () => {
  const root = await createRepository();
  const store = await createDirectory('mixdog-session-review-store-');
  _resetTurnSnapshotForTest();
  _setTurnSnapshotStoreRootForTest(store);
  try {
    await beginTurnSnapshot(root, 'cumulative');
    await writeFile(join(root, 'file.txt'), 'one\ntwo\n');
    recordTurnDiffChanges('cumulative', [{
      path: join(root, 'file.txt'),
      displayPath: 'file.txt',
      before: 'one\n',
      after: 'one\ntwo\n',
    }]);
    await completeTurnSnapshot('cumulative');
    // Changed BETWEEN turns by the user: no checkpoint observed it and no tool
    // wrote it, so the cumulative pane must not become Source Control.
    await writeFile(join(root, 'outside.txt'), 'outside\n');

    await beginTurnSnapshot(root, 'cumulative');
    await writeFile(join(root, 'second.txt'), 'session\n');
    recordTurnDiffChanges('cumulative', [{
      path: join(root, 'second.txt'),
      displayPath: 'second.txt',
      before: null,
      after: 'session\n',
    }]);
    // Written by a shell command during the turn: the checkpoint diff is what
    // attributes it, exactly as the turn review bar counts it.
    await writeFile(join(root, 'shell.txt'), 'shell\n');

    const live = await getSessionReviewDiff(root, 'cumulative');
    assert.equal(live.snapshotKind, 'session');
    assert.deepEqual(
      live.files.map((file) => file.path).sort(),
      ['file.txt', 'second.txt', 'shell.txt'],
    );
    await completeTurnSnapshot('cumulative');
    _resetTurnSnapshotForTest();

    const resumed = await getSessionReviewDiff(root, 'cumulative');
    assert.equal(resumed.snapshotKind, 'session');
    assert.deepEqual(
      resumed.files.map((file) => file.path).sort(),
      ['file.txt', 'second.txt', 'shell.txt'],
    );
  } finally {
    _resetTurnSnapshotForTest();
    _setTurnSnapshotStoreRootForTest('');
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('a session whose cwd is a subdirectory still scopes its review to the repository root', async () => {
  const root = await createRepository();
  const store = await createDirectory('mixdog-session-review-store-');
  const cwd = join(root, 'apps', 'web');
  await mkdir(cwd, { recursive: true });
  _resetTurnSnapshotForTest();
  _setTurnSnapshotStoreRootForTest(store);
  try {
    await beginTurnSnapshot(cwd, 'nested', { checkpointId: 'prompt-nested' });
    await writeFile(join(cwd, 'page.txt'), 'nested\n');
    // The tool reports the path relative to the session cwd, not to the root.
    recordTurnDiffChanges('nested', [{
      path: join(cwd, 'page.txt'),
      displayPath: 'page.txt',
      before: null,
      after: 'nested\n',
    }]);
    const live = await getSessionReviewDiff(cwd, 'nested');
    assert.deepEqual(live.files.map((file) => file.path), ['apps/web/page.txt']);
    await completeTurnSnapshot('nested');
    _resetTurnSnapshotForTest();

    const resumed = await getSessionReviewDiff(cwd, 'nested');
    assert.deepEqual(resumed.files.map((file) => file.path), ['apps/web/page.txt']);
    // The recorded revert scope resolves the same file.
    const reverted = await revertTurnReviewFile(cwd, 'nested', 'apps/web/page.txt', 'prompt-nested');
    assert.equal(reverted.files.length, 0);
    assert.equal(await exists(join(cwd, 'page.txt')), false);
  } finally {
    _resetTurnSnapshotForTest();
    _setTurnSnapshotStoreRootForTest('');
    await rm(store, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
