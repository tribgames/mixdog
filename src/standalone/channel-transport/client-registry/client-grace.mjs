// Daemon self-shutdown when the last client is gone: a grace timer armed on
// every removal, a periodic sweep that prunes dead pids and re-arms it, and a
// no-op-fire backoff for when onClientsEmpty() keeps declining to shut down.
export function createClientGrace({ state, clients, log, clientGraceMs, sweepMs, onClientsEmpty, pruneDeadClients }) {
  let graceTimer = null;
  let sweepTimer = null;
  let emptyFireBackoffMs = 0;
  let nextEmptyFireAt = 0;

  function cancel() {
    if (!graceTimer) return;
    try {
      clearTimeout(graceTimer);
    } catch {}
    graceTimer = null;
  }

  /** Any client registration resets the re-fire backoff. */
  function resetBackoff() {
    emptyFireBackoffMs = 0;
    nextEmptyFireAt = 0;
  }

  function maybeArm(reason) {
    if (state.closed || graceTimer) return;
    if (!state.everHadClient || clients.size > 0) return;
    if (typeof onClientsEmpty !== 'function' || clientGraceMs <= 0) return;
    // No-op-fire backoff: when onClientsEmpty() repeatedly declines to shut
    // the daemon down (a session client is still alive on the other front
    // door), the sweep would otherwise re-fire every grace period and spam
    // the log with an elapsed→deferred pair for hours. Double the re-fire
    // interval up to 10 minutes.
    if (Date.now() < nextEmptyFireAt) return;
    graceTimer = setTimeout(() => {
      graceTimer = null;
      pruneDeadClients();
      if (clients.size > 0) return;
      emptyFireBackoffMs = Math.min(Math.max(clientGraceMs, emptyFireBackoffMs * 2), 600_000);
      nextEmptyFireAt = Date.now() + emptyFireBackoffMs;
      log(`client grace elapsed (${reason}); no live clients — self-shutdown`);
      try {
        onClientsEmpty();
      } catch {}
    }, clientGraceMs);
    graceTimer.unref?.();
  }

  function startSweep() {
    if (sweepTimer || typeof onClientsEmpty !== 'function') return;
    sweepTimer = setInterval(
      () => {
        pruneDeadClients();
        if (state.everHadClient && clients.size === 0) maybeArm('all clients gone (sweep)');
      },
      Math.max(1000, Math.min(sweepMs, clientGraceMs || sweepMs))
    );
    sweepTimer.unref?.();
  }

  function stopTimers() {
    cancel();
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  return { cancel, resetBackoff, maybeArm, startSweep, stopTimers };
}
