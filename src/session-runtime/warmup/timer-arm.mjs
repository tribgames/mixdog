// Shared timer discipline of the background warmups: one pending timer per
// caller-owned slot, callbacks that run only while the runtime is open, and
// the idle check every job applies before touching providers. A job that finds
// the runtime busy parks instead of polling: the runtime wakes the parked jobs
// when a turn ends, a session create settles or the catalog refresh settles.
export function createWarmupTimers({ timers, isCloseRequested, getActiveTurnCount, getSessionCreatePromise }) {
  const parked = new Map();
  // Arm `timers[key]` unless it is already pending or the runtime is closing.
  const arm = (key, delayMs, run) => {
    if (timers[key] || isCloseRequested()) return;
    timers[key] = setTimeout(() => {
      timers[key] = null;
      if (isCloseRequested()) return;
      run();
    }, delayMs);
    timers[key].unref?.();
  };
  // Hold `run` until the next wake; a job parked again replaces its entry.
  const park = (key, run) => {
    if (!isCloseRequested()) parked.set(key, run);
  };
  // The busy state changed: every parked job re-checks it once, on its own tick.
  const wake = () => {
    const jobs = [...parked];
    parked.clear();
    for (const [key, run] of jobs) arm(key, 0, run);
  };
  // Why a background job must wait for an idle runtime, or null when idle.
  const busyReason = () => {
    if (getActiveTurnCount() > 0) return 'turn-active';
    if (getSessionCreatePromise()) return 'session-create';
    return null;
  };
  return { arm, park, wake, busyReason };
}
