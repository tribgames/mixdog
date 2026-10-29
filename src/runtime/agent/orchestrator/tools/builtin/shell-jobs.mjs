import os from 'node:os';
import {
  modelVisibleToolCompletionMessage,
  normalizeToolNotifyContext,
  notifyToolCompletion,
} from '../../../../shared/tool-execution-contract.mjs';
// Runtime-only bindings (used inside completion delivery, never at module
// eval), so the static cycle through session/manager.mjs is safe — same
// pattern as loop/tool-exec.mjs.
import { enqueuePendingMessage, markCompletionEntry } from '../../session/manager.mjs';
import { completeBackgroundTask, getBackgroundTask } from '../../../../shared/background-tasks.mjs';
import {
  cancelNativeTask,
  getNativeTask,
  listNativeTasks,
  promoteNativeTask,
  releaseNativeTask,
  setNativeTaskOutputPaths,
  setNativeTaskStartedAt,
  subscribeNativeTask,
  trackNativeForegroundTask,
  waitNativeTask,
} from '../lib/native-spawn-client.mjs';
import { attachJobInsights, shellJobPublicTaskResult } from './lib/shell-job-insights.mjs';
import { tryAdmitWorkspaceActivityAsync } from '../../../../shared/worktrees/activity-gate.mjs';
import { worktreeError } from '../../../../shared/worktrees/contract.mjs';
import {
  adoptShellWorkspaceAdmission,
  clearTerminationHold,
  completeShellJobRecord,
  listShellJobRecords,
  markShellJobTerminationUnconfirmed,
  pendingWorkspaceAdmission,
  publishShellJobRecord,
  recordShellJobHop,
  registerTerminationHold,
  retireShellJobRecord,
  takeReleaseRequest,
} from './lib/shell-job-records.mjs';
import {
  createContainedTreeTracker,
  createProcessTreeTracker,
  endWatchWhenUnconfirmable,
  killAfterSnapshot,
  PROCESS_TABLE_READ_BOUND_MS,
  sweepLiveIdentities,
  watchTermination,
  withinBound,
} from '../lib/shell-descendants.mjs';
import {
  flushPendingOwnerCancels,
  prepareOwnedShellTreeKills,
  registerOwnedShellTree,
  unregisterOwnedShellTree,
} from '../lib/owned-shell-trees.mjs';

// Bound on how long a runtime/session shutdown waits for the sweep of what a
// cancelled job started outside its process group.
const SHUTDOWN_TREE_CONFIRM_MS = 3_000;
// Lead of the pre-deadline snapshot over a native timeout kill: one table
// read's bound plus margin.
const PRE_DEADLINE_CAPTURE_MS = PROCESS_TABLE_READ_BOUND_MS + 1_000;

// Pre-kill snapshot of a tracked background job: always a fresh read, since
// the promotion baseline predates whatever the job started since (a server,
// an npm child); the baseline still stands when the fresh read fails. Marks
// the job killed, so its settle relies on this snapshot instead of an
// after-exit observation. A job the spawn server contains needs none (true at
// once): its kill is verified by the server's empty-job report.
function prepareTrackedKill(entry) {
  entry.killed = true;
  if (entry.contained) return true;
  return (entry.baseline || Promise.resolve(false)).then(() =>
    entry.tracker.capture().catch(() => entry.tracker.complete)
  );
}

const FINAL_TREE_OUTCOMES = new Set(['empty', 'unverified', 'released']);

/** The tracker of a contained job's killed or emptied tree, driven by the
 *  server's outcome (a final one latched: the task entry may expire).
 *  Survivors the server kept in the job are cancelled through it. */
function containedJobTracker(jobId) {
  let final = null;
  return createContainedTreeTracker({
    outcome: () => {
      if (final) return final;
      const outcome = getNativeTask(jobId)?.treeOutcome ?? null;
      if (FINAL_TREE_OUTCOMES.has(outcome)) final = outcome;
      return outcome;
    },
    cancel: () => cancelNativeTask(jobId),
  });
}
import { isPidAlive } from '../../../../shared/pid-liveness.mjs';
import { hopOf } from '../../../../shared/bot-hops.mjs';
import {
  renderShellCompletionEnvelope,
  shellCompletionInstruction,
} from '../../../../shared/task-notification-envelope.mjs';
import { formatDuration } from '../../../../shared/shell-output-summary.mjs';
import { readShellTaskOutput } from './lib/shell-task-output.mjs';

export { shellJobPublicTaskResult } from './lib/shell-job-insights.mjs';

globalThis.__mixdogShellJobsRuntimeLoaded = true;

export const TIMER_MAX_MS = 2_147_483_647;

export function buildJobNotFoundMessage(jobId) {
  return `Error: task not found: ${jobId}`;
}

// Running promoted jobs, for the runtime-wide read-only counts `task list`
// shows; each leaves when its native task settles (trackShellJobRecord).
const promotedJobIds = new Set();
const backgroundShellJobWatchers = new Map();
const jobNotifyCtxByJobId = new Map();
// jobId -> process-tree tracker of a published background job.
const backgroundTrackers = new Map();

function demoteBackgroundShellPriority(pid) {
  if (process.env.MIXDOG_BG_PRIORITY === '0') return;
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {}
}

// Live tasks exist only in the spawning process's memory, so every running job
// also publishes a disk record for the out-of-process shell-count readers
// (desktop pane chip, CLI statusline). The record is retired the moment the job
// settles — completed, timed out, or killed.
// The workspace admission a job record holds is released only once the job's
// processes are confirmed gone — the same confirmation path a foreground run
// uses, not the native terminal status alone.
// Resolves once both workspace leases are written; the promoted run's own
// admission is released only after that (handOverLease).
async function trackShellJobRecord(task, options) {
  const jobId = String(task?.jobId || '').trim();
  if (!jobId) return;
  const published = publishShellJobRecord(task, options);
  if (task?.cwd) {
    // The record's own reader is filed under the job's root pid, which the
    // gate drops the moment that pid dies. Survivors must keep the folder
    // reserved, so this runtime holds it under its own live pid as well.
    await published;
    const holding = tryAdmitWorkspaceActivityAsync(options?.ownerSessionId || jobId, task.cwd, { kind: 'command' });
    adoptShellWorkspaceAdmission(jobId, pendingWorkspaceAdmission(holding));
    if (!(await holding)) throw worktreeError('WORKTREE_BUSY_JOBS', 'The command folder is being managed.');
  }
  const tracker = task?.cwd ? createProcessTreeTracker({ pid: task.pid }) : null;
  // Killed, or emptied on its own, a contained job is confirmed by the server
  // (containedJobTracker); the process tracker still observes the survivors a
  // root that exited on its own leaves.
  const contained = task?.contained === true;
  let resolveTerminated = null;
  const entry = {
    tracker,
    contained,
    killed: false,
    baseline: null,
    // Settles once every process of the job is confirmed gone (or the user
    // force-released it): what `task cancel` waits on before it reports.
    terminated: new Promise((resolve) => {
      resolveTerminated = resolve;
    }),
  };
  if (tracker) {
    backgroundTrackers.set(jobId, entry);
    // Baseline identities while the promoted root is known to run, so a later
    // kill (ours or the native timeout) has a pre-kill snapshot without
    // waiting for one.
    entry.baseline = tracker.capture().catch(() => false);
    entry.owned = { ownerSessionId: options?.ownerSessionId || null, prepareKill: () => prepareTrackedKill(entry) };
    registerOwnedShellTree(jobId, entry.owned);
  }
  let unsubscribe = null;
  let settled = false;
  // The native runner enforces the job's deadline itself, with no snapshot
  // from here: one is taken shortly before it, so the timeout kill has the
  // identities of what the job started since its promotion.
  const deadlineMs = Math.floor(Number(options?.timeoutMs) || 0);
  const deadlineCapture =
    tracker && !contained && deadlineMs > 0
      ? setTimeout(
          () => {
            if (!settled) void tracker.capture().catch(() => false);
          },
          Math.max(0, deadlineMs - PRE_DEADLINE_CAPTURE_MS)
        )
      : null;
  deadlineCapture?.unref?.();
  const settle = (detail) => {
    if (settled || !detail || detail.status === 'running') return;
    settled = true;
    clearTimeout(deadlineCapture);
    try {
      unsubscribe?.();
    } catch {}
    promotedJobIds.delete(jobId);
    if (entry.owned) unregisterOwnedShellTree(jobId, entry.owned);
    const normalized = normalizeShellJobDetail(detail);
    if (!tracker) {
      void completeShellJobRecord(jobId, normalized);
      return;
    }
    // A root that exited on its own is observed after exit, as a foreground
    // settle does. A killed one relies on the snapshot taken before the kill.
    const killed = entry.killed || detail.killed || detail.timedOut || String(detail.status) === 'cancelled';
    if (!killed) tracker.acceptExitObservation();
    const watched =
      contained && (killed || detail.treeOutcome === 'empty') ? containedJobTracker(jobId) : tracker;
    // The completion notice is already on its way (watchBackgroundShellJob);
    // the record — and with it the workspace admission — completes only once
    // every process is confirmed gone, or the user releases it explicitly.
    // A force-release only drops the workspace hold (the record completes);
    // the job stays tracked and observed until its processes are confirmed
    // gone, and only that confirmation reports it terminated.
    let released = null;
    const releaseHold = () => {
      clearTerminationHold(jobId);
      released ??= completeShellJobRecord(jobId, normalized);
      return released;
    };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      stop();
      if (backgroundTrackers.get(jobId) === entry) backgroundTrackers.delete(jobId);
      resolveTerminated(true);
      return releaseHold();
    };
    const stop = watchTermination({
      tracker: endWatchWhenUnconfirmable(watched, { released: () => released !== null, stop: () => stop() }),
      // A killed job is not over while processes it started still run.
      sweep: killed,
      onTerminated: finish,
      // A release requested from another process is the same force-release.
      releaseRequested: () => {
        if (takeReleaseRequest(jobId)) void releaseHold();
        return false;
      },
      onUnconfirmed: () => {
        void markShellJobTerminationUnconfirmed(jobId);
        registerTerminationHold(jobId, {
          ownerSessionId: options?.ownerSessionId || null,
          cwd: task.cwd,
          release: releaseHold,
        });
      },
    });
  };
  unsubscribe = subscribeNativeTask(jobId, settle);
  settle(getNativeTask(jobId) || task);
}

/** Native task status → background-task status. A non-zero exit is a COMMAND
 *  result, not a task failure: the identical run in the foreground reports
 *  `[exit code: N]` and stays a success, so crossing the promotion threshold
 *  must not flip it to failed. Only control-plane outcomes (spawn/server
 *  error, timeout kill, cancellation) are terminal failures. */
export function shellJobTaskStatus(detail) {
  const status = typeof detail === 'string' ? detail : String(detail?.status || '');
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  // ONLY a real numeric non-zero exit normalizes. A signal death / null exit
  // (SIGSEGV, SIGKILL, a lost process) is a genuine failure and must never
  // be reported as success — `Number(null)` is 0, so an integer test on the
  // coerced value silently turned every crash into a completed task.
  const exitCode = detail && typeof detail === 'object' ? detail.exitCode : null;
  if (
    status === 'failed' &&
    detail &&
    typeof detail === 'object' &&
    !detail.timedOut &&
    !detail.killed &&
    !detail.error &&
    !detail.signal &&
    typeof exitCode === 'number' &&
    Number.isInteger(exitCode) &&
    exitCode !== 0
  )
    return 'completed';
  return 'failed';
}

/** Canonical shell-job detail. Every surface — wrapper task status, completion
 *  notification, public task result, disk record, insights summary — reads
 *  `status` from this one mapping, so a promoted non-zero command can never be
 *  reported completed by one surface and failed by another. The raw native
 *  value is kept as `nativeStatus` for diagnostics. */
export function normalizeShellJobDetail(detail) {
  if (!detail || typeof detail !== 'object') return detail;
  const nativeStatus = String(detail.status || '');
  const status = shellJobTaskStatus(detail);
  // `nativeStatus` belongs to the contract even when the mapping is identity
  // (a signal death stays `failed`): every surface must be able to read the
  // raw value the canonical status came from.
  if (detail.status === status && detail.nativeStatus === nativeStatus) return detail;
  return { ...detail, status, nativeStatus: detail.nativeStatus || nativeStatus };
}

/** Cause line for a failed job. The native side fills `error` only for its own
 *  control-plane failures, so a signal death or a status-less exit arrived with
 *  a null cause and the completion said "failed" while explaining nothing. */
function shellJobFailureCause(detail) {
  const explicit = String(detail?.error || '').trim();
  if (explicit) return explicit;
  const exitCode = typeof detail?.exitCode === 'number' ? detail.exitCode : null;
  const exitDetail = exitCode == null ? '' : ` (exit ${exitCode})`;
  if (detail?.timedOut) return `timed out before completing${exitDetail}`;
  if (detail?.signal) return `terminated by signal ${detail.signal}${exitDetail}`;
  if (detail?.killed) return `terminated before completing${exitDetail}`;
  if (exitCode == null) return 'ended without an exit status';
  return `exited with code ${exitCode}`;
}

function completionStreams(detail) {
  return {
    stdout_path: detail?.stdoutPath || null,
    stderr_path: detail?.mergeStderr === true ? null : detail?.stderrPath || null,
    stdout_preview: detail?.stdoutPreview || '',
    stderr_preview: detail?.mergeStderr === true ? '' : detail?.stderrPreview || '',
  };
}

/** `output`: the unseen output to deliver (the task cursor's remainder). By
 *  default the whole capture is read with a fresh cursor, consuming nothing. */
export function buildShellCompletion(jobId, detail, { output } = {}) {
  const exitCode = typeof detail?.exitCode === 'number' ? detail.exitCode : null;
  const status = detail?.status || 'unknown';
  const taskStatus = shellJobTaskStatus(detail);
  // A failure always carries its cause — including a signal death, where the
  // native task has no `error` of its own.
  const failureCause = taskStatus === 'failed' ? shellJobFailureCause(detail) : null;
  const reported = failureCause && !detail?.error ? { ...detail, error: failureCause } : detail;
  const startedMs = Date.parse(detail?.startedAt || '');
  const finishedMs = Date.parse(detail?.finishedAt || '');
  // The completion carries the result itself — exit code, duration and the
  // output (whole when short, else a summary with the log path) — so the
  // agent never needs a follow-up read for it.
  const body = renderShellCompletionEnvelope({
    jobId,
    status: taskStatus,
    exitCode,
    command: detail?.command,
    outputFile: detail?.stdoutPath,
    error: failureCause,
    result: [
      [
        exitCode !== null ? `exit code: ${exitCode}` : null,
        Number.isFinite(startedMs) && Number.isFinite(finishedMs)
          ? `duration: ${formatDuration(finishedMs - startedMs)}`
          : null,
      ]
        .filter(Boolean)
        .join(', ') || null,
      output ?? readShellTaskOutput({ status: 'completed' }, completionStreams(detail), { terminal: true }),
    ]
      .filter(Boolean)
      .join('\n'),
  });
  return {
    taskStatus,
    body,
    notification: body,
    instruction: shellCompletionInstruction({ jobId, status, exitCode }),
    result: shellJobPublicTaskResult(reported),
    error: failureCause,
  };
}

export async function waitForShellJob(jobId, { timeoutMs = 30_000, signal = null } = {}) {
  const started = Date.now();
  const detail = normalizeShellJobDetail(await waitNativeTask(jobId, timeoutMs, signal));
  const withInsights = attachJobInsights(detail);
  if (!withInsights) return null;
  withInsights.waitedMs = Date.now() - started;
  if (withInsights.status === 'running') withInsights.waitTimedOut = true;
  return withInsights;
}

export function peekShellJob(jobId) {
  return attachJobInsights(normalizeShellJobDetail(getNativeTask(jobId)));
}

/** Run `onTreeSettled` once a job whose native task is terminal is over as a
 *  whole: at once for an untracked job, else once every process of its tree is
 *  confirmed gone (or the user released it) — a root's exit is not the end of
 *  what it started. */
function afterTreeSettled(jobId, onTreeSettled) {
  const entry = backgroundTrackers.get(jobId);
  if (entry) void entry.terminated.then(onTreeSettled);
  else onTreeSettled();
}

/** True while a process of the job is still alive in this daemon. Owners of
 *  in-use artifacts consult it before a fallback cleanup fires. */
export function isShellJobRunning(jobId) {
  const key = String(jobId || '');
  return getNativeTask(key)?.status === 'running' || backgroundTrackers.has(key);
}

/** Run `onSettled` once the job leaves 'running' and its tree has settled
 *  (immediately when both already have). Owners of per-command artifacts
 *  (hoisted script files, tee captures, cache invalidation) use this instead of
 *  a fixed timer, which either fired under a still-running command or never at
 *  all. Returns an unsubscribe, or null when the job is unknown here — the
 *  caller then keeps its own fallback. */
export function subscribeShellJobSettled(jobId, onSettled) {
  const key = String(jobId || '').trim();
  if (!key || typeof onSettled !== 'function') return null;
  const current = getNativeTask(key);
  if (!current) return null;
  let done = false;
  const deliver = (task) =>
    afterTreeSettled(key, () => {
      if (done) return;
      done = true;
      try {
        onSettled(task);
      } catch {}
    });
  if (current.status !== 'running') {
    queueMicrotask(() => deliver(current));
    return () => {
      done = true;
    };
  }
  let seen = false;
  let unsubscribe = () => {};
  const fire = (task) => {
    if (seen || done || !task || task.status === 'running') return;
    seen = true;
    try {
      unsubscribe();
    } catch {}
    deliver(task);
  };
  unsubscribe = subscribeNativeTask(key, fire);
  return () => {
    done = true;
    try {
      unsubscribe();
    } catch {}
  };
}

export function refreshShellJob(jobId) {
  return normalizeShellJobDetail(getNativeTask(jobId));
}

export function killShellJob(jobId) {
  const tracked = backgroundTrackers.get(String(jobId || ''));
  const current = tracked ? getNativeTask(jobId) : null;
  if (current?.status === 'running') {
    // The pre-kill snapshot is the promotion baseline (or, when that did not
    // complete, a fresh read). The kill waits for it at most the read bound
    // and is sent regardless; without a snapshot the outcome stays unknown and
    // the folder stays held under the observation loop.
    // The kill never outruns the promotion baseline itself: a read still in
    // flight takes its table after a kill sent beside it, finds the root gone,
    // and the job could never be confirmed terminated. That read ends by its
    // own enumeration deadline. A contained job is cancelled at once.
    const snapshot = prepareTrackedKill(tracked);
    tracked.killSent =
      snapshot === true
        ? new Promise((resolve) => resolve(cancelNativeTask(jobId)))
        : tracked.baseline.then(() => killAfterSnapshot(snapshot, () => cancelNativeTask(jobId)));
    return { ...attachJobInsights(normalizeShellJobDetail(current)), killed: true };
  }
  if (tracked) {
    // The root already exited but its tracked descendants run on: the stop
    // reaches them through the tracker alone, whether or not the native task
    // is still cached; the termination watch then releases the folder.
    void tracked.tracker
      .observe({ rootExited: true })
      .then(() => sweepLiveIdentities(tracked.tracker))
      .catch(() => {});
    // An expired native entry says nothing about the root, so none is claimed.
    if (!current) return { jobId, killed: true };
    return { ...attachJobInsights(normalizeShellJobDetail(current)), killed: true };
  }
  const detail = cancelNativeTask(jobId);
  if (!detail) return null;
  const wasRunning = detail.status === 'running';
  return { ...attachJobInsights(normalizeShellJobDetail(detail)), killed: wasRunning };
}

/** Settles once the kill a stop of the tracked job queued has been sent (at
 *  once when none is pending). */
export function shellJobKillSent(jobId) {
  return Promise.resolve(backgroundTrackers.get(String(jobId || ''))?.killSent).catch(() => {});
}

/** True once every process of a tracked background job is confirmed gone,
 *  false while any is still alive when `timeoutMs` passes. A job without a
 *  process tracker (or one already finished) has nothing left to confirm. */
export async function waitShellJobTerminated(jobId, timeoutMs) {
  const entry = backgroundTrackers.get(String(jobId || ''));
  if (!entry) return true;
  return withinBound(entry.terminated, timeoutMs, false);
}

export function clearShellJobNotifyCtx(jobId) {
  jobNotifyCtxByJobId.delete(jobId);
}

export function cancelBackgroundShellJobWatch(jobId) {
  const entry = backgroundShellJobWatchers.get(jobId);
  if (!entry) return null;
  entry.cancel?.();
  return entry.notifyCtx || null;
}

// Owner-session pending-queue delivery for a completion whose notifyFn is gone.
function enqueueCompletionFallback(sessionId, message, meta) {
  const visible = modelVisibleToolCompletionMessage(message, meta);
  if (!visible) return false;
  return enqueuePendingMessage(sessionId, markCompletionEntry(visible, { executionId: meta?.execution_id, meta })) > 0;
}

export function watchBackgroundShellJob(jobId, notifyCtx) {
  const ctx =
    notifyCtx && typeof notifyCtx.notifyFn === 'function'
      ? normalizeToolNotifyContext(notifyCtx)
      : jobNotifyCtxByJobId.get(jobId);
  if (!jobId || !getNativeTask(jobId) || backgroundShellJobWatchers.has(jobId)) return;
  if (ctx) jobNotifyCtxByJobId.set(jobId, ctx);
  // The launching turn's bot-chain hop travels with the job: on its notify
  // context, and on its record for a completion recovered after a restart.
  const hop = hopOf(notifyCtx?.hop) || ctx?.hop || 0;
  if (hop) void recordShellJobHop(jobId, hop);
  let settled = false;
  let unsubscribe = () => {};
  const cancel = () => {
    if (settled) return;
    settled = true;
    unsubscribe();
    backgroundShellJobWatchers.delete(jobId);
  };
  const finish = (detail) => {
    if (settled || !detail || detail.status === 'running') return;
    settled = true;
    unsubscribe();
    backgroundShellJobWatchers.delete(jobId);
    jobNotifyCtxByJobId.delete(jobId);
    const enriched = attachJobInsights(normalizeShellJobDetail(detail));
    // The notice carries only what the agent has not seen yet: the task's
    // cursor remainder. Kept on the task so a wait/read that reaches the
    // finished task first returns that same remainder (and suppresses the
    // notice) instead of an empty read.
    const task = getBackgroundTask(jobId);
    const output = task ? readShellTaskOutput(task, completionStreams(enriched), { terminal: true }) : undefined;
    if (task) task.completionOutput = output;
    const completion = buildShellCompletion(jobId, enriched, { output });
    const completedTask = completeBackgroundTask(jobId, {
      status: completion.taskStatus,
      result: completion.result,
      resultText: completion.body,
      error: completion.error,
      resultType: 'shell_task_result',
      instruction: completion.instruction,
      terminalReason: 'shell-native-event',
    });
    if (!completedTask) {
      // Delivery order: owner notifyFn when present, else the owner
      // session's pending queue. A ctx-less finish (daemon restarted
      // between job start and completion, or a watcher armed without a
      // notify context) previously dropped the completion silently.
      const owner = String(ctx?.callerSessionId || detail.ownerSessionId || '');
      notifyToolCompletion({
        surface: 'shell',
        id: jobId,
        status: completion.taskStatus,
        text: completion.notification,
        resultType: 'shell_task_result',
        instruction: completion.instruction,
        context: ctx || { callerSessionId: owner, hop },
        enqueueFallback: enqueueCompletionFallback,
        logPrefix: 'shell-jobs',
      });
    }
  };
  unsubscribe = subscribeNativeTask(jobId, finish);
  if (!settled) {
    backgroundShellJobWatchers.set(jobId, { cancel, notifyCtx: ctx });
  }
  queueMicrotask(() => finish(getNativeTask(jobId)));
}

export async function trackForegroundShellJob({ command, cwd, child, jobId, clientHostPid, ownerSessionId }) {
  return trackNativeForegroundTask({
    child,
    jobId,
    command,
    cwd,
    ownerSessionId,
    clientHostPid,
  });
}

export async function promoteForegroundShellJob({
  command,
  cwd,
  pid,
  jobId,
  timeoutMs,
  clientHostPid,
  ownerSessionId,
  startedAtMs = 0,
  stdoutPath = null,
  stderrPath = null,
}) {
  const native = await promoteNativeTask({
    jobId,
    command,
    cwd,
    timeoutMs,
    ownerSessionId,
    clientHostPid,
  });
  if (!native) return null;
  demoteBackgroundShellPriority(pid);
  // Promotion refreshes the task at transition time, and a promoted standby
  // shell carries its process-creation time. Neither is when this command started,
  // so the runner's own start moment is registered before anything reads the
  // task — the record, the completion elapsed and the live readouts then all
  // measure the command itself.
  const started = Math.floor(Number(startedAtMs)) || 0;
  if (started > 0) {
    setNativeTaskStartedAt(native.jobId, started);
    native.startedAt = new Date(started).toISOString();
  }
  // Task reads follow the same spill files the promotion result read from, so
  // both advance one output cursor.
  if (stdoutPath || stderrPath) {
    setNativeTaskOutputPaths(native.jobId, { stdoutPath, stderrPath });
    native.stdoutPath = stdoutPath || null;
    native.stderrPath = stderrPath || null;
  }
  // Added before tracking: the record's settlement removes it again.
  promotedJobIds.add(native.jobId);
  await trackShellJobRecord(native, { ownerSessionId, clientHostPid, startedAtMs: started, timeoutMs });
  return native;
}

/** Running background shell jobs owned by sessions outside `ownSessionIds`. */
export function otherSessionBackgroundShellJobCount(ownSessionIds) {
  let count = 0;
  for (const jobId of [...promotedJobIds]) {
    const task = getNativeTask(jobId);
    if (task?.status !== 'running') {
      promotedJobIds.delete(jobId);
      continue;
    }
    if (!ownSessionIds.has(String(task.ownerSessionId || ''))) count += 1;
  }
  return count;
}

/** Live record for a command still running in the FOREGROUND. Background jobs
 *  publish through trackShellJobRecord and settle into a terminal record; a
 *  foreground command has no task id and no completion notice, so its record
 *  is purely the "running right now" marker every out-of-process shell readout
 *  scans. Retired by retireForegroundShellRecord the moment it settles. */
export function publishForegroundShellRecord({
  jobId,
  command,
  cwd,
  pid,
  shellType = null,
  startedAtMs = 0,
  ownerSessionId = null,
  clientHostPid = null,
  terminationUnconfirmed = false,
}) {
  if (!jobId || !Number.isFinite(Number(pid)) || Number(pid) <= 0) return Promise.resolve();
  return publishShellJobRecord(
    { jobId, command, cwd, pid: Number(pid), shellType },
    {
      ownerSessionId,
      clientHostPid,
      startedAtMs,
      foreground: true,
      terminationUnconfirmed,
    }
  );
}

export function retireForegroundShellRecord(jobId) {
  if (!jobId) return;
  retireShellJobRecord(jobId);
}

// Daemon-restart recovery: records left 'running' by a dead daemon can never
// finish through the live watcher path — their completion (and output) used to
// vanish silently. Finalize each dead-pid record and push one completion
// notice to the owner session's pending queue. Content-addressed completion
// ids keep multi-shard reconciliation idempotent.
let _recoveredCompletionsReconciled = false;
export async function reconcileRecoveredShellJobCompletions() {
  if (_recoveredCompletionsReconciled) return 0;
  _recoveredCompletionsReconciled = true;
  let records = [];
  try {
    records = await listShellJobRecords();
  } catch {
    return 0;
  }
  let notified = 0;
  for (const record of records) {
    if (!record || record.terminal) continue;
    // A foreground record is a liveness marker, not a task: it has no
    // task id a caller could query and no waiter expecting a completion.
    if (record.foreground) continue;
    if (getNativeTask(record.jobId)) continue; // live in this daemon
    if (isPidAlive(Number(record.pid) || 0)) continue; // survived the restart
    const detail = {
      ...record,
      status: 'failed',
      error:
        'daemon restarted while this shell task was running; its outcome was lost. Re-run the command if the result is still needed.',
    };
    try {
      await completeShellJobRecord(record.jobId, detail);
    } catch {
      /* best-effort */
    }
    const owner = String(record.ownerSessionId || '');
    if (!owner) continue;
    try {
      const completion = buildShellCompletion(record.jobId, detail);
      const delivered = notifyToolCompletion({
        surface: 'shell',
        id: record.jobId,
        status: completion.taskStatus,
        text: completion.notification,
        resultType: 'shell_task_result',
        instruction: completion.instruction,
        context: { callerSessionId: owner, hop: record.hop },
        enqueueFallback: enqueueCompletionFallback,
        logPrefix: 'shell-jobs-recovery',
      });
      if (delivered) notified += 1;
    } catch {
      /* best-effort */
    }
  }
  return notified;
}

export async function shutdownShellJobs(_reason = 'runtime-close', { scope = null } = {}) {
  const scoped = Boolean(scope);
  // Runtime shutdown: a session-close cancel still waiting for its snapshot
  // is sent now, before the process can go away with it.
  if (!scoped) flushPendingOwnerCancels();
  const ownerSessionId = scoped ? String(scope.ownerSessionId || '') : '';
  if (scoped && !ownerSessionId) {
    return { killed: 0, cancelledJobs: 0, cancelledWatchers: 0 };
  }
  const jobs = listNativeTasks().filter(
    (task) => task.status === 'running' && (!scoped || String(task.ownerSessionId || '') === ownerSessionId)
  );
  let cancelledWatchers = 0;
  // Identities first, as every other kill does: once a root dies, what it
  // started outside its process group is reparented and can no longer be
  // found. The cancel is sent at the snapshot bound regardless — and at once
  // when no snapshot is pending (every tree contained, or already captured).
  const cancelAll = () => {
    for (const task of jobs) {
      if (cancelBackgroundShellJobWatch(task.jobId)) cancelledWatchers += 1;
      try {
        cancelNativeTask(task.jobId);
      } catch {}
      jobNotifyCtxByJobId.delete(task.jobId);
    }
  };
  const snapshots = prepareOwnedShellTreeKills(scoped ? ownerSessionId : null);
  if (snapshots.length === 0) cancelAll();
  else await killAfterSnapshot(Promise.all(snapshots), cancelAll);
  const settled = await Promise.all(jobs.map((task) => waitNativeTask(task.jobId, 1_200).catch(() => null)));
  // A process still running after the wait is not forgotten: it keeps being
  // stopped until its exit is confirmed.
  const unconfirmed = jobs.filter((_, index) => settled[index]?.status === 'running').map((task) => task.jobId);
  for (const jobId of unconfirmed) retryShutdownSurvivor(jobId, 1);
  // The roots are gone; what they started outside their group is swept by
  // each job's termination watch. Shutdown waits for that, bounded.
  const treesGone = await Promise.all(jobs.map((task) => waitShellJobTerminated(task.jobId, SHUTDOWN_TREE_CONFIRM_MS)));
  if (scoped) {
    // The owning session is gone: nothing can query its tasks again, so
    // drop ALL of its retained state — not only the ones that happened to
    // be running when shutdown began. releaseNativeTask refuses a task
    // that is still alive, and disk records still serve a post-restart
    // recovery read.
    for (const task of listNativeTasks()) {
      if (String(task.ownerSessionId || '') !== ownerSessionId) continue;
      try {
        releaseNativeTask(task.jobId);
      } catch {}
    }
  }
  if (!scoped) jobNotifyCtxByJobId.clear();
  return {
    killed: jobs.length,
    cancelledJobs: jobs.length,
    confirmedJobs: settled.filter((task) => task && task.status !== 'running').length,
    unconfirmedJobs: unconfirmed,
    treeUnconfirmedJobs: jobs.filter((_, index) => !treesGone[index]).map((task) => task.jobId),
    cancelledWatchers,
  };
}

// Shutdown survivors: re-issue the stop every SURVIVOR_RETRY_MS until the
// native runner confirms the exit, at most SURVIVOR_MAX_ATTEMPTS times, each
// step logged. A survivor that outlives every attempt stays listed.
const SURVIVOR_RETRY_MS = 5_000;
const SURVIVOR_MAX_ATTEMPTS = 10;
const shutdownSurvivors = new Map();

function logShellJobs(message) {
  try {
    process.stderr.write(`[shell-jobs] ${message}\n`);
  } catch {}
}

function dropShutdownSurvivor(jobId) {
  const entry = shutdownSurvivors.get(jobId);
  if (!entry) return;
  shutdownSurvivors.delete(jobId);
  clearTimeout(entry.timer);
  try {
    entry.unsubscribe();
  } catch {}
}

function retryShutdownSurvivor(jobId, attempts) {
  let entry = shutdownSurvivors.get(jobId);
  if (entry) clearTimeout(entry.timer);
  else {
    entry = { attempts, timer: null, unsubscribe: () => {} };
    shutdownSurvivors.set(jobId, entry);
    // The native terminal event confirms the exit at any time — also after
    // the last retry — and drops the entry.
    entry.unsubscribe = subscribeNativeTask(jobId, (task) => {
      if (task?.status === 'running') return;
      dropShutdownSurvivor(jobId);
      logShellJobs(`${jobId} exit confirmed after shutdown`);
    });
  }
  entry.attempts = attempts;
  logShellJobs(`shutdown could not confirm ${jobId} exited (attempt ${attempts}); retrying`);
  entry.timer = setTimeout(() => {
    if (getNativeTask(jobId)?.status !== 'running') {
      dropShutdownSurvivor(jobId);
      logShellJobs(`${jobId} exit confirmed after shutdown`);
      return;
    }
    if (attempts >= SURVIVOR_MAX_ATTEMPTS) {
      entry.timer = null;
      logShellJobs(`giving up stopping ${jobId} after ${attempts} attempts; it is still running`);
      return;
    }
    try {
      cancelNativeTask(jobId);
    } catch {}
    retryShutdownSurvivor(jobId, attempts + 1);
  }, SURVIVOR_RETRY_MS);
  entry.timer.unref?.();
}

/** Shutdown survivors whose termination is not yet confirmed. */
export function shellShutdownSurvivors() {
  // Reconcile against native state: an exit whose event was missed still ends the entry.
  for (const jobId of [...shutdownSurvivors.keys()]) {
    if (getNativeTask(jobId)?.status !== 'running') dropShutdownSurvivor(jobId);
  }
  return [...shutdownSurvivors].map(([jobId, entry]) => ({ jobId, attempts: entry.attempts }));
}
