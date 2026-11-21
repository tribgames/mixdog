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
