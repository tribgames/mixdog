// Safeguards of owned routines (schedules and webhook endpoints, see
// session-runtime/owned-automation-run.mjs): after a failure the next
// unattended fire waits `backoffBaseMs * 2^(n-1)` (n consecutive failures)
// and the routine switches itself off at `pauseAfterFailures`; a home thread
// holds at most `homeQueueLimit` routine turns waiting (and as many queued
// rows posted from outside its turns). Runs themselves are
// unlimited: no concurrency cap and no deadline.
export const ROUTINE_LIMITS = Object.freeze({
  backoffBaseMs: 60_000,
  pauseAfterFailures: 5,
  homeQueueLimit: 200,
});

/** How long (ms) an unattended fire still waits after the routine's
 *  `consecutiveFailures`, the latest at `lastFailedAt`; 0 when it may run. */
export function routineBackoffRemaining(state, now = Date.now(), limits = ROUTINE_LIMITS) {
  const failures = Number(state?.consecutiveFailures) || 0;
  const at = state?.lastFailedAt ? new Date(state.lastFailedAt).getTime() : Number.NaN;
  if (failures < 1 || !Number.isFinite(at)) return 0;
  return Math.max(0, at + limits.backoffBaseMs * 2 ** (failures - 1) - now);
}
