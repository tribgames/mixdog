import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _noteSearchTimeoutForTest,
  _resetNativeSearchClientForTest,
} from './native-search-client.mjs';

test('native search keeps the server on a first timeout and marks the shard on a 30s recurrence', () => {
  _resetNativeSearchClientForTest();
  const startedAt = 1_000_000;
  const firstServer = {};
  const replacementServer = {};
  const laterServer = {};
  assert.equal(_noteSearchTimeoutForTest(firstServer, startedAt), 'server');
  assert.equal(_noteSearchTimeoutForTest(firstServer, startedAt + 1), 'none');
  assert.equal(_noteSearchTimeoutForTest(replacementServer, startedAt + 29_999), 'shard');
  assert.equal(_noteSearchTimeoutForTest(replacementServer, startedAt + 30_000), 'none');
  assert.equal(_noteSearchTimeoutForTest(laterServer, startedAt + 60_001), 'server');
  _resetNativeSearchClientForTest();
});
