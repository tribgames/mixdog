import test from 'node:test';
import assert from 'node:assert/strict';

const {
  beginTurnSnapshot,
  beginAgentTurnReview,
  completeAgentTurnReview,
  getTurnReviewDiff,
  recordTurnDiffChanges,
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
