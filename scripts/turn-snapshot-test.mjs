import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  beginTurnSnapshot,
  beginAgentTurnReview,
  completeAgentTurnReview,
  completeTurnSnapshot,
  getTurnReviewDiff,
  recordTurnDiffChanges,
  revertTurnReviewFile,
  _resetTurnSnapshotForTest,
} = await import('../src/runtime/shared/turn-snapshot.mjs');

const PATCH_A = [
  'diff --git a/src/a.mjs b/src/a.mjs',
  '--- a/src/a.mjs',
  '+++ b/src/a.mjs',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');

const PATCH_B = [
  'diff --git a/src/b.mjs b/src/b.mjs',
  '--- a/src/b.mjs',
  '+++ b/src/b.mjs',
  '@@ -0,0 +1 @@',
  '+created',
].join('\n');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function worktreeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-turn-worktree-'));
  git(dir, ['init', '-q']);
  writeFileSync(join(dir, 'tracked.txt'), 'committed baseline\n');
  git(dir, ['add', 'tracked.txt']);
  return dir;
}

test('worktree snapshots include shell/untracked edits and preserve the dirty turn baseline', async () => {
  _resetTurnSnapshotForTest();
  const dir = worktreeFixture();
  try {
    writeFileSync(join(dir, 'tracked.txt'), 'dirty before turn\n');
    await beginTurnSnapshot(dir, 'lead-worktree');
    writeFileSync(join(dir, 'tracked.txt'), 'changed by shell\n');
    writeFileSync(join(dir, 'shell-created.txt'), 'created by shell\n');
    writeFileSync(join(dir, 'large-build-artifact.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 1));

    const review = await getTurnReviewDiff(dir, 'lead-worktree');
    assert.equal(review.snapshotKind, 'worktree');
    assert.deepEqual(review.files.map((file) => file.path), ['shell-created.txt', 'tracked.txt']);
    assert.match(review.patch, /-dirty before turn/);
    assert.match(review.patch, /\+changed by shell/);
    assert.doesNotMatch(review.patch, /committed baseline/);

    writeFileSync(join(dir, 'tracked.txt'), 'temporary state\n');
    assert.match((await getTurnReviewDiff(dir, 'lead-worktree')).patch, /temporary state/);
    writeFileSync(join(dir, 'tracked.txt'), 'changed by shell\n');
    const restoredReview = await getTurnReviewDiff(dir, 'lead-worktree');
    assert.doesNotMatch(restoredReview.patch, /temporary state/,
      'a change observed mid-turn must disappear after the worktree returns to the latest turn state');

    const reverted = await revertTurnReviewFile(dir, 'lead-worktree', 'tracked.txt');
    assert.equal(readFileSync(join(dir, 'tracked.txt'), 'utf8'), 'dirty before turn\n');
    assert.deepEqual(reverted.files.map((file) => file.path), ['shell-created.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent sessions in one worktree expose only their session-owned mutations', async () => {
  _resetTurnSnapshotForTest();
  const dir = worktreeFixture();
  try {
    await beginTurnSnapshot(dir, 'parallel-a');
    await beginTurnSnapshot(dir, 'parallel-b');
    const file = join(dir, 'tracked.txt');
    recordTurnDiffChanges('parallel-a', [{
      path: file,
      displayPath: 'tracked.txt',
      before: Buffer.from('committed baseline\n'),
      after: Buffer.from('changed by a\n'),
    }]);
    writeFileSync(file, 'changed by a\n');

    const left = await getTurnReviewDiff(dir, 'parallel-a');
    const right = await getTurnReviewDiff(dir, 'parallel-b');
    assert.equal(left.snapshotKind, 'tool');
    assert.match(left.patch, /changed by a/);
    assert.equal(right.snapshotKind, 'tool');
    assert.equal(right.patch, '',
      'another active session must not inherit a shared worktree mutation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same-worktree turns are isolated before either asynchronous baseline finishes', async () => {
  _resetTurnSnapshotForTest();
  const dir = worktreeFixture();
  try {
    const [first, second] = await Promise.all([
      beginTurnSnapshot(dir, 'parallel-start-a'),
      beginTurnSnapshot(dir, 'parallel-start-b'),
    ]);
    assert.equal(first, undefined);
    assert.equal(second, undefined);
    const left = await getTurnReviewDiff(dir, 'parallel-start-a');
    const right = await getTurnReviewDiff(dir, 'parallel-start-b');
    assert.equal(left.snapshotKind, 'tool');
    assert.equal(right.snapshotKind, 'tool');
    await assert.rejects(
      () => revertTurnReviewFile(dir, 'parallel-start-a', 'tracked.txt'),
      /sessions share a worktree/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('untracked files that grow past the snapshot bound do not survive in the persistent shadow index', async () => {
  _resetTurnSnapshotForTest();
  const dir = worktreeFixture();
  const artifact = join(dir, 'growing-artifact.bin');
  try {
    writeFileSync(artifact, 'small artifact\n');
    await beginTurnSnapshot(dir, 'lead-large-seed');
    await completeTurnSnapshot('lead-large-seed');

    writeFileSync(artifact, Buffer.alloc(2 * 1024 * 1024 + 1, 1));
    await beginTurnSnapshot(dir, 'lead-large-baseline');
    assert.deepEqual((await getTurnReviewDiff(dir, 'lead-large-baseline')).files, []);

    rmSync(artifact, { force: true });
    const review = await getTurnReviewDiff(dir, 'lead-large-baseline');
    assert.deepEqual(review.files, [],
      'deleting an artifact excluded at turn start must not reveal its stale smaller shadow blob');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worktree snapshots collapse no-ops and expose rename/binary metadata without fake zero stats', async () => {
  _resetTurnSnapshotForTest();
  const dir = worktreeFixture();
  try {
    writeFileSync(join(dir, 'rename-me.txt'), 'same content\n');
    git(dir, ['add', 'rename-me.txt']);
    await beginTurnSnapshot(dir, 'lead-metadata');
    let review = await getTurnReviewDiff(dir, 'lead-metadata');
    assert.deepEqual(review.files, []);

    renameSync(join(dir, 'rename-me.txt'), join(dir, 'renamed.txt'));
    writeFileSync(join(dir, 'binary.bin'), Buffer.from([0xff, 0x00, 0xfe, 0x01]));
    review = await getTurnReviewDiff(dir, 'lead-metadata');
    const renamed = review.files.find((file) => file.path === 'renamed.txt');
    const binary = review.files.find((file) => file.path === 'binary.bin');
    assert.equal(renamed?.status, 'R');
    assert.equal(renamed?.additions, 0);
    assert.equal(renamed?.deletions, 0);
    assert.equal(binary?.binary, true);
    assert.equal(binary?.additions, null);
    assert.equal(binary?.deletions, null);
    await completeTurnSnapshot('lead-metadata');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('turn review keeps successful worker patches separate from the Lead', async () => {
  _resetTurnSnapshotForTest();
  await beginTurnSnapshot('C:/project', 'lead-a');
  const worker = beginAgentTurnReview('lead-a', 'worker-a', { agent: 'worker', tag: 'worker-1' });
  assert.ok(worker);
  assert.equal(completeAgentTurnReview(worker, [PATCH_A, PATCH_B]), true);

  const review = await getTurnReviewDiff('C:/project', 'lead-a');
  assert.equal(review.supported, true);
  assert.deepEqual(review.files, []);
  assert.equal(review.patch, '');
  assert.equal(review.agents.length, 1);
  assert.equal(review.agents[0].sessionId, 'worker-a');
  assert.equal(review.agents[0].tag, 'worker-1');
  assert.match(review.agents[0].patch, /src\/a\.mjs/);
  assert.match(review.agents[0].patch, /src\/b\.mjs/);
});

test('a new turn rejects late child results from the prior generation', async () => {
  _resetTurnSnapshotForTest();
  await beginTurnSnapshot('C:/project', 'lead-b');
  const stale = beginAgentTurnReview('lead-b', 'worker-stale', { agent: 'worker' });
  await beginTurnSnapshot('C:/project', 'lead-b');
  assert.equal(completeAgentTurnReview(stale, [PATCH_A]), false);
  const review = await getTurnReviewDiff('C:/project', 'lead-b');
  assert.deepEqual(review.agents, []);
});

test('session turn reviews remain isolated and repeated worker sends merge', async () => {
  _resetTurnSnapshotForTest();
  await beginTurnSnapshot('C:/project', 'lead-c');
  await beginTurnSnapshot('C:/project', 'lead-d');
  const first = beginAgentTurnReview('lead-c', 'worker-shared', { agent: 'worker', tag: 'worker-1' });
  const second = beginAgentTurnReview('lead-c', 'worker-shared', { agent: 'worker', tag: 'worker-1' });
  completeAgentTurnReview(first, [PATCH_A]);
  completeAgentTurnReview(second, [PATCH_B]);

  const left = await getTurnReviewDiff('C:/project', 'lead-c');
  const right = await getTurnReviewDiff('C:/project', 'lead-d');
  assert.equal(left.agents.length, 1);
  assert.match(left.agents[0].patch, /src\/a\.mjs/);
  assert.match(left.agents[0].patch, /src\/b\.mjs/);
  assert.deepEqual(right.agents, []);
});

test('Lead turn diff keeps the first baseline and latest committed content', async () => {
  _resetTurnSnapshotForTest();
  await beginTurnSnapshot('C:/project', 'lead-net');
  recordTurnDiffChanges('lead-net', [{
    path: 'C:/project/src/a.mjs',
    displayPath: 'src/a.mjs',
    before: Buffer.from('old\n'),
    after: Buffer.from('middle\n'),
  }]);
  recordTurnDiffChanges('lead-net', [{
    path: 'C:/project/src/a.mjs',
    displayPath: 'src/a.mjs',
    before: Buffer.from('middle\n'),
    after: Buffer.from('final\n'),
  }]);
  let review = await getTurnReviewDiff('C:/project', 'lead-net');
  assert.equal(review.authoritative, true);
  assert.match(review.patch, /-old/);
  assert.match(review.patch, /\+final/);
  assert.doesNotMatch(review.patch, /middle/);

  recordTurnDiffChanges('lead-net', [{
    path: 'C:/project/src/a.mjs',
    displayPath: 'src/a.mjs',
    before: Buffer.from('final\n'),
    after: Buffer.from('old\n'),
  }]);
  review = await getTurnReviewDiff('C:/project', 'lead-net');
  assert.equal(review.patch, '', 'reverting to the turn baseline removes the file from the review');
});

test('worker review uses its tracked net diff instead of concatenating intermediate patches', async () => {
  _resetTurnSnapshotForTest();
  await beginTurnSnapshot('C:/project', 'lead-worker-net');
  const worker = beginAgentTurnReview('lead-worker-net', 'worker-net', {
    agent: 'worker',
    tag: 'worker-net',
  });
  recordTurnDiffChanges('worker-net', [{
    path: 'C:/project/src/worker.mjs',
    displayPath: 'src/worker.mjs',
    before: Buffer.from('old\n'),
    after: Buffer.from('middle\n'),
  }]);
  recordTurnDiffChanges('worker-net', [{
    path: 'C:/project/src/worker.mjs',
    displayPath: 'src/worker.mjs',
    before: Buffer.from('middle\n'),
    after: Buffer.from('final\n'),
  }]);
  assert.equal(completeAgentTurnReview(worker, [PATCH_A, PATCH_B]), true);
  const review = await getTurnReviewDiff('C:/project', 'lead-worker-net');
  assert.equal(review.agents.length, 1);
  assert.match(review.agents[0].patch, /-old/);
  assert.match(review.agents[0].patch, /\+final/);
  assert.doesNotMatch(review.agents[0].patch, /middle/);
  assert.doesNotMatch(review.agents[0].patch, /src\/a\.mjs|src\/b\.mjs/);
});

test('add-then-delete and rename-then-delete collapse to the true turn result', async () => {
  _resetTurnSnapshotForTest();
  await beginTurnSnapshot('C:/project', 'lead-path-lifecycle');
  recordTurnDiffChanges('lead-path-lifecycle', [{
    path: 'C:/project/src/new.mjs',
    displayPath: 'src/new.mjs',
    before: null,
    after: Buffer.from('temporary\n'),
  }]);
  recordTurnDiffChanges('lead-path-lifecycle', [{
    path: 'C:/project/src/new.mjs',
    displayPath: 'src/new.mjs',
    before: Buffer.from('temporary\n'),
    after: null,
  }]);
  let review = await getTurnReviewDiff('C:/project', 'lead-path-lifecycle');
  assert.equal(review.patch, '', 'a file added and deleted in one turn has no net change');

  recordTurnDiffChanges('lead-path-lifecycle', [{
    path: 'C:/project/src/old.mjs',
    displayPath: 'src/old.mjs',
    newPath: 'C:/project/src/moved.mjs',
    newDisplayPath: 'src/moved.mjs',
    before: Buffer.from('original\n'),
    after: Buffer.from('renamed\n'),
  }]);
  recordTurnDiffChanges('lead-path-lifecycle', [{
    path: 'C:/project/src/moved.mjs',
    displayPath: 'src/moved.mjs',
    before: Buffer.from('renamed\n'),
    after: null,
  }]);
  review = await getTurnReviewDiff('C:/project', 'lead-path-lifecycle');
  assert.match(review.patch, /deleted file mode/);
  assert.match(review.patch, /a\/src\/old\.mjs/);
  assert.doesNotMatch(review.patch, /b\/src\/moved\.mjs/);
});
