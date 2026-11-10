/**
 * src/tui/session/session-flow/drain-closed-queue.mjs - settling the queue of a
 * session whose canonical close completed (drain.mjs admission `terminal`).
 */
import { dropTuiSteeringPersist } from '../tui-steering-persist.mjs';

export function createClosedQueueSettler({
  pending,
  pendingNotificationKeys,
  clearBlockedDrainRetry,
  queue,
  steering,
  submissions,
}) {
  // Canonical close settled: nothing queued can ever run. Every accepted
  // submission is settled explicitly (rejected), never silently dropped, and
  // its durable steering mirror is released so a restart cannot resurrect it
  // into the closed conversation.
  return function settleClosedQueue() {
    const entries = pending.splice(0);
    pendingNotificationKeys.clear();
    clearBlockedDrainRetry();
    if (entries.length === 0) return;
    queue.removeQueuedEntries(entries);
    const mirrored = entries.filter((entry) => steering.shouldMirrorSteeringEntry(entry) && entry.steeringPersistId);
    if (mirrored.length > 0) {
      void Promise.resolve(dropTuiSteeringPersist(steering.leadSessionId(), mirrored)).catch(() => {});
    }
    for (const entry of entries) {
      if (entry.id) submissions.forget(entry.id);
      try {
        entry.onSettled?.({ status: 'rejected', reason: 'session-closed', result: null, session: null });
      } catch {
        // A throwing callback must not leave the remaining entries unsettled.
      }
    }
  };
}
