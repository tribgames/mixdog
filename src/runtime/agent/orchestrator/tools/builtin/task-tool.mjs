// Generic background-task tool (status/wait/cancel).
import {
  buildJobNotFoundMessage,
  isShellJobRunning,
  peekShellJob,
  killShellJob,
  otherSessionBackgroundShellJobCount,
  cancelBackgroundShellJobWatch,
  clearShellJobNotifyCtx,
  shellJobPublicTaskResult,
  shellJobTaskStatus,
  waitForShellJob,
  waitShellJobTerminated,
} from './shell-jobs.mjs';
import { beginSessionTaskWait } from '../../session/manager/runtime-liveness.mjs';
import { TASK_WAIT_TIMEOUT_DEFAULT_MS, TASK_WAIT_TIMEOUT_MAX_MS, TASK_WAIT_TIMEOUT_MIN_MS } from './builtin-tools.mjs';
import { AGENT_TASK_WAIT_DEFAULT_MS } from './wait-budgets.mjs';
import { getAbortSignalForSession } from '../../session/abort-lookup.mjs';
import { TASK_WAIT_WAKE_NOTIFICATION, beginInterruptibleTaskWait } from '../../session/task-wait-control.mjs';
import {
  acknowledgeBackgroundTaskCompletion,
  cancelBackgroundTask,
  completeBackgroundTask,
  getBackgroundTask,
  registerBackgroundTask,
  renderBackgroundTask,
  renderBackgroundTaskList,
} from '../../../../shared/background-tasks.mjs';
import { recordDeliveredCompletion } from '../../session/manager/delivered-completions.mjs';
import { listShellJobRecords, readShellJobRecord } from './lib/shell-job-records.mjs';
import { resourceAdmission } from '../../../../shared/resource-admission.mjs';
import { readShellTaskOutput } from './lib/shell-task-output.mjs';

// Ceiling for confirming that a cancelled task's process really exited. The
// wait returns the moment the native task settles, so this only bounds a
// process that ignores the kill.
const TASK_CANCEL_CONFIRM_MS = 5_000;
// Ceiling for confirming that every process the task started is gone once its
// root exited: a sweep is a table read, the kill and a second read (each read
// ~1-2 s on Windows).
const TASK_CANCEL_TREE_CONFIRM_MS = 15_000;

function cancelPendingText(taskId) {
  return [
    'status: cancel-pending',
    `task_id: ${taskId}`,
    'the kill was sent and the command itself exited, but processes it started are still alive. They keep being terminated and stay tracked (the folder stays held) until they are gone; re-run task cancel or task read to check again.',
  ].join('\n');
}

function recoveredTaskMatches(record, options = {}) {
  const context =
    options?.context && typeof options.context === 'object' ? { ...options.context, ...options } : options;
  const sessionIds = new Set(
    [context?.callerSessionId, context?.routingSessionId, context?.sessionId].filter(Boolean).map(String)
  );
  const clientHostPid = Number(context?.clientHostPid) || null;
  if (sessionIds.size === 0 && !clientHostPid) return true;
  if (!record?.ownerSessionId && !record?.ownerHostPid) return true;
  // A caller WITH session identity is authorized by session identity ONLY.
  // In a pooled host every pane shares one claude.exe pid, so the host pid
  // can neither widen a session mismatch nor stand in for a record that
  // never recorded an owner session — both kept other panes' commands and
  // results visible. The pid path remains for callers that have no session
  // identity at all, where it is the only identity available.
  if (sessionIds.size > 0) {
    return Boolean(record.ownerSessionId) && sessionIds.has(String(record.ownerSessionId));
  }
  return Boolean(clientHostPid && Number(record.ownerHostPid) === clientHostPid);
}

function refreshShellTask(taskId, { includeRunning = false } = {}) {
  const job = peekShellJob(taskId);
  if (!job) return null;
  const publicResult = shellJobPublicTaskResult(job);
  if (job.status !== 'running') {
    completeBackgroundTask(taskId, {
      // Same mapping as the completion notification, so a non-zero exit
      // reads as a completed task in both surfaces.
      status: shellJobTaskStatus(job),
      result: publicResult,
      resultText: JSON.stringify(publicResult, null, 2),
      notify: false,
    });
  } else if (includeRunning) {
    const task = getBackgroundTask(taskId);
    if (task) {
      task.result = publicResult;
      task.resultText = JSON.stringify(publicResult, null, 2);
    }
  }
  return job;
}

function renderTaskCancelSuccess(taskId, task) {
  const surface = task?.surface || 'task';
  const operation = task?.operation || 'run';
  return ['status: completed', `task_id: ${taskId}`, `cancelled: ${surface}/${operation}`].join('\n');
}

// Clamp lives next to the caller; the bounds themselves are published by the
// tool schema, so an out-of-range request is corrected rather than rejected.
function resolveTaskWaitTimeoutMs(value, defaultMs = TASK_WAIT_TIMEOUT_DEFAULT_MS) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return defaultMs;
  return Math.min(TASK_WAIT_TIMEOUT_MAX_MS, Math.max(TASK_WAIT_TIMEOUT_MIN_MS, Math.floor(raw)));
}

// Agents run on the 5 m prompt cache, so their default wakes before it lapses;
// the Lead keeps the 1 h cache and the longer default.
async function defaultTaskWaitMs(sessionId) {
  if (!sessionId) return TASK_WAIT_TIMEOUT_DEFAULT_MS;
  const { getSession } = await import('../../session/manager.mjs');
  const session = getSession(String(sessionId));
  const agentOwned = session?.owner === 'agent' || session?.visibility === 'agent-only';
  return agentOwned ? AGENT_TASK_WAIT_DEFAULT_MS : TASK_WAIT_TIMEOUT_DEFAULT_MS;
}

// Read-only counts of this runtime's shell work owned by OTHER sessions.
// Admission is runtime-wide while task list/cancel are session-scoped, so
// without this those holders are invisible. Counts only: another session's
// command text is never shown.
function otherSessionShellHolders(options) {
  const context =
    options?.context && typeof options.context === 'object' ? { ...options.context, ...options } : options;
  const mine = new Set(
    [context?.callerSessionId, context?.routingSessionId, context?.sessionId].filter(Boolean).map(String)
  );
  if (mine.size === 0) return '';
  const leases = (resourceAdmission.snapshot().activeLeases || []).filter(
    (lease) => lease.kind === 'shell' && !mine.has(String(lease.ownerKey || ''))
  ).length;
  const jobs = otherSessionBackgroundShellJobCount(mine);
  if (!leases && !jobs) return '';
  return `[other sessions in this runtime] ${leases} foreground shell lease(s), ${jobs} background shell job(s) — read-only; only their owner sessions can cancel them.`;
}

async function listTasks(options) {
  const rendered = renderBackgroundTaskList({ context: options });
  const liveIds = new Set([...rendered.matchAll(/^-\s+(\S+)/gm)].map((match) => match[1]));
  const recovered = (await listShellJobRecords()).filter(
    (record) => recoveredTaskMatches(record, options) && !liveIds.has(record.jobId)
  );
  const sections = [rendered];
  if (recovered.length > 0) {
    const rows = recovered.map(
      (record) =>
        `- ${record.jobId} shell ${record.terminal ? record.status : 'state-unavailable'} recovered=true command=${JSON.stringify(record.command || '')}`
    );
    sections.push(`[recovered shell tasks]\n${rows.join('\n')}`);
  }
  const others = otherSessionShellHolders(options);
  if (others) sections.push(others);
  return sections.join('\n');
}

// Ceiling hits per still-running task, so a wait that keeps timing out on the
// same job can suggest a different move. Keyed by the task object, so the count
// goes with the task however it settles or is removed.
const waitCeilingHits = new WeakMap();

// Blocks until the shell task settles, the timeout elapses, the turn is
// cancelled, or anything deliverable is queued for this session (user input,
// steering, or any task notification: an agent or another shell job
// finishing). Returns what cut the wait short.
async function waitForShellTask(task, taskId, args, options) {
  // The turn's abort signal must cut the wait short; a cancelled turn
  // cannot sit out the remaining ceiling.
  let turnSignal = null;
  try {
    turnSignal = (await getAbortSignalForSession(options?.sessionId)) || null;
  } catch {
    turnSignal = null;
  }
  const waitControl = beginInterruptibleTaskWait(options?.sessionId, turnSignal);
  const releaseWaitState = beginSessionTaskWait(options?.sessionId);
  const waitSignal = waitControl.signal;
  const waitTimeoutMs = resolveTaskWaitTimeoutMs(args.timeout_ms, await defaultTaskWaitMs(options?.sessionId));
  let interruptedByUser = false;
  let notified = false;
  let notifiedTaskId = null;
  try {
    // A shell task whose descendants outlived the shell process has no
    // native job to subscribe to — the process it belonged to is gone.
    // Its registry promise (resolved by the descendant observer) is the
    // completion event in that case.
    if (!peekShellJob(taskId) && task.status === 'running' && task.promise) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, waitTimeoutMs);
        timer.unref?.();
        const done = () => {
          clearTimeout(timer);
          if (waitSignal) {
            try {
              waitSignal.removeEventListener('abort', done);
            } catch {}
          }
          resolve();
        };
        task.promise.then(done, done);
        if (waitSignal) {
          if (waitSignal.aborted) done();
          else waitSignal.addEventListener('abort', done, { once: true });
        }
      });
    } else {
      await waitForShellJob(taskId, {
        timeoutMs: waitTimeoutMs,
        signal: waitSignal,
      });
    }
  } finally {
    interruptedByUser = waitControl.interruptedByUser;
    notified = waitControl.wakeReason === TASK_WAIT_WAKE_NOTIFICATION;
    notifiedTaskId = waitControl.wakeDetail;
    waitControl.dispose();
    releaseWaitState();
  }
  return { interruptedByUser, notified, notifiedTaskId };
}

// Outcome of a shell cancel: `outcome` is 'cancelled' only when the process is
// confirmed gone (or never had one), 'unconfirmed' when the kill was delivered
// but the exit could not be confirmed, 'not-found' for an unknown task.
async function cancelShellTaskOutcome(task, taskId, options) {
  // A tracked task with no native job is still cancellable: the
  // registry's own cancel hook owns it (descendants that outlived
  // their shell). Remember that it WAS live so the outcome is
  // reported as a cancellation rather than "task not found".
  const wasRunning = task.status === 'running';
  // A tracked tree outlives the native task's cache entry: its own
  // termination watch, not the native task, confirms the stop.
  const trackedTree = isShellJobRunning(taskId);
  const job = killShellJob(taskId);
  if (job) {
    // Confirm the process actually terminated before reporting a
    // terminal status. Removing the watcher on the strength of a
    // delivered signal left a live, unmonitored process behind a
    // false 'cancelled'.
    const confirmed = await waitForShellJob(taskId, { timeoutMs: TASK_CANCEL_CONFIRM_MS });
    if (confirmed && confirmed.status === 'running') {
      // Watcher and notify context stay armed: the eventual exit
      // must still reach the owner.
      return {
        outcome: 'unconfirmed',
        text: [
          'status: cancel-unconfirmed',
          `task_id: ${taskId}`,
          'the cancellation was delivered but the process has not exited yet. It stays tracked and its completion is still delivered; re-run task cancel or task read to check again.',
        ].join('\n'),
      };
    }
    // The root exited; what it started outside its process group is swept
    // by the job's termination watch. Cancelled means all of it is gone.
    if ((confirmed || trackedTree) && !(await waitShellJobTerminated(taskId, TASK_CANCEL_TREE_CONFIRM_MS))) {
      return { outcome: 'unconfirmed', text: cancelPendingText(taskId) };
    }
    if (!confirmed && !trackedTree) {
      // No terminal event and no observable task: absence of
      // state is not proof of termination. Stop tracking it so it
      // cannot hang as 'running' forever, but never claim it died.
      cancelBackgroundShellJobWatch(taskId);
      clearShellJobNotifyCtx(taskId);
      cancelBackgroundTask(taskId, 'cancelled by task control; termination unconfirmed');
      return {
        outcome: 'unconfirmed',
        text: [
          'status: cancel-unconfirmed',
          `task_id: ${taskId}`,
          'the cancellation was delivered but this task is no longer observable, so its termination could not be confirmed. Verify the process directly if it must be gone.',
        ].join('\n'),
      };
    }
  }
  cancelBackgroundShellJobWatch(taskId);
  clearShellJobNotifyCtx(taskId);
  cancelBackgroundTask(taskId, 'cancelled by task control');
  // A task whose own cancel hook kills (what a finished command left running)
  // reports what that kill confirmed.
  const hookKill = await task.cancelOutcome;
  if (hookKill && hookKill.terminated !== true) return { outcome: 'unconfirmed', text: cancelPendingText(taskId) };
  return job || wasRunning
    ? {
        outcome: 'cancelled',
        text: renderTaskCancelSuccess(taskId, getBackgroundTask(taskId, { context: options }) || task),
      }
    : { outcome: 'not-found', text: buildJobNotFoundMessage(taskId) };
}

async function cancelShellTask(task, taskId, options) {
  return (await cancelShellTaskOutcome(task, taskId, options)).text;
}

/**
 * Stop one BACKGROUND shell job of the caller's session (desktop stop button).
 * The same cancel the `task` tool runs, with a structured answer: `stopped` is
 * true only when the job was actually cancelled. Only promoted/async jobs hold
 * a background task, so a foreground command can never match; the session
 * scope is the caller's, so another session's job reads as unknown.
 */
export async function stopBackgroundShellJob(taskId, options = {}) {
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  if (!id) return { stopped: false, error: 'task_id is required' };
  const task = getBackgroundTask(id, { context: options });
  if (!task || task.surface !== 'shell') return { stopped: false, error: `task not found: ${id}` };
  const job = peekShellJob(id);
  const status = job ? job.status : task.status;
  // A root that exited while tracked descendants run is still stoppable.
  if (status !== 'running' && !isShellJobRunning(id)) return { stopped: false, error: `task already ${status}: ${id}` };
  try {
    const { outcome, text } = await cancelShellTaskOutcome(task, id, options);
    if (outcome === 'cancelled') return { stopped: true };
    return {
      stopped: false,
      error: outcome === 'unconfirmed' ? `cancellation not confirmed: ${id}` : text.replace(/^Error:\s*/, ''),
    };
  } catch (error) {
    return { stopped: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function executeTaskTool(args, options = {}) {
  const action = typeof args.action === 'string' ? args.action.toLowerCase() : '';
  if (!action) return 'Error: task action is required';
  if (action === 'list') return await listTasks(options);

  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
  if (!taskId) return 'Error: task_id is required';
  // sess_* values are agent/orchestrator session ids, not background shell
  // tasks. task only resolves `shell mode=async` tasks, so surface a
  // self-correcting hint instead of the bare "task not found" that otherwise
  // invites a wrong-tool retry loop.
  if (/^sess_/.test(taskId)) {
    return `Error: "${taskId}" is an agent/session id, not a background task_id. Agent tasks deliver completion notifications; use agent list/read only for manual recovery.`;
  }
  if (action !== 'read' && action !== 'wait' && action !== 'cancel') {
    return `Error: task action must be one of list|read|wait|cancel (got ${JSON.stringify(args.action)})`;
  }

  let task = getBackgroundTask(taskId, { context: options });
  if (!task) {
    const recovered = await readShellJobRecord(taskId);
    if (!recovered || !recoveredTaskMatches(recovered, options)) {
      return `Error: task not found: ${taskId}`;
    }
    if (action === 'read' || action === 'wait') {
      // Nothing to wait ON after a restart: the process is gone, so wait
      // degrades to the recovered snapshot rather than blocking.
      if (!recovered.terminal) return `Error: task state is unavailable after restart: ${taskId}`;
      task = registerBackgroundTask({
        taskId,
        surface: 'shell',
        operation: 'shell',
        label: recovered.command,
        context: {
          callerSessionId: recovered.ownerSessionId,
          clientHostPid: recovered.ownerHostPid,
        },
        meta: { recovered: true, stdout: recovered.stdoutPath, stderr: recovered.stderrPath, cwd: recovered.cwd },
      });
      completeBackgroundTask(taskId, {
        status: shellJobTaskStatus(recovered),
        result: shellJobPublicTaskResult(recovered),
        error: recovered.error,
        notify: false,
      });
    }
    if (action === 'cancel') {
      return recovered.terminal
        ? `Error: task already ${recovered.status}: ${taskId}`
        : `Error: task process control is unavailable after restart: ${taskId}`;
    }
  }
  const isShellTask = task.surface === 'shell';

  if (action === 'read' || action === 'wait') {
    let waitInterruptedByUser = false;
    let waitNotified = false;
    let notifiedTaskId = null;
    if (action === 'wait') {
      if (!isShellTask) return `Error: task wait is only available for shell tasks: ${taskId}`;
      ({
        interruptedByUser: waitInterruptedByUser,
        notified: waitNotified,
        notifiedTaskId,
      } = await waitForShellTask(task, taskId, args, options));
    }
    if (isShellTask) refreshShellTask(taskId, { includeRunning: true });
    const latest = getBackgroundTask(taskId, { context: options }) || task;
    // A finished task whose completion notice is still unconsumed returns that
    // notice's output (the unseen remainder) once; everything else reads the
    // cursor. A wait that leaves the job running carries the progress digest.
    const pendingCompletionOutput =
      isShellTask &&
      latest.status !== 'running' &&
      latest.completionAcknowledged !== true &&
      args.output !== 'tail' &&
      typeof latest.completionOutput === 'string'
        ? latest.completionOutput
        : null;
    const visible =
      isShellTask && latest.result && typeof latest.result === 'object'
        ? {
            ...latest,
            resultText:
              pendingCompletionOutput ??
              readShellTaskOutput(latest, latest.result, {
                output: args.output,
                digest: action === 'wait' && latest.status === 'running',
              }),
          }
        : latest;
    let rendered = renderBackgroundTask(visible, { includeResult: true });
    if (action === 'wait' && latest.status === 'running') {
      if (waitInterruptedByUser) {
        rendered +=
          '\n\nWait ended by new user input; task still running in the background. Handle the new message first.';
      } else if (waitNotified) {
        const from = notifiedTaskId && notifiedTaskId !== taskId ? ` (task_id: ${notifiedTaskId})` : '';
        rendered += `\n\nWait ended because a notification arrived${from}; it is delivered to you now. This task (${taskId}) is still running in the background.`;
      } else {
        const hits = (waitCeilingHits.get(latest) || 0) + 1;
        waitCeilingHits.set(latest, hits);
        // In-band report cue: the static "periodic reports" rule does not
        // survive a long tool loop, so a ceiling-hit wait carries the
        // protocol reminder itself.
        rendered +=
          hits > 1
            ? `\n\nWait ceiling reached again (${hits} times); task still running. Check whether it is progressing (task read output:tail, or the log file) and cancel it if it is stuck; otherwise continue other work — its result is delivered automatically.`
            : '\n\nWait ceiling reached; task still running and its result is delivered automatically. If periodic reports were requested, write the user-facing report now; otherwise continue independent work or end the turn.';
      }
    }
    if (acknowledgeBackgroundTaskCompletion(taskId, { context: options })) {
      recordDeliveredCompletion({ executionId: taskId });
    }
    return rendered;
  }

  // action is 'cancel': the read|wait|cancel guard above admits nothing else.
  if (isShellTask) return await cancelShellTask(task, taskId, options);
  cancelBackgroundTask(taskId, 'cancelled by task control');
  return renderTaskCancelSuccess(taskId, getBackgroundTask(taskId, { context: options }) || task);
}
