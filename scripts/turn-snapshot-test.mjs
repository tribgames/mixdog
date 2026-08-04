import test from 'node:test';
import assert from 'node:assert/strict';

const {
  beginTurnSnapshot,
  beginAgentTurnReview,
  completeAgentTurnReview,
  getTurnReviewDiff,
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
