/**
 * client-registry/client-grace.mjs — the no-clients grace timer that lets the
 * daemon shut itself down through the session front door, and the dead-lead
 * sweep that drops clients whose owning process died.
 */
import { isPidAlive } from '../../../runtime/shared/pid-liveness.mjs';

const LEASE_MIN_MS = 3_000;
const LEASE_MAX_MS = 600_000;
const LEASE_DEFAULT_MS = 30_000;
const REMOTE_CLIENT_GRACE_DEFAULT_MS = 1_800_000;

/** A remote client's lease: the requested `leaseMs`, clamped to 3s..10min. */
export function clampLeaseMs(value) {
  const leaseMs = Number(value);
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) return LEASE_DEFAULT_MS;
  return Math.min(LEASE_MAX_MS, Math.max(LEASE_MIN_MS, leaseMs));
}

// A remote desktop behind a flaky tunnel needs far longer to come back than a
// local terminal restarting. Read at arm time so the env can change per run.
function remoteClientGraceMs() {
  const configured = Number(process.env.MIXDOG_REMOTE_CLIENT_GRACE_MS);
  return Number.isFinite(configured) && configured >= 0 && process.env.MIXDOG_REMOTE_CLIENT_GRACE_MS
    ? configured
    : REMOTE_CLIENT_GRACE_DEFAULT_MS;
}

export function createClientGrace({
  clients,
  log,
  clientGraceMs,
  sweepMs,
  nowMs = () => Date.now(),
  onClientsEmpty,
  isClosed,
  dropClient,
}) {
  let graceTimer = null;
  let sweepTimer = null;
  let everHadLifecycleClient = false;
  let signalled = false;
  // Whether the most recently departed lifecycle client was remote; it picks
  // the empty-clients grace.
  let lastLifecycleWasRemote = false;

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
    // Once the grace has fired, the sweep must not arm it again either: the
    // shutdown signal was already sent, and re-arming repeated it every sweep
    // tick for as long as the daemon took to go down. A lifecycle client that
    // attaches again clears the latch, because that daemon is staying up.
    if (graceTimer || signalled) return;
    graceTimer = setTimeout(
      () => {
        graceTimer = null;
        if (isClosed() || lifecycleClientCount() > 0) return;
        signalled = true;
        log(`no clients remain (${reason}) — signalling shutdown`);
        try {
          onClientsEmpty();
        } catch {}
      },
      lastLifecycleWasRemote ? remoteClientGraceMs() : clientGraceMs
    );
    graceTimer.unref?.();
  }

  function noteLifecycleDropped(client) {
    lastLifecycleWasRemote = client.remote === true;
  }

  /** A lifecycle client holds the daemon up: remember one ever attached and
   *  cancel any pending grace. */
  function noteLifecycleClient() {
    everHadLifecycleClient = true;
    signalled = false;
    cancel();
  }

  function startSweep() {
    if (sweepTimer || isClosed()) return;
    sweepTimer = setInterval(() => {
      for (const [token, c] of [...clients]) {
        if (c.remote) {
          // Its owning process is on another machine: liveness is the lease.
          if (nowMs() - c.lastSeen > c.leaseMs) dropClient(token, 'lease expired');
          continue;
        }
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

  return { lifecycleClientCount, cancel, maybeArm, noteLifecycleClient, noteLifecycleDropped, startSweep, stopTimers };
}
