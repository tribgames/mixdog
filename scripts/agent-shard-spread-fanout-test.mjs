// Agent shard spread fanout placement: a Lead session lives on one shard; an
// 8-worker fanout that passes `avoidShardIndex` must never place a worker
// runtime back on the Lead's shard loop, regardless of hash affinity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSessionRuntimePool,
  configuredSpreadPrewarmCount,
  sessionShardIndex,
} from '../src/standalone/session-runtime-pool.mjs';

const FIXTURE_WORKER = fileURLToPath(
  new URL('./fixtures/session-shard-fixture-worker.mjs', import.meta.url),
);

function sessionIdForShard(targetShard, shardCount, label) {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const candidate = `sess_${label}_${attempt}`;
    if (sessionShardIndex(candidate, shardCount) === targetShard) return candidate;
  }
  throw new Error(`no session id hashes to shard ${targetShard}`);
}

test('an 8-worker fanout never lands on the avoided Lead shard', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-shard-spread-fanout-'));
  const pool = createSessionRuntimePool({
    shardCount: 3,
    workerEntry: FIXTURE_WORKER,
    cwd: root,
    env: {
      ...process.env,
      MIXDOG_RUNTIME_ROOT: root,
      MIXDOG_DATA_DIR: root,
    },
  });
  try {
    await pool.prewarm();
    const leadId = sessionIdForShard(0, 3, 'lead');
    await pool.create({ sessionId: leadId, cwd: root });
    assert.equal(pool.status.shards[0].runtimes, 1, 'the Lead session lives on shard 0');

    // One worker whose hash affinity IS the Lead shard: avoidance must reroute.
    const stickyId = sessionIdForShard(0, 3, 'sticky');
    await pool.create({
      sessionId: stickyId,
      cwd: root,
      avoidShardIndex: 0,
      agentSession: { agent: 'worker', agentTag: 'w-sticky' },
    });
    assert.equal(pool.status.shards[0].runtimes, 1,
      'a hash-affine worker create is rerouted off the Lead shard');

    for (let index = 0; index < 7; index += 1) {
      await pool.create({
        sessionId: `sess_spread_worker_${index}`,
        cwd: root,
        avoidShardIndex: 0,
        agentSession: { agent: 'worker', agentTag: `w${index}` },
      });
    }
    const [lead, ...peers] = pool.status.shards.map((shard) => shard.runtimes);
    assert.equal(lead, 1, 'the Lead shard hosts no worker runtime after the fanout');
    assert.equal(peers.reduce((sum, count) => sum + count, 0), 8,
      'all 8 workers land on peer shards');
  } finally {
    await pool.close('shard spread fanout test');
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('spread-prewarm warms the requested shard prefix and nothing more', async () => {
  const savedPrewarm = process.env.MIXDOG_SESSION_SHARD_PREWARM;
  try {
    delete process.env.MIXDOG_SESSION_SHARD_PREWARM;
    assert.equal(configuredSpreadPrewarmCount(8), 4, 'default warms four shards');
    assert.equal(configuredSpreadPrewarmCount(2), 2, 'small pools warm every shard');
    process.env.MIXDOG_SESSION_SHARD_PREWARM = '2';
    assert.equal(configuredSpreadPrewarmCount(8), 2, 'operator override wins');
  } finally {
    if (savedPrewarm === undefined) delete process.env.MIXDOG_SESSION_SHARD_PREWARM;
    else process.env.MIXDOG_SESSION_SHARD_PREWARM = savedPrewarm;
  }
  const root = mkdtempSync(join(tmpdir(), 'mixdog-shard-spread-prewarm-'));
  const pool = createSessionRuntimePool({
    shardCount: 3,
    workerEntry: FIXTURE_WORKER,
    cwd: root,
    env: {
      ...process.env,
      MIXDOG_RUNTIME_ROOT: root,
      MIXDOG_DATA_DIR: root,
    },
  });
  try {
    const warmed = await pool.prewarmSpread({ count: 2, staggerMs: 0 });
    assert.deepEqual(warmed, [0, 1]);
    assert.ok(pool.status.shards[0].pid, 'shard 0 is warm');
    assert.ok(pool.status.shards[1].pid, 'shard 1 is warm');
    assert.equal(pool.status.shards[2].pid, null, 'shard 2 stays cold');
  } finally {
    await pool.close('spread prewarm test');
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function waitFor(predicate, message, timeoutMs = 8000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try { value = predicate(); } catch (error) { rejectPromise(error); return; }
      if (value) { resolvePromise(value); return; }
      if (Date.now() - started > timeoutMs) { rejectPromise(new Error(`timeout: ${message}`)); return; }
      // Referenced timer on purpose: the pool sweep timers are unref'd.
      setTimeout(tick, 25);
    };
    tick();
  });
}

test('an idle empty peer shard cools down and stays reusable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-shard-colddown-'));
  const pool = createSessionRuntimePool({
    shardCount: 2,
    workerEntry: FIXTURE_WORKER,
    cwd: root,
    env: {
      ...process.env,
      MIXDOG_RUNTIME_ROOT: root,
      MIXDOG_DATA_DIR: root,
    },
    coldDownMs: 150,
    coldDownSweepMs: 60,
  });
  try {
    await pool.prewarmSpread({ count: 2, staggerMs: 0 });
    assert.ok(pool.status.shards[1].pid, 'the peer shard is warm after spread-prewarm');
    await waitFor(() => pool.status.shards[1].pid === null, 'the idle peer shard cools down');
    assert.ok(pool.status.shards[0].pid, 'shard 0 never cools down');
    // Reusable: an avoided agent create re-boots the cooled shard on demand.
    await pool.create({
      sessionId: 'sess_colddown_reuse',
      cwd: root,
      avoidShardIndex: 0,
      agentSession: { agent: 'worker', agentTag: 'w-reuse' },
    });
    assert.ok(pool.status.shards[1].pid, 'the cooled shard re-forks for the next fanout');
    assert.equal(pool.status.shards[1].runtimes, 1);
  } finally {
    await pool.close('shard cold-down test');
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
