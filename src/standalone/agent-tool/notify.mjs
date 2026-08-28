// Owner/worker completion-notification helpers, extracted from the agent-tool
// facade as a factory so the mgr-bound closures stay per agent instance.
// Behavior-preserving: bodies identical to the originals; deps injected.
import { modelVisibleToolCompletionMessage, toolCompletionInstruction } from '../../runtime/shared/tool-execution-contract.mjs';
import { renderBackgroundTask, sanitizeTaskMeta } from '../../runtime/shared/background-tasks.mjs';
import { markCompletionEntry } from '../../runtime/agent/orchestrator/session/manager/pending-messages.mjs';
import { isDeliveredCompletion, logDuplicateSkip } from '../../runtime/agent/orchestrator/session/manager/delivered-completions.mjs';
import { clean } from './helpers.mjs';

export function createNotify(mgr, { notifySessionCompletion } = {}) {
  function enqueueCompletionMessage(sessionId, text, meta = {}) {
    const target = clean(sessionId);
    if (!target || typeof mgr.enqueuePendingMessage !== 'function') return false;
    try {
      const visible = modelVisibleToolCompletionMessage(text, meta);
      if (!visible) return false;
      // Skip-if-delivered: the TUI already injected + ACKed this completion
      // body into the active loop, so this racing enqueue (fallback/reconcile
      // or the async reject/false-resolve rescue) would double-inject it.
      // Report DELIVERED (truthy), not false — a false return propagates through
      // tryEnqueueFallback→onSettled(false), which un-marks notified/
      // notifiedWithBody (background-tasks.mjs) and makes reconcile refire
      // forever, eventually enqueuing a post-eviction duplicate. Suppressed here
      // == already delivered, so the caller must mark it notified and stop.
      if (isDeliveredCompletion({ executionId: meta?.execution_id, text: visible })) {
        logDuplicateSkip('notify-enqueue', { executionId: meta?.execution_id, text: visible });
        return true;
      }
      // Mark this as a deferred completion/task notification so a later session
      // resume drops it rather than replaying it out-of-order (owner decision).
      return Boolean(mgr.enqueuePendingMessage(target, markCompletionEntry(visible, {
        executionId: meta?.execution_id,
      })) > 0);
    } catch {
      return false;
    }
  }

  function notifyOwner(ownerSessionId, text, meta = {}) {
    const owner = clean(ownerSessionId);
    if (!owner || typeof notifySessionCompletion !== 'function') return false;
    const ownerMeta = {
      ...(meta && typeof meta === 'object' ? meta : {}),
      caller_session_id: owner,
    };
    delete ownerMeta.routing_session_id;
    try { return notifySessionCompletion(owner, text, ownerMeta) !== false; }
    catch { return false; }
  }

  function workerNotifyFn(workerSessionId, notifyContext = {}) {
    const workerId = clean(workerSessionId);
    return (text, meta = {}) => {
      // Tool completions produced inside a Subagent belong to that Subagent's
      // session. Mirroring them to the owner made every promoted shell command
      // appear as a second Lead-level completion card. Agent task completion
      // has its own owner delivery path below; only that terminal handoff
      // crosses the parent boundary.
      return workerId ? enqueueCompletionMessage(workerId, text, meta) : false;
    };
  }

  function notifyOwnerAgentCompletionEarly(job, resultValue, notifyContext = {}) {
    if (!job || job._earlyCompletionNotified === true) return false;
    const ownerSessionId = clean(
      notifyContext?.callerSessionId
      || notifyContext?.sessionId
      || notifyContext?.ownerSessionId
    );
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
      instruction: toolCompletionInstruction({
        surface: 'agent',
        id: job.taskId || '',
        status: earlyStatus,
      }),
      ...(ownerSessionId ? { caller_session_id: ownerSessionId } : {}),
    };
    const delivered = notifyOwner(ownerSessionId, text, meta);
    if (delivered) {
      // Mark only that a header-only preview fired. The canonical
      // notifyTaskCompletion still owns the single body-carrying notification.
      job._earlyCompletionNotified = true;
    }
    return delivered;
  }

  return { enqueueCompletionMessage, workerNotifyFn, notifyOwnerAgentCompletionEarly };
}
