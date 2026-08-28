import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listStoredAgentWorkers } from '../../runtime/agent/orchestrator/session/store-summary-reader.mjs';
import { createWorkerIndex } from './worker-index.mjs';

function workerIndex(root) {
  return createWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    mgr: { getSessionRuntime: () => null },
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
  });
}

function writeWorkers(root, workers) {
  writeFileSync(join(root, 'agent-workers.json'), JSON.stringify({ workers }));
}

test('worker boot recovery settles a running row whose runtime died', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-worker-recover-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    const now = Date.now();
    writeWorkers(root, {
      crashed: {
        tag: 'crashed',
        sessionId: 'crashed',
        ownerSessionId: 'lead-a',
        agent: 'worker',
        status: 'running',
        stage: 'running',
        runtimePid: 0x7fffffff,
        turnStartedAt: new Date(now - 5_000).toISOString(),
        updatedAt: new Date(now - 5_000).toISOString(),
      },
      live: {
        tag: 'live',
        sessionId: 'live',
        ownerSessionId: 'lead-a',
        agent: 'worker',
        status: 'running',
        stage: 'running',
        runtimePid: process.pid,
        turnStartedAt: new Date(now - 5_000).toISOString(),
        updatedAt: new Date(now - 5_000).toISOString(),
      },
    });

    workerIndex(root);

    const stored = JSON.parse(readFileSync(join(root, 'agent-workers.json'), 'utf8'));
    assert.equal(stored.workers.crashed.status, 'idle');
    assert.equal(stored.workers.crashed.stage, 'idle');
    assert.equal(stored.workers.crashed.turnStartedAt, null);
    assert.equal(stored.workers.live.status, 'running');

    const pool = listStoredAgentWorkers();
    assert.equal(pool.find((row) => row.sessionId === 'crashed')?.status, 'idle');
    assert.equal(pool.find((row) => row.sessionId === 'live')?.status, 'running');
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('cold pool reader does not trust an expired running worker row', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-worker-cold-stale-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    const old = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    writeWorkers(root, {
      stale: {
        tag: 'stale',
        sessionId: 'stale',
        ownerSessionId: 'lead-a',
        agent: 'worker',
        status: 'running',
        stage: 'running',
        turnStartedAt: old,
        updatedAt: old,
      },
    });

    const row = listStoredAgentWorkers().find((entry) => entry.sessionId === 'stale');
    assert.equal(row?.status, 'idle');
    assert.equal(row?.stage, 'idle');
    assert.equal(row?.turnStartedAt, null);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker exit flush commits queued state before settling active work', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-worker-exit-flush-'));
  try {
    mkdirSync(join(root, 'sessions'));
    const index = workerIndex(root);
    index.upsertWorkerSessionDeferred({
      id: 'exit-worker',
      ownerSessionId: 'lead-a',
      agentTag: 'exit-worker',
      agent: 'worker',
      createdAt: new Date().toISOString(),
    }, 'exit-worker', {
      status: 'running',
      stage: 'running',
      turnStartedAt: new Date().toISOString(),
    });

    index.flushWorkerIndexOnExit();

    const stored = JSON.parse(readFileSync(join(root, 'agent-workers.json'), 'utf8'));
    assert.equal(stored.workers['exit-worker'].status, 'idle');
    assert.equal(stored.workers['exit-worker'].stage, 'idle');
    assert.equal(stored.workers['exit-worker'].turnStartedAt, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
