import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _noteSearchTimeoutForTest,
  _resetNativeSearchClientForTest,
} from './native-search-client.mjs';

// `noteSearchTimeout` returns 'runtime' for a recurrence inside the window;
// that is the only branch the caller acts on (settleTimeout →
// reportRuntimeWorkerUnhealthy), so 'shard' was a stale expectation.
test('native search keeps the server on a first timeout and marks the runtime worker on a 30s recurrence', () => {
  _resetNativeSearchClientForTest();
  const startedAt = 1_000_000;
  const firstServer = {};
  const replacementServer = {};
  const laterServer = {};
  assert.equal(_noteSearchTimeoutForTest(firstServer, startedAt), 'server');
  assert.equal(_noteSearchTimeoutForTest(firstServer, startedAt + 1), 'none');
  assert.equal(_noteSearchTimeoutForTest(replacementServer, startedAt + 29_999), 'runtime');
  assert.equal(_noteSearchTimeoutForTest(replacementServer, startedAt + 30_000), 'none');
  assert.equal(_noteSearchTimeoutForTest(laterServer, startedAt + 60_001), 'server');
  _resetNativeSearchClientForTest();
});
