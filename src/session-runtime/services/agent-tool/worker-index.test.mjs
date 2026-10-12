import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listStoredAgentWorkers } from '../../../runtime/agent/orchestrator/session/store-summary-reader.mjs';
import {
  _touchRuntime,
  beginSessionApprovalWait,
} from '../../../runtime/agent/orchestrator/session/manager/runtime-liveness.mjs';
import { flushAllIndexWritesSync } from './index-write-queue.mjs';
import { createWorkerIndex } from './worker-index.mjs';

function readPersistedWorkers(root) {
  flushAllIndexWritesSync(); // the index persists through an async writer queue
  return JSON.parse(readFileSync(join(root, 'agent-workers.json'), 'utf8'));
}

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

    const stored = readPersistedWorkers(root);
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

test('an approval wait is persisted on the worker row and reaches the pool only while it lasts', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-worker-approval-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    const now = new Date().toISOString();
    const running = {
      ownerSessionId: 'lead-a',
      agent: 'worker',
      status: 'running',
      stage: 'running',
      runtimePid: process.pid,
      turnStartedAt: now,
      updatedAt: now,
    };
    writeWorkers(root, { asking: { tag: 'asking', sessionId: 'asking', ...running } });
    const index = workerIndex(root);
    _touchRuntime('asking');
    _touchRuntime('lead-only');

    const release = beginSessionApprovalWait('asking');
    assert.equal(readPersistedWorkers(root).workers.asking.awaitingUser, 'approval');
    assert.equal(listStoredAgentWorkers().find((row) => row.sessionId === 'asking')?.awaitingUser, 'approval');
    // A session without a worker row (the Lead's own approval) writes nothing.
    assert.equal(index.setAwaitingUser('lead-only', 'approval'), false);
    beginSessionApprovalWait('lead-only')();

    release();
    assert.equal('awaitingUser' in readPersistedWorkers(root).workers.asking, false);
    assert.equal('awaitingUser' in listStoredAgentWorkers().find((row) => row.sessionId === 'asking'), false);

    // A terminal settlement never carries a wait forward, whoever wrote it.
    const releaseAgain = beginSessionApprovalWait('asking');
    index.upsertWorkerSession({ id: 'asking', agentTag: 'asking', ownerSessionId: 'lead-a' }, 'asking', {
      status: 'idle',
      stage: 'idle',
    });
    assert.equal('awaitingUser' in readPersistedWorkers(root).workers.asking, false);
    releaseAgain();
    index.dispose();
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup recovery clears an approval wait left by a runtime that is gone', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-worker-approval-recover-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    const now = new Date().toISOString();
    const row = (sessionId, extra) => ({
      tag: sessionId,
      sessionId,
      ownerSessionId: 'lead-a',
      agent: 'worker',
      awaitingUser: 'approval',
      turnStartedAt: now,
      updatedAt: now,
      ...extra,
    });
    writeWorkers(root, {
      // The daemon died mid-approval: its row is idled and the wait dropped.
      crashed: row('crashed', { status: 'running', stage: 'running', runtimePid: 0x7fffffff }),
      // A settled row from a dead runtime still holding the flag.
      settled: row('settled', { status: 'idle', stage: 'idle', runtimePid: 0x7fffffff }),
      // This process's own live wait survives another runtime booting.
      live: row('live', { status: 'running', stage: 'running', runtimePid: process.pid }),
    });

    workerIndex(root).dispose();

    const { workers } = readPersistedWorkers(root);
    assert.equal(workers.crashed.status, 'idle');
    assert.equal('awaitingUser' in workers.crashed, false);
    assert.equal(workers.settled.status, 'idle');
    assert.equal('awaitingUser' in workers.settled, false);
    assert.equal(workers.live.awaitingUser, 'approval');
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

    // A row that claims to be running with no fresh heartbeat is reported as
    // `unknown`, not as idle: the cold reader cannot see the runtime, so it
    // states that rather than asserting a settled state it never observed.
    const row = listStoredAgentWorkers().find((entry) => entry.sessionId === 'stale');
    assert.equal(row?.status, 'unknown');
    assert.equal(row?.stage, 'unknown');
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
    index.upsertWorkerSessionDeferred(
      {
        id: 'exit-worker',
        ownerSessionId: 'lead-a',
        agentTag: 'exit-worker',
        agent: 'worker',
        createdAt: new Date().toISOString(),
      },
      'exit-worker',
      {
        status: 'running',
        stage: 'running',
        turnStartedAt: new Date().toISOString(),
      }
    );

    index.flushWorkerIndexOnExit();

    const stored = readPersistedWorkers(root);
    assert.equal(stored.workers['exit-worker'].status, 'idle');
    assert.equal(stored.workers['exit-worker'].stage, 'idle');
    assert.equal(stored.workers['exit-worker'].turnStartedAt, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
