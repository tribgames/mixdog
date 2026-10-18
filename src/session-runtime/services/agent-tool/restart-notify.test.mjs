import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// One data dir for the file: the pending-message spool resolves it at import.
const root = mkdtempSync(join(tmpdir(), 'mixdog-restart-notify-'));
mkdirSync(join(root, 'sessions'), { recursive: true });
process.env.MIXDOG_DATA_DIR = root;
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { cleanupBackgroundTasks, getBackgroundTask } = await import('../../../runtime/shared/background-tasks.mjs');
const { flushAllIndexWritesSync } = await import('./index-write-queue.mjs');
const { createRestartFailureNotifier, restartNotificationId } = await import('./restart-notify.mjs');
const { createWorkerIndex } = await import('./worker-index.mjs');
const pending = await import('../../../runtime/agent/orchestrator/session/manager/pending-messages.mjs');

let seq = 0;

function workerIndex(dataDir) {
  return createWorkerIndex({
    dataDir,
    cfgMod: { loadConfig: () => ({}) },
    mgr: { getSessionRuntime: () => null },
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
  });
}

/** A fresh worker-index dir holding the given rows, and a distinct Lead. */
function scenario(rows) {
  seq += 1;
  const dataDir = join(root, `case-${seq}`);
  mkdirSync(dataDir, { recursive: true });
  const owner = `lead_restart_${process.pid}_${seq}`;
  const workers = Object.fromEntries(Object.entries(rows).map(([key, extra]) => [key, runningSend(key, owner, extra)]));
  writeFileSync(join(dataDir, 'agent-workers.json'), JSON.stringify({ workers }));
  return { dataDir, owner };
}

const runningSend = (sessionId, owner, extra = {}) => ({
  tag: sessionId,
  sessionId,
  ownerSessionId: owner,
  agent: 'worker',
  status: 'running',
  stage: 'running',
  runtimePid: 0x7fffffff,
  turnStartedAt: new Date(Date.now() - 5_000).toISOString(),
  updatedAt: new Date(Date.now() - 5_000).toISOString(),
  ...extra,
});

const realMgr = {
  markCompletionEntry: pending.markCompletionEntry,
  enqueuePendingMessage: pending.enqueuePendingMessage,
  settlePendingMessageWrites: pending.settlePendingMessageWrites,
};

/** One process: a worker index plus a notifier over the real pending queue. */
function boot(dataDir, { mgr = realMgr, mark } = {}) {
  const index = workerIndex(dataDir);
  const live = [];
  const notify = createRestartFailureNotifier({
    pendingRestartFailures: index.pendingRestartFailures,
    markRestartNotified: mark ? (rows) => mark(rows, index.markRestartNotified) : index.markRestartNotified,
    mgr,
    notifySessionCompletion: (owner, text, meta) => {
      live.push({ owner, text, meta });
      return true;
    },
  });
  return { index, notify, live };
}

/** The process dies: memory is gone, only the spool and worker rows remain. */
async function crash(owner) {
  flushAllIndexWritesSync();
  await pending.settlePendingMessageWrites({ timeoutMs: 4000 });
  pending._dropPendingMessageState(owner, { clearPersisted: false });
  await pending.settlePendingMessageWrites({ timeoutMs: 4000 });
}

async function drainOwner(owner) {
  await pending.hydratePendingMessages(owner);
  const drained = pending.drainPendingMessages(owner);
  await pending.finalizePendingMessageDelivery({ id: owner }, drained, Promise.resolve(), () => {});
  await pending.settlePendingMessageWrites({ timeoutMs: 4000 });
  return drained;
}

async function cleanup(owner) {
  pending._dropPendingMessageState(owner);
  await pending.settlePendingMessageWrites({ timeoutMs: 4000 });
  flushAllIndexWritesSync();
  cleanupBackgroundTasks({ force: true, surface: 'agent' });
}

test('a running send task lost to a restart tells its owner once, under its own task id', async () => {
  const { dataDir, owner } = scenario({ mockup: { task_id: 'task_agent_send_1p' } });
  try {
    const { notify, live, index } = boot(dataDir);
    await notify();
    await notify();

    assert.equal(live.length, 1, 'one live emit per lost task');
    const [entry, ...rest] = await drainOwner(owner);
    assert.equal(rest.length, 0, 'exactly one queued notification');
    assert.match(entry.text, /task_agent_send_1p/);
    assert.match(entry.text, /failed/);
    assert.match(entry.text, /process restart/);
    assert.equal(entry.executionId, 'restart:task_agent_send_1p');
    assert.equal(getBackgroundTask('task_agent_send_1p')?.status, 'failed');
    assert.ok(index.readAllWorkerRows().every((row) => row.restartNotified));

    // A second restart finds the row already reported.
    await crash(owner);
    cleanupBackgroundTasks({ force: true, surface: 'agent' });
    const next = boot(dataDir);
    await next.notify();
    assert.deepEqual(next.live, []);
    assert.deepEqual(await drainOwner(owner), []);
  } finally {
    await cleanup(owner);
  }
});

test('a crash between the durable enqueue and the mark still delivers exactly once after restart', async () => {
  const { dataDir, owner } = scenario({ mockup: { task_id: 'task_agent_crash_1p' } });
  try {
    // First process: the notification is spooled, then it dies before the stamp.
    const first = boot(dataDir, {
      mark: () => {
        throw new Error('process died before the mark');
      },
    });
    await first.notify();
    assert.equal(
      first.index.readAllWorkerRows().find((row) => row.sessionId === 'mockup').restartNotified ?? null,
      null,
      'the row was never stamped'
    );
    await crash(owner);

    // Second process: the row is still pending, so the same id is re-enqueued.
    const second = boot(dataDir);
    assert.equal(second.index.pendingRestartFailures().length, 1);
    await second.notify();
    await second.notify();
    assert.equal(second.index.pendingRestartFailures().length, 0);

    const drained = await drainOwner(owner);
    assert.equal(drained.length, 1, 'one notification despite two enqueues');
    assert.match(drained[0].text, /task_agent_crash_1p/);
    assert.deepEqual(await drainOwner(owner), []);
  } finally {
    await cleanup(owner);
  }
});

test('an enqueue that throws, is refused or does not reach the spool leaves the row retryable', async () => {
  const { dataDir, owner } = scenario({ a: { task_id: 'task_agent_retry_a' }, b: { task_id: 'task_agent_retry_b' } });
  try {
    let calls = 0;
    const flaky = {
      ...realMgr,
      // First row: the enqueue throws. Later rows pass.
      enqueuePendingMessage(...args) {
        calls += 1;
        if (calls === 1) throw new Error('queue unavailable');
        return realMgr.enqueuePendingMessage(...args);
      },
    };
    const first = boot(dataDir, { mgr: flaky });
    await first.notify();
    const stillPending = first.index.pendingRestartFailures();
    assert.equal(stillPending.length, 1, 'only the failed row stays pending');
    assert.equal(stillPending[0].task_id, 'task_agent_retry_a');

    // Refused (0) and unsettled spool writes are failures too.
    const refused = boot(dataDir, { mgr: { ...realMgr, enqueuePendingMessage: () => 0 } });
    await refused.notify();
    assert.equal(refused.index.pendingRestartFailures().length, 1);
    const unsettled = boot(dataDir, { mgr: { ...realMgr, settlePendingMessageWrites: async () => false } });
    await unsettled.notify();
    assert.equal(unsettled.index.pendingRestartFailures().length, 1);

    // The next pass delivers it, once.
    await first.notify();
    assert.equal(first.index.pendingRestartFailures().length, 0);
    const drained = await drainOwner(owner);
    assert.deepEqual(drained.map((entry) => entry.executionId).sort(), [
      'restart:task_agent_retry_a',
      'restart:task_agent_retry_b',
    ]);
  } finally {
    await cleanup(owner);
  }
});

test('a row without a task id still gets a stable notification id', () => {
  const row = { sessionId: 'sess_x', finishedAt: '2026-10-18T17:50:04.000Z' };
  assert.equal(restartNotificationId(row), restartNotificationId({ ...row }));
  assert.notEqual(
    restartNotificationId(row),
    restartNotificationId({ ...row, finishedAt: '2026-10-18T18:00:00.000Z' })
  );
});

test('a quiet turn left by a predecessor that is still shutting down fails instead of resting', async () => {
  // The predecessor's pid is alive during the successor's boot, and its turn
  // made no progress for minutes: recovery must not call that an idle worker.
  const { dataDir, owner } = scenario({
    quiet: {
      task_id: 'task_agent_quiet_1',
      runtimePid: process.ppid,
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    },
  });
  try {
    const { index, notify } = boot(dataDir);
    const row = index.readAllWorkerRows().find((entry) => entry.sessionId === 'quiet');
    assert.equal(row.status, 'failed');
    assert.equal(row.failureReason, 'process-restart');
    await notify();
    assert.equal((await drainOwner(owner)).length, 1);
  } finally {
    await cleanup(owner);
  }
});

test('a row the predecessor fails on its way out is reported by a later sweep', async () => {
  const { dataDir, owner } = scenario({
    fresh: { task_id: 'task_agent_fresh_1', runtimePid: process.ppid, updatedAt: new Date().toISOString() },
  });
  try {
    const { index, notify, live } = boot(dataDir);
    await notify();
    assert.deepEqual(live, [], "a fresh live row is still its predecessor's work");

    // The predecessor's exit flush settles it after the successor's boot.
    index.writeWorkerRows((byKey) => {
      byKey.set('fresh', {
        ...byKey.get('fresh'),
        status: 'failed',
        stage: 'failed',
        failureReason: 'process-restart',
      });
    });
    await notify();
    await notify();
    assert.equal(live.length, 1);
    assert.equal((await drainOwner(owner)).length, 1);
  } finally {
    await cleanup(owner);
  }
});
