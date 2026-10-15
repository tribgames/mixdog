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
  assert.equal(seen.at(-1).summary, true, 'a recorded review skips the patch it would only drop');
  // A tracked review (a contended or non-Git worktree) carries its counts as
  // files too: its summary drops the patch the same way.
  review.current = {
    ...review.current,
    snapshotKind: 'tool',
    files: [
      { path: 'src/a.js', status: 'M', additions: 2, deletions: 1 },
      { path: 'b.txt', status: 'A', additions: 1, deletions: 0 },
    ],
    patch:
      'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n keep\n' +
      'diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+hi\n',
  };
  const toolSummary = await session.getTurnReviewDiff({ summary: true });
  assert.equal(toolSummary.patch, '');
  assert.equal(toolSummary.patchOmitted, true);
  assert.deepEqual(toolSummary.files, review.current.files);
  // Without `summary` the patch still travels whole.
  assert.equal((await session.getTurnReviewDiff({})).patch, review.current.patch);

  // The retained history count is part of what the tag covers.
  review.current = { ...review.current, historyTurns: 1 };
  const counted = await session.getTurnReviewDiff({ summary: true });
  review.current = { ...review.current, historyTurns: 2 };
  const recounted = await session.getTurnReviewDiff({ summary: true, known: counted.etag });
  assert.notEqual(recounted.unchanged, true);
  assert.equal(recounted.historyTurns, 2);

  review.current = { ...review.current, patch: 'diff --git a/y b/y\n' };
  const changed = await session.getTurnReviewDiff({ refresh: false, known: first.etag });
  assert.equal(changed.patch, review.current.patch);
  assert.notEqual(changed.etag, first.etag);
});
