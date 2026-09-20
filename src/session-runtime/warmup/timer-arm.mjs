// Shared timer discipline of the background warmups: one pending timer per
// caller-owned slot, callbacks that run only while the runtime is open, and
// the idle check every job applies before touching providers.
export function createWarmupTimers({ timers, isCloseRequested, getActiveTurnCount, getSessionCreatePromise }) {
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
  // Why a background job must wait for an idle runtime, or null when idle.
  const busyReason = () => {
    if (getActiveTurnCount() > 0) return 'turn-active';
    if (getSessionCreatePromise()) return 'session-create';
    return null;
  };
  return { arm, busyReason };
}
