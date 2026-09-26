import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionIntegrationsApi } from './integrations.mjs';

function api(review) {
  const seen = [];
  const runtime = {
    async getTurnReviewDiff(options) {
      seen.push(options);
      return review.current;
    },
  };
  const bag = { runtime, getState: () => ({}), set: () => {}, pushNotice: () => {}, routeState: {} };
  return { seen, session: createSessionIntegrationsApi(bag, { oauthFlows: new Map() }) };
}

test('an unchanged turn review answers with its tag instead of the whole patch', async () => {
  const review = { current: { supported: true, authoritative: true, patch: 'diff --git a/x b/x\n', files: [] } };
  const { seen, session } = api(review);

  const first = await session.getTurnReviewDiff({ refresh: true });
  assert.match(first.etag, /^[a-f0-9]{32}$/);
  assert.equal(first.patch, review.current.patch);

  const again = await session.getTurnReviewDiff({ refresh: true, known: first.etag });
  assert.deepEqual(again, { unchanged: true, etag: first.etag });
  assert.deepEqual(seen.at(-1), { refresh: true }, 'the tag never reaches the runtime');

  // A collapsed bar asks for a summary: a Git-backed review drops its patch
  // text (the files carry the counts) and is tagged apart from the full one.
  review.current = { ...review.current, snapshotKind: 'worktree', files: [{ path: 'x', additions: 3, deletions: 1 }] };
  const full = await session.getTurnReviewDiff({ refresh: true });
  const summary = await session.getTurnReviewDiff({ refresh: true, summary: true, known: full.etag });
  assert.equal(summary.patch, '');
  assert.equal(summary.patchOmitted, true);
  assert.deepEqual(summary.files, review.current.files);
  assert.notEqual(summary.etag, full.etag);
  assert.deepEqual(await session.getTurnReviewDiff({ summary: true, known: summary.etag }), {
    unchanged: true,
    etag: summary.etag,
  });
  assert.equal(Object.hasOwn(seen.at(-1), 'summary'), false, 'the summary flag never reaches the runtime');
  // A review counted from its patch (no Git snapshot) keeps the patch.
  review.current = { ...review.current, snapshotKind: 'tool' };
  assert.equal((await session.getTurnReviewDiff({ summary: true })).patch, review.current.patch);

  review.current = { ...review.current, patch: 'diff --git a/y b/y\n' };
  const changed = await session.getTurnReviewDiff({ refresh: false, known: first.etag });
  assert.equal(changed.patch, review.current.patch);
  assert.notEqual(changed.etag, first.etag);
});
