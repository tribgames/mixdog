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

  review.current = { ...review.current, patch: 'diff --git a/y b/y\n' };
  const changed = await session.getTurnReviewDiff({ refresh: false, known: first.etag });
  assert.equal(changed.patch, review.current.patch);
  assert.notEqual(changed.etag, first.etag);
});
