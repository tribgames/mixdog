import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentReviewCache,
  leadReviewCache,
  leadReviewFilesCache,
  leadReviewSnapshotKindCache,
  rememberAgentReviews,
  reviewTagCache,
} from './turn-review-cache.ts';

test('an oversized review keeps its bar decision and file list without the patch text', () => {
  const scope = 'big-session:turn';
  const files = [{ path: 'site/ko/index.html', status: 'A', additions: 900, deletions: 0 }];
  const patch = 'x'.repeat(5 * 1024 * 1024);
  rememberAgentReviews(
    scope,
    [{ sessionId: 'child', agent: 'worker', tag: null, patch }],
    patch,
    files,
    'worktree',
    'cp',
    'etag-1'
  );
  // Entering this session again must not wait on a fresh review read.
  assert.equal(leadReviewSnapshotKindCache.get(scope), 'worktree');
  assert.deepEqual(leadReviewFilesCache.get(scope), files);
  assert.equal(leadReviewCache.get(scope), null);
  assert.deepEqual(agentReviewCache.get(scope), []);
  assert.equal(reviewTagCache.has(scope), false, 'a patch-less entry is never answered unchanged');

  rememberAgentReviews(scope, [], 'small patch', files, 'worktree', 'cp', 'etag-2');
  assert.equal(leadReviewCache.get(scope), 'small patch');
  assert.equal(reviewTagCache.get(scope), 'etag-2');
});
