// The lead turn's quiet-time cue: polls the runtime's turn liveness while the
// turn runs and publishes `spinner.quiet` ({ since, wait, tool?, warnMs })
// once the turn has gone QUIET_PROGRESS_CUE_MS without counted progress, and
// clears it when progress resumes. The value is frozen for a whole silence, so
// a silence costs two publications, never one per tick. Display only.
import { displayProgressStage, quietProgress, lastProgressAt } from '../../runtime/shared/quiet-progress.mjs';
import { resolveAgentStallThresholds } from '../../runtime/agent/orchestrator/stall-policy.mjs';

const QUIET_POLL_MS = 1_000;

/** The lead's stall-watchdog warn point, in ms. */
export function leadStallWarnMs() {
  return resolveAgentStallThresholds('lead').warn * 1000;
}

function sameQuiet(left, right) {
  if (!left || !right) return !left && !right;
  return left.since === right.since && left.wait === right.wait && left.tool === right.tool;
}

/** The quiet state a liveness snapshot implies at `now` (null: not quiet). */
export function turnQuietState(liveness, now, warnMs) {
  if (!liveness || typeof liveness !== 'object' || typeof liveness.then === 'function') return null;
  const quiet = quietProgress({
    progressAt: lastProgressAt(liveness),
    stage: displayProgressStage(liveness),
    tool: liveness.currentTool,
    now,
  });
  return quiet ? { ...quiet, warnMs } : null;
}

export function startQuietWatch({ runtime, getState, set, isCurrentTurn, warnMs = leadStallWarnMs() }) {
  const timer = setInterval(() => {
    if (!isCurrentTurn()) {
      clearInterval(timer);
      return;
    }
    const spinner = getState().spinner;
    if (!spinner) return;
    let liveness = null;
    try {
      liveness = runtime?.getTurnLiveness?.() ?? null;
    } catch {
      return;
    }
    const next = turnQuietState(liveness, Date.now(), warnMs);
    if (sameQuiet(spinner.quiet ?? null, next)) return;
    set({ spinner: { ...spinner, quiet: next } });
  }, QUIET_POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
