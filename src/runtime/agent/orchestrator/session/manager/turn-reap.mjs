// manager/turn-reap.mjs
// A turn abandoned by a timeout or stall stops the background shell work that
// turn started — a job auto-promoted during it, and the survivors its commands
// left running. Only those: a user cancel, a steering interrupt, a normal
// finish, and jobs from earlier turns keep their jobs. Only the entry's own
// turn start is armed, and a new turn clears it, so a reap that runs late
// never touches a newer turn's work.
import { cancelBackgroundTasks, getBackgroundTask } from '../../../../shared/background-tasks.mjs';
import { runtimeState } from './runtime-state.mjs';

// Abort reasons / terminal errors that mean "the turn timed out / stalled": the
// canonical runtime's watchdog abort reason, the in-process watchdog's typed
// error, and the provider stall/timeout errors (by type or code, never text).
const TIMEOUT_ERROR_NAMES = new Set([
  'AgentStallAbortError',
  'StreamStalledError',
  'StreamStalledAbortError',
  'ProviderTimeoutError',
  'GeminiTimeoutError',
]);
const TIMEOUT_ERROR_CODES = new Set(['ESTREAMSTALL', 'EPROVIDERTIMEOUT', 'EGEMINITIMEOUT']);

const CHAIN_DEPTH = 4;
const isTimeoutNode = (e) => TIMEOUT_ERROR_NAMES.has(e.name) || TIMEOUT_ERROR_CODES.has(e.code);

/** Order-independent: scans the whole bounded chain (error, cause, reason,
 *  signal.reason). Any explicit non-timeout reason string (user-cancel,
 *  interrupt, close, ...) anywhere means NOT a timeout; otherwise it is one
 *  only if some level is a timeout/stall by name or code, or `agent-watchdog`. */
export function isTurnTimeoutAbort(reason) {
  let timeout = false;
  const seen = new Set();
  let level = [reason];
  for (let depth = 0; depth <= CHAIN_DEPTH && level.length > 0; depth += 1) {
    const next = [];
    for (const e of level) {
      if (typeof e === 'string') {
        if (e === 'agent-watchdog') timeout = true;
        else if (e) return false;
      } else if (e && typeof e === 'object' && !seen.has(e)) {
        seen.add(e);
        const node = isTimeoutNode(e);
        timeout ||= node;
        // A timeout error's own `reason` is not a cancel reason.
        next.push(e.cause, e.error, e.signal?.reason);
        if (!node) next.push(e.reason);
      }
    }
    level = next;
  }
  return timeout;
}

/** Why this turn ended, as the runtime recorded it: when the turn's own
 *  controller was aborted, its signal reason (set by abortSessionTurn, user
 *  cancel, interrupt, close or a linked parent) decides whatever the error
 *  says; otherwise the terminal error does. The controller is fresh per turn,
 *  unlike `entry.closedReason`, which outlives it. */
export function turnEndedByTimeout(signal, err) {
  return isTurnTimeoutAbort(signal?.aborted ? signal.reason : err);
}

// session id -> jobs stopped by a timeout reap, until the owner's handoff
// reports them (or the session's next turn starts).
const stoppedJobs = new Map();

// What the cancel path already produces, read without waiting: a task whose
// own cancel hook kills (survivors of a finished command) answers with its
// kill outcome; a promoted job is over once its process tree is no longer
// tracked.
function trackStoppedJob(taskId) {
  const job = { taskId, outcome: null, terminated: false };
  const kill = getBackgroundTask(taskId)?.cancelOutcome;
  if (kill) {
    job.outcome = kill;
    Promise.resolve(kill).then(
      (result) => {
        job.terminated = result?.terminated === true;
      },
      () => {}
    );
  }
  return job;
}

// shell-jobs depends on the session manager, which loads this module, so it is
// loaded at the first reap. The classification awaits only this module load,
// never a process; a probe that cannot be loaded leaves a job "still stopping".
let shellJobProbe = null;
function loadShellJobProbe() {
  shellJobProbe ??= import('../../tools/builtin/shell-jobs.mjs').then(
    (shellJobs) => shellJobs.isShellJobRunning,
    () => null
  );
  return shellJobProbe;
}

const isConfirmedGone = (job, isRunning) => (job.outcome ? job.terminated : isRunning ? !isRunning(job.taskId) : false);

function reap(id, entry) {
  loadShellJobProbe();
  const { taskIds } = cancelBackgroundTasks({
    surface: 'shell',
    executionSessionId: id,
    startedSinceMs: entry.shellReapSince,
    reason: 'turn-timeout',
    notify: false,
  });
  if (taskIds.length > 0) stoppedJobs.set(id, [...(stoppedJobs.get(id) || []), ...taskIds.map(trackStoppedJob)]);
}

/** The turn is being abandoned by a timeout: remember when it started and stop
 *  what it has started so far. A settled (idle) entry has no turn to reap. */
export function armTurnShellReap(id, entry) {
  if (!(entry?.askStartedAt > 0) || entry.closed) return;
  entry.shellReapSince = entry.askStartedAt;
  reap(id, entry);
}

/** The abandoned turn has unwound: sweep what it registered while stopping
 *  (survivors of its aborted commands). No-op unless this turn was armed. */
export function reapTurnShellJobs(id, entry) {
  if (entry?.shellReapSince > 0 && !entry.closed && runtimeState.get(id) === entry) reap(id, entry);
}

/** A new turn owns the session: nothing earlier may be reaped on its account. */
export function resetTurnShellReap(id, entry) {
  entry.shellReapSince = null;
  stoppedJobs.delete(id);
}

/** The jobs the reap stopped, split by what is known now: `stopped` are
 *  confirmed gone, `stopping` were killed but their processes are not yet
 *  confirmed gone (they keep being terminated). */
export async function takeStoppedShellJobs(id) {
  const jobs = stoppedJobs.get(id) || [];
  stoppedJobs.delete(id);
  if (jobs.length === 0) return { stopped: [], stopping: [] };
  const isRunning = await loadShellJobProbe();
  const taskIds = (confirmed) =>
    jobs.filter((job) => isConfirmedGone(job, isRunning) === confirmed).map((job) => job.taskId);
  return { stopped: taskIds(true), stopping: taskIds(false) };
}
