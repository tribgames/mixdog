import test from 'node:test';
import assert from 'node:assert/strict';
import { runScopedSearchInFlight } from './scoped-search-flight.mjs';
import { cacheSet, invalidateBuiltinResultCache } from '../cache-layers.mjs';

test.afterEach(() => invalidateBuiltinResultCache());

for (const field of ['complete', 'cacheSafe']) {
  test(`shared scan propagates ${field}=false to every subscriber`, async () => {
    const release = Promise.withResolvers();
    const outcomes = [{ complete: true, cacheSafe: true }, { complete: true, cacheSafe: true }];
    let calls = 0;
    const compute = async ({ scopedCacheOutcome }) => {
      calls++;
      await release.promise;
      scopedCacheOutcome[field] = false;
      return 'body';
    };
    const pending = outcomes.map((outcome) => runScopedSearchInFlight(`shared-${field}`, compute, {}, outcome));
    release.resolve();
    assert.deepEqual(await Promise.all(pending), ['body', 'body']);
    assert.equal(calls, 1);
    assert.ok(outcomes.every((outcome) => outcome[field] === false));
  });
}

test('a safe persisted result remains text and does not clear an earlier unsafe outcome', async () => {
  cacheSet('safe-result', 'cached body');
  const outcome = { complete: true, cacheSafe: false };
  assert.equal(await runScopedSearchInFlight('safe-result', () => assert.fail('unexpected execution'), {}, outcome), 'cached body');
  assert.equal(outcome.cacheSafe, false);
});
