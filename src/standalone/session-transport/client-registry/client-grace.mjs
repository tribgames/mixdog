/**
 * client-registry/client-grace.mjs — the no-clients grace timer that lets the
 * daemon shut itself down through the session front door, and the dead-lead
 * sweep that drops clients whose owning process died.
 */
import { isPidAlive } from '../../../runtime/shared/pid-liveness.mjs';

export function createClientGrace({ clients, log, clientGraceMs, sweepMs, onClientsEmpty, isClosed, dropClient }) {
  let graceTimer = null;
  let sweepTimer = null;
  let everHadLifecycleClient = false;

  function lifecycleClientCount() {
    let count = 0;
    for (const client of clients.values()) {
      if (client.lifecycle) count += 1;
    }
    return count;
  }

  function cancel() {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  }

  function maybeArm(reason) {
    if (isClosed() || !everHadLifecycleClient || typeof onClientsEmpty !== 'function') return;
    if (lifecycleClientCount() > 0) return;
    // Never re-arm an ALREADY armed grace: the 5s sweep also calls this, and
    // cancel+rearm on every tick pushed the 10s deadline out forever — the
    // daemon could never self-shut down through the session front door.
    if (graceTimer) return;
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (isClosed() || lifecycleClientCount() > 0) return;
      log(`no clients remain (${reason}) — signalling shutdown`);
      try {
        onClientsEmpty();
      } catch {}
    }, clientGraceMs);
    graceTimer.unref?.();
  }

  /** A lifecycle client holds the daemon up: remember one ever attached and
   *  cancel any pending grace. */
  function noteLifecycleClient() {
    everHadLifecycleClient = true;
    cancel();
  }

  function startSweep() {
    if (sweepTimer || isClosed()) return;
    sweepTimer = setInterval(() => {
      for (const [token, c] of [...clients]) {
        // A client whose owning process died can never read its stream again.
        if (c.leadPid && !isPidAlive(c.leadPid)) dropClient(token, 'lead pid gone');
      }
      maybeArm('sweep');
    }, sweepMs);
    sweepTimer.unref?.();
  }

  function stopTimers() {
    cancel();
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  return { lifecycleClientCount, cancel, maybeArm, noteLifecycleClient, startSweep, stopTimers };
}
