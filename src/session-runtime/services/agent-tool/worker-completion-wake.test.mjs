// Import before runtime modules: data paths are captured at module load.
import '../../../runtime/agent/orchestrator/tools/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import { createNotify } from './notify.mjs';
import { createSendFlow } from './send-flow.mjs';
import { renderShellCompletionEnvelope } from '../../../runtime/shared/task-notification-envelope.mjs';
import {
  enqueuePendingMessage,
  markCompletionEntry,
} from '../../../runtime/agent/orchestrator/session/manager/pending-messages.mjs';
import { beginInterruptibleTaskWait } from '../../../runtime/agent/orchestrator/session/task-wait-control.mjs';

const completionText = (jobId) =>
  renderShellCompletionEnvelope({ jobId, status: 'completed', exitCode: 0, command: 'npm test', result: 'ok' });

test('a background completion queued for a worker asks to wake it', async () => {
  const queued = [];
  const woken = [];
  const notify = createNotify(
    { enqueuePendingMessage: (sessionId, entry) => queued.push([sessionId, entry]) },
    { onWorkerCompletionQueued: (sessionId) => woken.push(sessionId) }
  );
  const delivered = notify.workerNotifyFn('sess_worker_1')(completionText('job_wake_1'), {
    execution_id: 'job_wake_1',
    execution_surface: 'shell',
    status: 'completed',
  });
  assert.equal(delivered, true);
  assert.equal(queued[0][0], 'sess_worker_1');
  await tick();
  assert.deepEqual(woken, ['sess_worker_1']);
});

function sendFlowHarness({ busy }) {
  const jobs = [];
  const session = { id: 'sess_worker_2', ownerSessionId: 'sess_lead', agent: 'worker', clientHostPid: 7 };
  const flow = createSendFlow({
    mgr: { getSession: (id) => (id === session.id ? session : null) },
    defaultCwd: process.cwd(),
    sessionSurface: null,
    canUseSessionSurface: () => false,
    registry: { tagForSession: () => 'w2' },
    views: { isSessionBusy: () => busy, renderJob: () => ({}) },
    spawnFlow: {
      startJob: (type, meta, _run, notifyContext) => {
        jobs.push({ type, meta, notifyContext });
        return { id: 'job' };
      },
    },
  });
  return { flow, jobs };
}

test('an idle worker is woken with a follow-up turn whose answer goes to its owner', async () => {
  const { flow, jobs } = sendFlowHarness({ busy: false });
  assert.equal(flow.wakeIdleWorker('sess_worker_2'), true);
  await tick();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, 'send');
  assert.equal(jobs[0].notifyContext.callerSessionId, 'sess_lead');
});

test('a busy worker is not woken: it takes the completion at its next tool boundary', async () => {
  const { flow, jobs } = sendFlowHarness({ busy: true });
  assert.equal(flow.wakeIdleWorker('sess_worker_2'), false);
  await tick();
  assert.equal(jobs.length, 0);
});

test('a completion or steering queued for an agent ends its passive wait', () => {
  const notified = beginInterruptibleTaskWait('sess_sub_steer');
  const steered = beginInterruptibleTaskWait('sess_sub_steer_2');
  try {
    enqueuePendingMessage('sess_sub_steer', markCompletionEntry(completionText('job_wake_3')));
    assert.equal(notified.signal.aborted, true);
    assert.equal(notified.interruptedByUser, false);
    assert.equal(notified.wakeReason, 'notification');
    assert.equal(notified.wakeDetail, 'job_wake_3');
    enqueuePendingMessage('sess_sub_steer_2', 'Lead: also run the lint');
    assert.equal(steered.signal.aborted, true);
    assert.equal(steered.interruptedByUser, true);
    const next = beginInterruptibleTaskWait('sess_sub_steer_2');
    assert.equal(next.signal.aborted, true, 'input already queued ends a later hold at once');
    assert.equal(next.wakeReason, 'user-message');
    next.dispose();
  } finally {
    notified.dispose();
    steered.dispose();
  }
});
