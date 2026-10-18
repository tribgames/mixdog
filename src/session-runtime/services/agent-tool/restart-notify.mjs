// agent-tool/restart-notify.mjs
// Agent tasks live in process memory, so a daemon restart ends every in-flight
// one without a word: the successor only sees worker rows left `failed`
// (process-restart). This tells each task's owner, exactly once.
//
// Order is what makes it safe: the failure notification is enqueued in the
// owner's persisted pending queue under a stable id (`restart:<taskId>`) and
// flushed to the spool FIRST; only then is the row stamped `restartNotified`.
// A crash or a throw before the stamp leaves the row retryable, and the retry
// re-enqueues the same id — the queue is id-idempotent, so the owner still
// sees it once.
import {
  acknowledgeBackgroundTaskCompletion,
  completeBackgroundTask,
  getBackgroundTask,
  registerBackgroundTask,
} from '../../../runtime/shared/background-tasks.mjs';
import { renderAgentCompletionEnvelope } from '../../../runtime/shared/task-notification-envelope.mjs';
import { modelVisibleToolCompletionMessage } from '../../../runtime/shared/tool-execution-contract.mjs';
import { clean } from './helpers.mjs';

const RESTART_FAILURE_ERROR = 'process restart: the daemon restarted while this agent task was running';
const SETTLE_TIMEOUT_MS = 5000;

/** Stable dedup id of one lost task's notification. A row that never recorded
 *  a task id falls back to its session and settle time. */
export function restartNotificationId(row) {
  return `restart:${clean(row.task_id) || `${clean(row.sessionId)}:${clean(row.finishedAt)}`}`;
}

/** `pendingRestartFailures()` lists rows whose owner is not yet told;
 *  `markRestartNotified(rows)` stamps them. `mgr` supplies the persisted
 *  pending queue (enqueuePendingMessage / markCompletionEntry /
 *  settlePendingMessageWrites). `notifySessionCompletion` is only the live,
 *  best-effort emit to attached surfaces after the durable enqueue. */
export function createRestartFailureNotifier({
  pendingRestartFailures,
  markRestartNotified,
  mgr,
  notifySessionCompletion,
}) {
  function enqueueDurably(row) {
    const owner = clean(row.ownerSessionId);
    const executionId = restartNotificationId(row);
    const meta = {
      type: 'agent_task_result',
      execution_surface: 'agent',
      execution_id: executionId,
      status: 'failed',
      caller_session_id: owner,
    };
    const text = renderAgentCompletionEnvelope({
      id: clean(row.task_id) || executionId,
      tag: row.tag,
      status: 'failed',
      error: RESTART_FAILURE_ERROR,
    });
    const entry = mgr.markCompletionEntry(modelVisibleToolCompletionMessage(text, meta), { executionId, meta });
    return { owner, text, meta, entry };
  }

  // Lets `agent status <id>` resolve after the restart; best-effort.
  function registerFailedTask(row) {
    const taskId = clean(row.task_id);
    if (!taskId || getBackgroundTask(taskId)) return;
    const owner = clean(row.ownerSessionId);
    registerBackgroundTask({
      taskId,
      surface: 'agent',
      operation: 'restart',
      label: row.tag,
      input: { type: 'restart', tag: row.tag, sessionId: row.sessionId, agent: row.agent || null },
      context: { callerSessionId: owner, ownerSessionId: owner, clientHostPid: row.clientHostPid || null },
      meta: {
        tag: row.tag,
        sessionId: row.sessionId,
        agent: row.agent || null,
        provider: row.provider || null,
        model: row.model || null,
        preset: row.preset || null,
        effort: row.effort || null,
      },
      resultType: 'agent_task_result',
    });
    completeBackgroundTask(taskId, {
      status: 'failed',
      error: RESTART_FAILURE_ERROR,
      terminalReason: 'process-restart',
      notify: false,
    });
    acknowledgeBackgroundTaskCompletion(taskId);
  }

  async function notifyRow(row) {
    const { owner, text, meta, entry } = enqueueDurably(row);
    if (!(mgr.enqueuePendingMessage(owner, entry) > 0)) throw new Error(`restart notification refused for ${owner}`);
    if (!(await mgr.settlePendingMessageWrites({ timeoutMs: SETTLE_TIMEOUT_MS }))) {
      throw new Error(`restart notification for ${owner} did not reach the spool`);
    }
    markRestartNotified([row]);
    try {
      registerFailedTask(row);
    } catch {
      /* status lookup only */
    }
    try {
      // Same execution id as the queued entry: the queue dedups the mirror.
      notifySessionCompletion?.(owner, text, meta);
    } catch {
      /* the durable queue is authoritative */
    }
  }

  let inFlight = null;
  async function run() {
    for (const row of pendingRestartFailures()) {
      try {
        await notifyRow(row);
      } catch (err) {
        // Not stamped: the next pass or restart retries this row.
        process.stderr.write(`[agent-tool] restart notification retry pending: ${err?.message || err}\n`);
      }
    }
  }

  return function notifyRestartFailures() {
    inFlight ||= run()
      .catch((err) => process.stderr.write(`[agent-tool] restart notification pass failed: ${err?.message || err}\n`))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
