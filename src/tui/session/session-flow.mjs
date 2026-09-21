/**
 * src/tui/session/session-flow.mjs - prompt queue drain + session clear/reset.
 * Assembles the queue, steering, drain-loop, auto-clear and session-reset
 * responsibilities over one shared TUI bag.
 */
import { createSubmissionMemory, createQueueOps } from './session-flow/queue.mjs';
import { createSteeringOps } from './session-flow/steering.mjs';
import { createDrainLoop } from './session-flow/drain.mjs';
import { createAutoClearOps } from './session-flow/auto-clear.mjs';
import { createSessionResetOps } from './session-flow/session-reset.mjs';

export function createSessionFlow(bag) {
  const submissions = createSubmissionMemory();
  // Drain is created last (it depends on every other group); callers that
  // only need to kick it go through this deferred reference.
  const kickDrain = () => void loop.drain();
  const reset = createSessionResetOps(bag);
  const queue = createQueueOps(bag, { kickDrain });
  const steering = createSteeringOps(bag, { queue, submissions });
  const autoClear = createAutoClearOps(bag, { reset, kickDrain });
  const loop = createDrainLoop(bag, {
    queue,
    steering,
    submissions,
    flushDeferredClearedSessionUi: autoClear.flushDeferredClearedSessionUi,
  });

  return {
    leadSessionId: steering.leadSessionId,
    shouldMirrorSteeringEntry: steering.shouldMirrorSteeringEntry,
    commitSteeringQueueEntries: steering.commitSteeringQueueEntries,
    settleSteeredSubmissions: steering.settleSteeredSubmissions,
    makeQueueEntry: queue.makeQueueEntry,
    removeQueuedEntries: queue.removeQueuedEntries,
    requeueEntriesFront: queue.requeueEntriesFront,
    dequeueQueueBatch: queue.dequeueQueueBatch,
    drain: loop.drain,
    enqueue: loop.enqueue,
    drainPendingSteering: steering.drainPendingSteering,
    restoreLeadSteeringFromDisk: steering.restoreLeadSteeringFromDisk,
    autoClearBeforeSubmit: autoClear.autoClearBeforeSubmit,
    performAutoClear: autoClear.performAutoClear,
    restoreQueued: queue.restoreQueued,
    prioritizeQueued: queue.prioritizeQueued,
    resetStats: reset.resetStats,
    clearUiActivityBeforeContextSync: reset.clearUiActivityBeforeContextSync,
    resetTuiForPendingSessionReset: reset.resetTuiForPendingSessionReset,
    snapshotTuiBeforeSessionReset: reset.snapshotTuiBeforeSessionReset,
    restoreTuiAfterFailedSessionReset: reset.restoreTuiAfterFailedSessionReset,
    commitTuiSessionReset: reset.commitTuiSessionReset,
    resetStatsAndSyncContext: reset.resetStatsAndSyncContext,
  };
}
