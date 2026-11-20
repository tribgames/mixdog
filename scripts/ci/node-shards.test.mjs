import assert from 'node:assert/strict';
import test from 'node:test';

import { FILES_PER_SHARD, MAX_SHARDS, shardMatrix, shardsFor } from './node-shards.mjs';

test('the lane is one job until it holds more than a shard of files, and never more than the maximum', () => {
  assert.equal(shardsFor(0), 1);
  assert.equal(shardsFor(FILES_PER_SHARD), 1);
  assert.equal(shardsFor(FILES_PER_SHARD + 1), 2);
  assert.equal(shardsFor(FILES_PER_SHARD * MAX_SHARDS), MAX_SHARDS);
  assert.equal(shardsFor(FILES_PER_SHARD * MAX_SHARDS * 10), MAX_SHARDS);
});

test('the matrix numbers every shard from one, over the same total', () => {
  assert.deepEqual(shardMatrix(1), { include: [{ shard: 1, of: 1 }] });
  assert.deepEqual(
    shardMatrix(3).include.map((leg) => `${leg.shard}/${leg.of}`),
    ['1/3', '2/3', '3/3']
  );
});

test('full coverage emits the reviewed single Linux leg even above the PR shard threshold', () => {
  assert.deepEqual(shardMatrix(shardsFor(FILES_PER_SHARD + 1, { fullCoverage: true })), {
    include: [{ shard: 1, of: 1 }],
  });
});
