// Warm-shard placement. A fresh session id carries no shard affinity, so a
// create whose hash shard is cold must be answered by an already-live
// (prewarmed) shard instead of paying fork + module graph + keychain +
// provider init inline in front of the first turn. The hash spread returns
// once shards are live (or the warm shard reaches its soft cap).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createSessionRuntimePool,
  sessionShardIndex,
} from '../src/standalone/session-runtime-pool.mjs';

function sessionIdForShard(targetShard, shardCount, label) {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const candidate = `sess_${label}_${attempt}`;
    if (sessionShardIndex(candidate, shardCount) === targetShard) return candidate;
  }
  throw new Error(`no session id hashes to shard ${targetShard}`);
}

test('a cold-hash create lands on the prewarmed shard; spill returns to the hash shard', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-shard-placement-'));
  const pool = createSessionRuntimePool({
    shardCount: 2,
    cwd: root,
    env: {
      ...process.env,
      MIXDOG_RUNTIME_ROOT: root,
      MIXDOG_DATA_DIR: root,
      MIXDOG_BOOT_CORE_MEMORY: '0',
      MIXDOG_DAEMON_SKIP_MEMORY: '1',
      MIXDOG_AGENT_TRACE_DISABLE: '1',
    },
  });
  try {
    await pool.prewarm();
    assert.ok(pool.status.shards[0].pid, 'prewarm boots shard 0');
    assert.equal(pool.status.shards[1].pid, null, 'prewarm leaves peer shards cold');

    // Four ids that all hash to the COLD shard 1: the live shard 0 absorbs
    // them up to its soft cap.
    for (let index = 0; index < 4; index += 1) {
      const sessionId = sessionIdForShard(1, 2, `warm${index}`);
      await pool.create({ sessionId, cwd: root });
      assert.equal(pool.status.shards[1].pid, null,
        `create ${index + 1} must not boot the cold hash shard`);
    }
    assert.equal(pool.status.shards[0].runtimes, 4);

    // Above the soft cap the hash shard takes over: isolation beats spawn cost
    // once a real multi-session workload exists.
    const spillId = sessionIdForShard(1, 2, 'spill');
    await pool.create({ sessionId: spillId, cwd: root });
    assert.ok(pool.status.shards[1].pid, 'spill create boots the hash shard');
    assert.equal(pool.status.shards[1].runtimes, 1);

    // A live hash shard is always used directly.
    const directId = sessionIdForShard(1, 2, 'direct');
    await pool.create({ sessionId: directId, cwd: root });
    assert.equal(pool.status.shards[1].runtimes, 2);
    assert.equal(pool.status.shards[0].runtimes, 4);
  } finally {
    await pool.close('shard placement test');
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
