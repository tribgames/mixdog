import assert from 'node:assert/strict';
import { availableParallelism, freemem } from 'node:os';
import test from 'node:test';

import { createKeyedSingleflight } from '../src/runtime/agent/orchestrator/mcp/reconnect-singleflight.mjs';
import { isParallelDispatchable } from '../src/runtime/agent/orchestrator/session/loop/tool-helpers.mjs';
import { withBuiltinPathLocks } from '../src/runtime/agent/orchestrator/tools/builtin/path-locks.mjs';
import { _resolvePwshPoolTarget } from '../src/runtime/agent/orchestrator/tools/lib/pwsh-standby-pool.mjs';
import { _rgThreadCap } from '../src/runtime/agent/orchestrator/tools/builtin/rg-runner.mjs';

test('daemon pwsh pool scales with CPU and free memory while explicit policy wins', () => {
  const daemonEnv = { MIXDOG_ENGINE_DAEMON_HOST: '1' };
  const liveCpuTarget = Math.max(1, Math.min(4, availableParallelism() - 1 || 1));
  const liveFree = freemem();
  const liveExpected = liveFree < 768 * 1024 ** 2
    ? 0
    : liveFree < 1536 * 1024 ** 2
      ? Math.min(1, liveCpuTarget)
      : liveFree < 3072 * 1024 ** 2
        ? Math.min(2, liveCpuTarget)
        : liveCpuTarget;
  assert.equal(_resolvePwshPoolTarget({
    env: daemonEnv,
    platform: 'win32',
  }), liveExpected, 'omitted memory sample must use live host memory instead of zero');
  assert.equal(_resolvePwshPoolTarget({
    env: daemonEnv,
    platform: 'win32',
    parallelism: 16,
    freeMemoryBytes: 8 * 1024 ** 3,
  }), 4);
  assert.equal(_resolvePwshPoolTarget({
    env: daemonEnv,
    platform: 'win32',
    parallelism: 16,
    freeMemoryBytes: 2 * 1024 ** 3,
  }), 2);
  assert.equal(_resolvePwshPoolTarget({
    env: daemonEnv,
    platform: 'win32',
    parallelism: 16,
    freeMemoryBytes: 512 * 1024 ** 2,
  }), 0);
  assert.equal(_resolvePwshPoolTarget({
    env: {},
    platform: 'win32',
    parallelism: 16,
    freeMemoryBytes: 8 * 1024 ** 3,
  }), 0);
  assert.equal(_resolvePwshPoolTarget({
    env: { MIXDOG_PWSH_STANDBY_POOL: '8' },
    platform: 'win32',
    parallelism: 2,
    freeMemoryBytes: 1,
  }), 8);
});

test('rg keeps every call dispatchable while shrinking per-process threads under fanout', () => {
  const prior = process.env.MIXDOG_RG_THREADS;
  delete process.env.MIXDOG_RG_THREADS;
  try {
    const one = _rgThreadCap(1);
    const four = _rgThreadCap(4);
    const many = _rgThreadCap(64);
    assert.ok(one >= four);
    assert.ok(four >= many);
    assert.equal(many, 1);
  } finally {
    if (prior === undefined) delete process.env.MIXDOG_RG_THREADS;
    else process.env.MIXDOG_RG_THREADS = prior;
  }
});

test('keyed reconnect singleflight collapses peers without coupling servers', async () => {
  const singleflight = createKeyedSingleflight();
  let leftRuns = 0;
  let rightRuns = 0;
  const left = Array.from({ length: 16 }, () => singleflight.run('left', async () => {
    leftRuns += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 'left-ready';
  }));
  const right = singleflight.run('right', async () => {
    rightRuns += 1;
    return 'right-ready';
  });
  assert.deepEqual(await Promise.all(left), Array(16).fill('left-ready'));
  assert.equal(await right, 'right-ready');
  assert.equal(leftRuns, 1);
  assert.equal(rightRuns, 1);
  assert.equal(singleflight.size, 0);

  await assert.rejects(
    Promise.all(Array.from({ length: 4 }, () => singleflight.run('fail', async () => {
      throw new Error('reconnect failed');
    }))),
    /reconnect failed/,
  );
  assert.equal(singleflight.size, 0);
});

test('every valid tool is parallel-dispatchable, including path-scoped patches', () => {
  for (const name of ['read', 'grep', 'shell', 'code_graph', 'explore', 'apply_patch']) {
    assert.equal(isParallelDispatchable(name), true, name);
  }
});

test('path locks serialize only real conflicts and let disjoint writes overlap', async () => {
  const leftGate = Promise.withResolvers();
  const rightGate = Promise.withResolvers();
  const started = [];
  const left = withBuiltinPathLocks(['C:\\repo\\left.txt'], async () => {
    started.push('left');
    await leftGate.promise;
  });
  const right = withBuiltinPathLocks(['C:\\repo\\right.txt'], async () => {
    started.push('right');
    await rightGate.promise;
  });
  await Promise.resolve();
  assert.deepEqual(new Set(started), new Set(['left', 'right']));
  leftGate.resolve();
  rightGate.resolve();
  await Promise.all([left, right]);

  const firstGate = Promise.withResolvers();
  const sameStarted = [];
  const first = withBuiltinPathLocks(['C:\\repo\\same.txt'], async () => {
    sameStarted.push('first');
    await firstGate.promise;
  });
  const second = withBuiltinPathLocks(['c:\\repo\\same.txt'], async () => {
    sameStarted.push('second');
  });
  await Promise.resolve();
  assert.deepEqual(sameStarted, ['first']);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(sameStarted, ['first', 'second']);
});
