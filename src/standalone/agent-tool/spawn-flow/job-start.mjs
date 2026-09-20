/**
 * agent-tool/spawn-flow/job-start.mjs — one agent job as a background task:
 * the immutable owner/caller notify context, resource admission before any
 * agent work, and status publication at start and after terminal settlement.
 */
import { sanitizeTaskMeta, startBackgroundTask } from '../../../runtime/shared/background-tasks.mjs';
import { resourceAdmission } from '../../../runtime/shared/resource-admission.mjs';
import { clean, terminalPidForContext } from '../helpers.mjs';
import { renderResult } from '../render.mjs';

/** The completion callback that hands a worker's result back to its caller session; null without a handoff. */
function handoffNotifier(handoffSessionId, notifySessionCompletion) {
  if (!handoffSessionId || typeof notifySessionCompletion !== 'function') return null;
  return (text, completionMeta = {}) => {
    const meta = completionMeta && typeof completionMeta === 'object' ? completionMeta : {};
    return notifySessionCompletion(handoffSessionId, text, { ...meta, caller_session_id: handoffSessionId });
  };
}

export function createJobStarter({ mgr, notifyStatusChange, notifySessionCompletion }) {
  return function startJob(type, meta, run, notifyContext = null) {
    const clientHostPid = terminalPidForContext(notifyContext);
    const callerSessionId = clean(notifyContext?.callerSessionId || notifyContext?.sessionId);
    const ownerSessionId = clean(notifyContext?.ownerSessionId) || callerSessionId;
    const handoffSessionId = callerSessionId || ownerSessionId;
    const ownerNotifyContext = {
      callerSessionId: callerSessionId || null,
      ownerSessionId: ownerSessionId || null,
      clientHostPid: clientHostPid || null,
      notifyFn: handoffNotifier(handoffSessionId, notifySessionCompletion),
    };
    const jobMeta = sanitizeTaskMeta({
      ...(meta || {}),
      ...(clientHostPid ? { clientHostPid } : {}),
    });
    let task;
    const admissionController = new AbortController();
    task = startBackgroundTask({
      surface: 'agent',
      operation: type,
      label: jobMeta?.tag || jobMeta?.sessionId || type,
      input: { type, tag: jobMeta?.tag || null, sessionId: jobMeta?.sessionId || null, agent: jobMeta?.agent || null },
      context: ownerNotifyContext,
      meta: jobMeta,
      resultType: 'agent_task_result',
      renderResult: (result) => renderResult(result),
      cancel: () => {
        try {
          admissionController.abort(new Error('agent task cancelled before resource admission'));
        } catch {}
        const currentMeta = task?.meta || jobMeta;
        if (currentMeta?.sessionId) {
          try {
            Promise.resolve(mgr.closeSession(currentMeta.sessionId, 'agent-task-cancel')).catch(() => {});
          } catch {}
        }
        setImmediate(notifyStatusChange);
      },
      run: async () => {
        const lease = await resourceAdmission.acquire('agent', {
          signal: admissionController.signal,
          label: jobMeta?.tag || type,
          ownerKey: ownerSessionId || clientHostPid || null,
        });
        try {
          // Yield one macrotask before doing agent work. startBackgroundTask uses
          // a Promise microtask, which otherwise begins CPU-heavy spawn prep
          // before the TUI receives/render the "running" result.
          await new Promise((resolve) => setImmediate(resolve));
          if (task?.status === 'cancelled') return null;
          return await resourceAdmission.runWithLease(lease, () => run(task, ownerNotifyContext));
        } finally {
          await lease.release();
          // startBackgroundTask stamps the terminal state in its next promise
          // continuation; publish after that continuation, not before it.
          setImmediate(notifyStatusChange);
        }
      },
    });
    notifyStatusChange();
    return task;
  };
}
