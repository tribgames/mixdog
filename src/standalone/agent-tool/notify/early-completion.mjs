// The early (header-only) agent-task completion preview: the running→completed
// transition a Lead sees before the worker's session is persisted. The
// body-carrying delivery stays with the canonical notifyTaskCompletion; owner
// delivery itself is injected as `notifyOwner` from ../notify.mjs.
import { toolCompletionInstruction } from '../../../runtime/shared/tool-execution-contract.mjs';
import { renderBackgroundTask, sanitizeTaskMeta } from '../../../runtime/shared/background-tasks.mjs';
import { clean } from '../helpers.mjs';

export function createEarlyCompletionNotice({ notifyOwner }) {
  return function notifyOwnerAgentCompletionEarly(job, resultValue, notifyContext = {}) {
    if (!job || job._earlyCompletionNotified === true) return false;
    const ownerSessionId = clean(
      notifyContext?.callerSessionId || notifyContext?.sessionId || notifyContext?.ownerSessionId
    );
    const finishedAt = new Date().toISOString();
    // An abnormal-empty finish carries an `error` — the early preview must NOT
    // present it as a benign `completed` card, or the Lead sees success before
    // the later `failed` reconcile lands. Mirror the terminal status/instruction.
    const earlyStatus = resultValue?.error ? 'failed' : 'completed';
    const snapshot = {
      ...job,
      status: earlyStatus,
      finishedAt,
      finishedAtMs: Date.now(),
      result: resultValue,
      resultType: job.resultType || 'agent_task_result',
      meta: sanitizeTaskMeta(job.meta || {}),
      ...(resultValue?.error ? { error: resultValue.error } : {}),
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
      model_visible: false,
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
  };
}
