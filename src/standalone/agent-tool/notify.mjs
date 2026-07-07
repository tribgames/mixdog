// Owner/worker completion-notification helpers, extracted from the agent-tool
// facade as a factory so the mgr-bound closures stay per agent instance.
// Behavior-preserving: bodies identical to the originals; deps injected.
import { modelVisibleToolCompletionMessage } from '../../runtime/shared/tool-execution-contract.mjs';
import { renderBackgroundTask, sanitizeTaskMeta, setBackgroundTaskEnqueueFallback } from '../../runtime/shared/background-tasks.mjs';
import { markCompletionEntry } from '../../runtime/agent/orchestrator/session/manager/pending-messages.mjs';
import { clean } from './helpers.mjs';

export function createNotify(mgr) {
  function enqueueCompletionMessage(sessionId, text, meta = {}) {
    const target = clean(sessionId);
    if (!target || typeof mgr.enqueuePendingMessage !== 'function') return false;
    try {
      const visible = modelVisibleToolCompletionMessage(text, meta);
      if (!visible) return false;
      // Mark this as a deferred completion/task notification so a later session
      // resume drops it rather than replaying it out-of-order (owner decision).
      return Boolean(mgr.enqueuePendingMessage(target, markCompletionEntry(visible)) > 0);
    } catch {
      return false;
    }
  }

  // Wire the canonical completion fallback to this agent surface's owner-session
  // enqueue so notifyTaskCompletion can deliver via callerSessionId when no
  // notifyFn is present or it declines. Registered once per agent (the closure
  // captures mgr); signatures align: (callerSessionId, message, meta).
  setBackgroundTaskEnqueueFallback((sessionId, text, meta) => enqueueCompletionMessage(sessionId, text, meta));

  function workerNotifyFn(workerSessionId, notifyContext = {}) {
    const workerId = clean(workerSessionId);
    const ownerSessionId = clean(notifyContext?.callerSessionId || notifyContext?.sessionId);
    const upstream = typeof notifyContext?.notifyFn === 'function' ? notifyContext.notifyFn : null;
    return (text, meta = {}) => {
      let ownerDelivered = false;
      if (upstream) {
        try {
          const result = upstream(text, meta);
          ownerDelivered = result !== false;
          if (ownerDelivered) Promise.resolve(result).catch(() => {});
        } catch {
          ownerDelivered = false;
        }
      }
      if (!ownerDelivered && ownerSessionId) {
        ownerDelivered = enqueueCompletionMessage(ownerSessionId, text, meta);
      }
      const workerDelivered = workerId && workerId !== ownerSessionId
        ? enqueueCompletionMessage(workerId, text, meta)
        : ownerDelivered;
      return ownerSessionId ? ownerDelivered : workerDelivered;
    };
  }

  function notifyOwnerAgentCompletionEarly(job, resultValue, notifyContext = {}) {
    if (!job || job._earlyCompletionNotified === true) return false;
    const ownerSessionId = clean(notifyContext?.callerSessionId || notifyContext?.sessionId);
    const upstream = typeof notifyContext?.notifyFn === 'function' ? notifyContext.notifyFn : null;
    const finishedAt = new Date().toISOString();
    // An abnormal-empty finish carries an `error` — the early preview must NOT
    // present it as a benign `completed` card, or the Lead sees success before
    // the later `failed` reconcile lands. Mirror the terminal status/instruction.
    const earlyStatus = resultValue && resultValue.error ? 'failed' : 'completed';
    const snapshot = {
      ...job,
      status: earlyStatus,
      finishedAt,
      finishedAtMs: Date.now(),
      result: resultValue,
      resultType: job.resultType || 'agent_task_result',
      meta: sanitizeTaskMeta(job.meta || {}),
      ...(resultValue && resultValue.error ? { error: resultValue.error } : {}),
    };
    // An early notification is only a header-only *preview*: it fires before
    // the worker's session is persisted to signal the running→completed
    // transition. It deliberately carries NO result body — the canonical
    // notifyTaskCompletion delivers the body exactly once via the
    // reconcile/finally path, so omitting it here keeps notifications
    // exact-once with no duplicate body.
    const text = renderBackgroundTask(snapshot, { includeResult: false });
    const meta = {
      type: snapshot.resultType,
      execution_surface: 'agent',
      execution_id: job.taskId || null,
      status: earlyStatus,
      instruction: `The async agent task ${job.taskId || ''} has finished (${earlyStatus}) - review this result in your next step.`,
      ...(ownerSessionId ? { caller_session_id: ownerSessionId } : {}),
    };
    let delivered = false;
    if (upstream) {
      try {
        const result = upstream(text, meta);
        delivered = result !== false;
        if (delivered) Promise.resolve(result).catch(() => {});
      } catch {
        delivered = false;
      }
    }
    if (!delivered && ownerSessionId) {
      delivered = enqueueCompletionMessage(ownerSessionId, text, meta);
    }
    if (delivered) {
      // Mark only that a header-only preview fired. The canonical
      // notifyTaskCompletion still owns the single body-carrying notification.
      job._earlyCompletionNotified = true;
    }
    return delivered;
  }

  return { enqueueCompletionMessage, workerNotifyFn, notifyOwnerAgentCompletionEarly };
}
