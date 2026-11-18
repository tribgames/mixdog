import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs, selectTestFiles } from '../test.mjs';

test('--expose-gc reaches the test processes, beside the other forwarded flags', () => {
  assert.deepEqual(parseArgs(['--expose-gc', '--test-shard=1/3']).nodeArgs, ['--expose-gc', '--test-shard=1/3']);
  assert.deepEqual(parseArgs([]).nodeArgs, []);
});

test('delegating a test directory leaves the rest of the fast lane with its original owner', () => {
  const subtree = 'packages/protocol-client/test';
  const client = `${subtree}/rows/skill-mentions.test.mjs`;
  const sibling = 'packages/protocol-client/src/launch/crash-capture/daemon-exit-record.test.mjs';
  const files = [client, sibling];
  assert.deepEqual(selectTestFiles(files, parseArgs([])), files);
  assert.deepEqual(selectTestFiles(files, parseArgs(['--exclude-path', subtree])), [sibling]);
  assert.deepEqual(selectTestFiles(files, parseArgs([`${subtree}/`])), [client]);
});
