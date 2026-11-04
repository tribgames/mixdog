// Daemon self-shutdown when the last client is gone: a grace timer armed on
// every removal and stream loss, with a no-op-fire backoff for when
// onClientsEmpty() keeps declining to shut down. Each client also holds one
// lease deadline: its open stream or a call of its own in flight is its lease,
// so the deadline runs only while it has neither, and a stream that closes
// after its lead process died drops it at once.
import { isPidAlive } from '../../../runtime/shared/pid-liveness.mjs';

// The same window a local session client gets (session-transport client-grace).
const STREAM_LEASE_MS = 30_000;

export function createClientGrace({ state, clients, log, clientGraceMs, onClientsEmpty, pruneDeadClients, dropClient }) {
  let graceTimer = null;
  let emptyFireBackoffMs = 0;
  let nextEmptyFireAt = 0;

  function cancel() {
    if (!graceTimer) return;
    clearTimeout(graceTimer);
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
    // door), every removal would otherwise re-fire it and log an
    // elapsed→deferred pair. Double the re-fire interval up to 10 minutes.
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

  function clearLease(c) {
    if (!c.leaseTimer) return;
    clearTimeout(c.leaseTimer);
    c.leaseTimer = null;
  }

  // One deadline per client; re-arming replaces it. Armed only while the
  // client holds neither a stream nor a call.
  function armLease(c) {
    clearLease(c);
    if (state.closed || c.sse || c.callsInFlight > 0) return;
    c.leaseTimer = setTimeout(() => {
      c.leaseTimer = null;
      if (clients.get(c.token) === c) dropClient(c.token, 'stream lapsed');
    }, STREAM_LEASE_MS);
    c.leaseTimer.unref?.();
  }

  function noteStreamClosed(c) {
    if (c.sse) return;
    if (!isPidAlive(c.leadPid)) {
      dropClient(c.token, 'lead pid gone');
      return;
    }
    armLease(c);
    maybeArm('sse closed');
  }

  function noteCallStarted(c) {
    c.callsInFlight = (c.callsInFlight || 0) + 1;
    clearLease(c);
  }

  function noteCallSettled(c) {
    c.callsInFlight = Math.max(0, (c.callsInFlight || 0) - 1);
    armLease(c);
  }

  function stopTimers() {
    cancel();
    for (const c of clients.values()) clearLease(c);
  }

  return {
    cancel,
    resetBackoff,
    maybeArm,
    armLease,
    clearLease,
    noteStreamClosed,
    noteCallStarted,
    noteCallSettled,
    stopTimers,
  };
}
