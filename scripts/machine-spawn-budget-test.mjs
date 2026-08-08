// Machine-wide child-spawn budget. Session shards forward spawn acquires as
// IPC leases to the daemon-side pool, whose own child-spawn-gate instance is
// the single machine authority — the per-shard semaphore multiplication
// (8 shards × cap 4 = 32 scanners) collapses back to one budget. Transport
// loss and the kill switch degrade to the bounded local lane.
process.env.MIXDOG_CHILD_SPAWN_SEARCH_MAX_INFLIGHT = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { createSessionRuntimePool, chooseShardIndex } = await import('../src/standalone/session-runtime-pool.mjs');

const FIXTURE_WORKER = fileURLToPath(new URL('./fixtures/spawn-lease-fixture-worker.mjs', import.meta.url));
const CHILD_HARNESS = fileURLToPath(new URL('./fixtures/spawn-lease-child-harness.mjs', import.meta.url));

function waitFor(predicate, message, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error(`timeout: ${message}`)); return; }
      setTimeout(tick, 25).unref?.();
    };
    tick();
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('shard leases queue on the daemon-side machine gate (cap 1)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-spawn-budget-'));
  const pool = createSessionRuntimePool({
    shardCount: 1,
    workerEntry: FIXTURE_WORKER,
    cwd: root,
    env: { ...process.env, SPAWN_LEASE_FIXTURE_DIR: root },
  });
  try {
    await pool.prewarm(); // boots the fixture child (generic ok responder)
    await waitFor(() => existsSync(join(root, 'lease-a-granted')), 'lease A granted');
    await delay(600);
    assert.ok(!existsSync(join(root, 'lease-b-granted')),
      'lease B stays queued behind the machine cap of 1');
    await waitFor(() => existsSync(join(root, 'lease-b-granted')),
      'lease B granted once A releases');
    assert.ok(!existsSync(join(root, 'lease-a-rejected')));
    assert.ok(!existsSync(join(root, 'lease-b-rejected')));
  } finally {
    await pool.close('spawn budget test');
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function runHarness(env, onLease) {
  const child = fork(CHILD_HARNESS, [], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const events = [];
  const leases = [];
  const releases = [];
  child.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'harness-event') events.push(message.event);
    if (message.type === 'spawn-lease') {
      leases.push(message);
      onLease?.(child, message);
    }
    if (message.type === 'spawn-release') releases.push(message);
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return { child, events, leases, releases, exited };
}

test('shard-mode acquire round-trips the lease protocol end to end', async () => {
  const harness = runHarness({ MIXDOG_SESSION_SHARD: '1' }, (child, message) => {
    child.send({ type: 'spawn-lease-result', leaseId: message.leaseId, ok: true });
  });
  await harness.exited;
  assert.deepEqual(harness.events, ['granted', 'released']);
  assert.equal(harness.leases.length, 1, 'exactly one lease request');
  assert.equal(harness.leases[0].lane, 'search');
  assert.equal(harness.releases.length, 1, 'release travels back to the pool');
  assert.equal(harness.releases[0].leaseId, harness.leases[0].leaseId);
});

test('the kill switch keeps shard acquires on the local lane', async () => {
  const harness = runHarness({
    MIXDOG_SESSION_SHARD: '1',
    MIXDOG_DISABLE_MACHINE_SPAWN_BUDGET: '1',
  });
  await harness.exited;
  assert.deepEqual(harness.events, ['granted', 'released'], 'local lane still admits');
  assert.equal(harness.leases.length, 0, 'no lease request leaves the process');
});

test('placement prefers the least-busy live shard and spills past the caps', () => {
  const alive = (busy, resident = 1) => ({ alive: true, busy, resident });
  const cold = { alive: false, busy: 0, resident: 0 };
  // Live hash shard always wins, busy or not.
  assert.equal(chooseShardIndex({ hashIndex: 1, shards: [alive(0), alive(2, 4)] }), 1);
  // Cold hash: least busy live shard wins; resident count breaks ties.
  assert.equal(chooseShardIndex({ hashIndex: 2, shards: [alive(1), alive(0), cold] }), 1);
  assert.equal(chooseShardIndex({ hashIndex: 2, shards: [alive(1, 3), alive(1, 2), cold] }), 1);
  // Busy cap: a shard running 2+ turns no longer absorbs cold-hash creates.
  assert.equal(chooseShardIndex({ hashIndex: 2, shards: [alive(2), alive(2), cold] }), 2);
  // Resident cap unchanged.
  assert.equal(chooseShardIndex({ hashIndex: 2, shards: [alive(0, 4), alive(0, 4), cold] }), 2);
});
