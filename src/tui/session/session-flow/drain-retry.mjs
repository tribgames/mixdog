/**
 * src/tui/session/session-flow/drain-retry.mjs - the re-check timer of a drain
 * that found a gate closed (drain.mjs). One timer at most, kept on
 * `flags.blockedDrainRetryTimer`.
 */

// Re-check cadence for a drain that found a gate closed. A gate is state, not
// an event: the queue re-reads it instead of trusting that whoever closes it
// will remember to kick the queue on the way out. Both timers exist only while
// the queue actually holds work, so an idle session never polls.
export const BLOCKED_DRAIN_RETRY_MS = 50;
// Session commands (setModel/newSession/resume/auto-clear) release in seconds;
// an active turn can run for many minutes, so its gate is re-read coarsely.
export const ACTIVE_TURN_RECHECK_MS = 2_000;

export function createBlockedDrainRetry({ flags, pending, drain }) {
  function scheduleBlockedDrainRetry(delayMs = BLOCKED_DRAIN_RETRY_MS) {
    if (pending.length === 0 || flags.disposed) return;
    if (flags.blockedDrainRetryTimer) return;
    const timer = setTimeout(() => {
      flags.blockedDrainRetryTimer = null;
      if (pending.length > 0) void drain();
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    flags.blockedDrainRetryTimer = timer;
  }

  function clearBlockedDrainRetry() {
    if (!flags.blockedDrainRetryTimer) return;
    clearTimeout(flags.blockedDrainRetryTimer);
    flags.blockedDrainRetryTimer = null;
  }

  return { scheduleBlockedDrainRetry, clearBlockedDrainRetry };
}
