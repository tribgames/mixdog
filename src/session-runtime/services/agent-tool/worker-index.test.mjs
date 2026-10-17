import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listStoredAgentWorkers } from '../../../runtime/agent/orchestrator/session/store-summary-reader.mjs';
import {
  _touchRuntime,
  beginSessionApprovalWait,
  getSessionRuntime,
} from '../../../runtime/agent/orchestrator/session/manager/runtime-liveness.mjs';
import { flushAllIndexWritesSync } from './index-write-queue.mjs';
import { createWorkerIndex } from './worker-index.mjs';
import { settledWorkerStatus } from './worker-index/row-liveness.mjs';

function readPersistedWorkers(root) {
  flushAllIndexWritesSync(); // the index persists through an async writer queue
  return JSON.parse(readFileSync(join(root, 'agent-workers.json'), 'utf8'));
}

function workerIndex(root, mgr = { getSessionRuntime: () => null }) {
  return createWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    mgr,
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
  });
}

function writeWorkers(root, workers) {
  writeFileSync(join(root, 'agent-workers.json'), JSON.stringify({ workers }));
}

function withDataDir(prefix, run) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    run(root);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const runningRow = (sessionId, extra = {}) => ({
  tag: sessionId,
  sessionId,
  ownerSessionId: 'lead-a',
  agent: 'worker',
  status: 'running',
  stage: 'running',
  runtimePid: process.pid,
  turnStartedAt: new Date(Date.now() - 1_000).toISOString(),
  updatedAt: new Date().toISOString(),
  ...extra,
});

const workerSession = (id) => ({ id, agentTag: id, ownerSessionId: 'lead-a', agent: 'worker' });

/** A live runtime entry whose current turn started now. */
function liveRuntime(id) {
  const entry = _touchRuntime(id);
  entry.askStartedAt = Date.now();
  return entry;
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

    // The turn never finished: a failure with its reason, not a rest.
    const stored = readPersistedWorkers(root);
    assert.equal(stored.workers.crashed.status, 'failed');
    assert.equal(stored.workers.crashed.stage, 'failed');
    assert.equal(stored.workers.crashed.failureReason, 'process-restart');
    assert.equal(stored.workers.crashed.turnStartedAt, null);
    assert.equal(stored.workers.live.status, 'running');

    // The pool keeps the failed row visible, with its reason.
    const pool = listStoredAgentWorkers({ runningSessionIds: new Set(['live']) });
    const crashed = pool.find((row) => row.sessionId === 'crashed');
    assert.equal(crashed?.status, 'failed');
    assert.equal(crashed?.failureReason, 'process-restart');
    assert.equal(pool.find((row) => row.sessionId === 'live')?.status, 'running');
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery keeps a long turn that is still in flight in this daemon and settles a stalled one', () => {
  withDataDir('mixdog-worker-recover-inflight-', (root) => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    writeWorkers(root, {
      long: runningRow('long', { turnStartedAt: old, updatedAt: old }),
      stalled: runningRow('stalled', { turnStartedAt: old, updatedAt: old }),
    });
    workerIndex(root, {
      getSessionRuntime: () => null,
      isSessionTurnInFlight: (sessionId) => sessionId === 'long',
    }).dispose();
    const { workers } = readPersistedWorkers(root);
    assert.equal(workers.long.status, 'running');
    assert.equal(workers.stalled.status, 'idle');
  });
});

test('a turn this process still runs at exit settles as failed, and new work clears the reason', () => {
  withDataDir('mixdog-worker-exit-failed-', (root) => {
    const index = workerIndex(root);
    try {
      index.upsertWorkerRow(runningRow('busy'));
      index.flushActiveWorkerRows();
      const exited = readPersistedWorkers(root).workers.busy;
      assert.equal(exited.status, 'failed');
      assert.equal(exited.failureReason, 'process-restart');
      // A later whole-row write for new work carries no stale reason.
      index.upsertWorkerRow(runningRow('busy'));
      const rerun = readPersistedWorkers(root).workers.busy;
      assert.equal(rerun.status, 'running');
      assert.equal(rerun.failureReason, null);
    } finally {
      index.dispose();
    }
  });
});

test('a watchdog stop settles the worker row as failed (stalled); any other outcome keeps its status', () => {
  assert.deepEqual(settledWorkerStatus('idle', true), { status: 'failed', stage: 'failed', failureReason: 'stalled' });
  assert.deepEqual(settledWorkerStatus('error', false), { status: 'error', stage: 'error' });
  assert.deepEqual(settledWorkerStatus('idle', false), { status: 'idle', stage: 'idle' });
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
    const inFlight = { runningSessionIds: new Set(['asking']) };
    assert.equal(listStoredAgentWorkers(inFlight).find((row) => row.sessionId === 'asking')?.awaitingUser, 'approval');
    // A session without a worker row (the Lead's own approval) writes nothing.
    assert.equal(index.setAwaitingUser('lead-only', 'approval'), false);
    beginSessionApprovalWait('lead-only')();

    release();
    assert.equal('awaitingUser' in readPersistedWorkers(root).workers.asking, false);
    assert.equal('awaitingUser' in listStoredAgentWorkers(inFlight).find((row) => row.sessionId === 'asking'), false);

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
      // The daemon died mid-approval: its row settles as failed and the wait drops.
      crashed: row('crashed', { status: 'running', stage: 'running', runtimePid: 0x7fffffff }),
      // A settled row from a dead runtime still holding the flag.
      settled: row('settled', { status: 'idle', stage: 'idle', runtimePid: 0x7fffffff }),
      // This process's own live wait survives another runtime booting.
      live: row('live', { status: 'running', stage: 'running', runtimePid: process.pid }),
    });

    workerIndex(root).dispose();

    const { workers } = readPersistedWorkers(root);
    assert.equal(workers.crashed.status, 'failed');
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

test('two indexes on one file: an approval wait never overwrites the other index final status', () => {
  withDataDir('mixdog-worker-approval-shared-', (root) => {
    writeWorkers(root, { shared: runningRow('shared') });
    const first = workerIndex(root);
    const second = workerIndex(root);
    liveRuntime('shared');

    const release = beginSessionApprovalWait('shared');
    assert.equal(readPersistedWorkers(root).workers.shared.awaitingUser, 'approval');
    // Both indexes serialize through one projection: the other sees the wait.
    assert.equal(second.readAllWorkerRows().find((row) => row.sessionId === 'shared')?.awaitingUser, 'approval');
    // A non-final refresh by the other index keeps the wait.
    second.upsertWorkerSession(workerSession('shared'), 'shared', { status: 'running', stage: 'tool_running' });
    assert.equal(readPersistedWorkers(root).workers.shared.awaitingUser, 'approval');
    // Its final status drops it, and the later clear never rewrites the row.
    second.upsertWorkerSession(workerSession('shared'), 'shared', { status: 'completed', stage: 'completed' });
    release();

    const stored = readPersistedWorkers(root).workers.shared;
    assert.equal(stored.status, 'completed');
    assert.equal(stored.stage, 'completed');
    assert.equal('awaitingUser' in stored, false);
    assert.equal(first.readAllWorkerRows().find((row) => row.sessionId === 'shared')?.status, 'completed');
    first.dispose();
    second.dispose();
  });
});

test('a row created after its wait began takes the wait from the owning runtime (reconciliation)', () => {
  withDataDir('mixdog-worker-approval-reconcile-', (root) => {
    writeWorkers(root, { missed: runningRow('missed', { awaitingUser: 'approval' }) });
    const index = workerIndex(root, { getSessionRuntime });
    liveRuntime('late');

    // The wait begins while the spawn's row is still in the deferred batch.
    const release = beginSessionApprovalWait('late');
    index.upsertWorkerSessionDeferred(workerSession('late'), 'late', {
      status: 'running',
      stage: 'running',
      turnStartedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    index.flushWorkerIndexMutations();
    assert.equal(readPersistedWorkers(root).workers.late.awaitingUser, 'approval');
    release();
    assert.equal('awaitingUser' in readPersistedWorkers(root).workers.late, false);

    // A flag whose clear was missed heals on the owner's next refresh.
    liveRuntime('missed');
    index.upsertWorkerSession(workerSession('missed'), 'missed', { status: 'running', stage: 'streaming' });
    const healed = readPersistedWorkers(root).workers.missed;
    assert.equal(healed.stage, 'streaming');
    assert.equal('awaitingUser' in healed, false);
    index.dispose();
  });
});

test('a stale full-row write does not resurrect a cleared approval wait', () => {
  withDataDir('mixdog-worker-approval-stale-row-', (root) => {
    writeWorkers(root, { stale: runningRow('stale') });
    const index = workerIndex(root);
    liveRuntime('stale');

    const release = beginSessionApprovalWait('stale');
    const snapshot = index.readAllWorkerRows().find((row) => row.sessionId === 'stale');
    assert.equal(snapshot.awaitingUser, 'approval');
    release();

    index.upsertWorkerRow({ ...snapshot, stage: 'tool_running' });
    index.writeWorkerRows((byKey) => byKey.set('stale', { ...snapshot, stage: 'tool_running', messages: 7 }));
    const projected = index.readAllWorkerRows().find((row) => row.sessionId === 'stale');
    assert.equal('awaitingUser' in projected, false);
    const stored = readPersistedWorkers(root).workers.stale;
    assert.equal(stored.stage, 'tool_running');
    assert.equal(stored.messages, 7);
    assert.equal('awaitingUser' in stored, false);
    index.dispose();
  });
});

test('approval transitions are fenced to their turn and re-checked against the locked file', () => {
  withDataDir('mixdog-worker-approval-fence-', (root) => {
    const olderTurn = Date.now() - 10_000;
    const currentTurn = Date.now() - 5_000;
    writeWorkers(root, { fenced: runningRow('fenced', { turnStartedAt: new Date(currentTurn).toISOString() }) });
    const index = workerIndex(root);

    // A begin or clear of an older turn never touches the newer turn's row.
    assert.equal(index.setAwaitingUser('fenced', 'approval', { turnAt: olderTurn }), false);
    assert.equal('awaitingUser' in readPersistedWorkers(root).workers.fenced, false);
    assert.equal(index.setAwaitingUser('fenced', 'approval', { turnAt: currentTurn }), true);
    assert.equal(index.setAwaitingUser('fenced', null, { turnAt: olderTurn }), false);
    assert.equal(readPersistedWorkers(root).workers.fenced.awaitingUser, 'approval');
    assert.equal(index.setAwaitingUser('fenced', null, { turnAt: currentTurn }), true);
    assert.equal('awaitingUser' in readPersistedWorkers(root).workers.fenced, false);

    // Another process moves the row to a newer turn before the begin persists:
    // the begin is re-checked on disk and only ever touches the one field.
    assert.equal(index.setAwaitingUser('fenced', 'approval', { turnAt: currentTurn }), true);
    writeWorkers(root, {
      fenced: runningRow('fenced', { stage: 'streaming', turnStartedAt: new Date().toISOString() }),
    });
    const stored = readPersistedWorkers(root).workers.fenced;
    assert.equal(stored.stage, 'streaming');
    assert.equal('awaitingUser' in stored, false);
    index.dispose();
  });
});

test('the pool never trusts a running worker row the daemon does not report in flight', () => {
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

    // A row that claims to be running without the daemon's in-flight answer is
    // reported as `unknown`, not as idle or running: the row alone is not
    // evidence of either.
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
    // The turn dies with the process: a failure, not a rest.
    assert.equal(stored.workers['exit-worker'].status, 'failed');
    assert.equal(stored.workers['exit-worker'].stage, 'failed');
    assert.equal(stored.workers['exit-worker'].failureReason, 'process-restart');
    assert.equal(stored.workers['exit-worker'].turnStartedAt, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
