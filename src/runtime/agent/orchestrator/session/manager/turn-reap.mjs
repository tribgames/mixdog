// manager/turn-reap.mjs
// A turn abandoned by a timeout or stall stops the background shell work that
// turn started — a job auto-promoted during it, and the survivors its commands
// left running. Only those: a user cancel, a steering interrupt, a normal
// finish, and jobs from earlier turns keep their jobs. Only the entry's own
// turn start is armed, and a new turn clears it, so a reap that runs late
// never touches a newer turn's work.
import { cancelBackgroundTasks, getBackgroundTask } from '../../../../shared/background-tasks.mjs';
import { runtimeState } from './runtime-state.mjs';

// Timeout ownership is explicit and turn-scoped: the code that makes a timeout
// WIN (the watchdog's own abort, the provider's terminal error) arms the reap
// itself, and only while nothing else has stopped the turn. An abort that
// arrives first stays a cancel; an error chain is never read afterwards.

// Codes of the runtime's own timeout/stall errors (stall-policy's
// streamStalledError / providerTimeoutError, the Gemini stream timeout).
const PROVIDER_TIMEOUT_CODES = new Set(['ESTREAMSTALL', 'EPROVIDERTIMEOUT', 'EGEMINITIMEOUT']);

/** A timeout is the first thing to stop this session's turn: arm its reap now,
 *  before the abort propagates. No-op when the turn's controller is already
 *  aborted (a cancel, interrupt or close won) or no turn runs. */
export function armTurnTimeout(id) {
  const entry = runtimeState.get(id);
  if (!entry || entry.controller?.signal.aborted) return;
  armTurnShellReap(id, entry);
}

/** The turn ended with a provider timeout/stall error that no retry recovered
 *  from: arm only while the turn's own signal is un-aborted and the error
 *  itself carries a timeout code or the producer's own `streamStalled` flag. */
export function armTurnTimeoutOnProviderError(id, entry, turnSignal, err) {
  if (turnSignal?.aborted) return;
  if (!PROVIDER_TIMEOUT_CODES.has(err?.code) && err?.streamStalled !== true) return;
  armTurnShellReap(id, entry);
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

// Confirmed by the runtime's own state, never assumed: a task whose cancel hook
// kills is confirmed by that kill's `terminated`; a promoted job once neither
// its native task nor its process-tree tracker is live. Without the probe
// (shell-jobs not loaded) nothing is confirmed.
function isConfirmedGone(job, isRunning) {
  if (job.outcome) return job.terminated;
  return Boolean(isRunning) && !isRunning(job.taskId);
}

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
