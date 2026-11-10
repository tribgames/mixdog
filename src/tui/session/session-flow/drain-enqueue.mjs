/**
 * src/tui/session/session-flow/drain-enqueue.mjs - idempotent intake of the
 * unified prompt queue (drain.mjs): admission fence, duplicate submissions,
 * notification keys, task-wait wakes and the durable steering mirror.
 */
import { isQueuedEntryEditable, isQueuedEntryVisible } from '../queue-helpers.mjs';
import { appendTuiSteeringPersist } from '../tui-steering-persist.mjs';

export function createEnqueue({
  admission,
  tuiDebug,
  flags,
  pending,
  pendingNotificationKeys,
  getState,
  set,
  flushEmitImmediate,
  getRuntime,
  queue,
  steering,
  submissions,
  drain,
}) {
  return function enqueue(text, options = {}) {
    // Admission fence. While closing, only user prompts are accepted (retained
    // so a failed close loses nothing); notification-driven/model-visible
    // enqueues are refused. A closed session accepts nothing.
    const state = admission();
    const mode = options.mode || 'prompt';
    if (state !== 'open' && (state === 'terminal' || mode !== 'prompt')) {
      tuiDebug(`enqueue refused: session admission=${state} mode=${mode}`);
      return false;
    }
    const submissionId = String(options.id || '').trim();
    // Idempotent intake: a transport that re-sent this exact submission (its
    // first attempt landed but the response was lost) must not double-post.
    if (submissionId && submissions.has(submissionId)) {
      tuiDebug(`prompt-duplicate id=${submissionId} ignored`);
      // This is an idempotent success, not a rejected submit. Returning false
      // makes Desktop restore and retry a message that is already queued.
      return true;
    }
    const entry = queue.makeQueueEntry(text, options);
    if (entry.mode === 'task-notification' && entry.key) {
      if (pendingNotificationKeys.has(entry.key)) return false;
      pendingNotificationKeys.add(entry.key);
    }
    submissions.remember(submissionId);
    pending.push(entry);
    // Typed input or a deliverable notification ends a passive task wait or
    // shell hold so the next boundary hands it to the model now.
    const wake = steering.taskWaitWakeForEntry(entry);
    if (wake) {
      try {
        getRuntime()?.interruptTaskWait?.(wake, wake === 'notification' ? entry.execution?.id || null : null);
      } catch {}
    }
    const needsDurableSteering =
      (getState().busy || getState().commandBusy || flags.autoClearRunning || flags.quotaResumePending) &&
      steering.shouldMirrorSteeringEntry(entry);
    const persistence = needsDurableSteering ? appendTuiSteeringPersist(steering.leadSessionId(), entry) : null;
    if (isQueuedEntryVisible(entry)) {
      set({ queued: [...getState().queued, entry] });
      if (isQueuedEntryEditable(entry)) flushEmitImmediate?.();
    }
    const queueAgeMs = Math.max(0, Date.now() - Number(entry.submittedAt || Date.now()));
    tuiDebug(`prompt-queued id=${String(entry.id)} busy=${getState().busy ? 1 : 0} ageMs=${queueAgeMs}`);
    if (getState().busy) tuiDebug(`busy-queue enqueue mode=${entry.mode} pending=${pending.length}`);
    void drain();
    if (options.awaitPersistence === true && persistence) {
      return Promise.resolve(persistence).then((persisted) => {
        if (persisted !== false) return true;
        const index = pending.indexOf(entry);
        // A turn already took the prompt while its durable mirror was being
        // written: it was delivered, so rejecting it would hand the sender a
        // copy of a message the model already has.
        if (index < 0) return true;
        pending.splice(index, 1);
        queue.removeQueuedEntries([entry]);
        if (submissionId) submissions.forget(submissionId);
        return false;
      });
    }
    return true;
  };
}
