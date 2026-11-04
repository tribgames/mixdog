/**
 * client-registry/client-grace.mjs — the no-clients grace timer that lets the
 * daemon shut itself down through the session front door, and each client's
 * lease deadline. A remote client's lease is its heartbeat; a local client's
 * lease is its open event stream: the deadline runs only while it holds none,
 * and a stream that closes after its lead process died drops it at once. A
 * call of the client's own in flight holds either lease.
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

export function createClientGrace({ clients, log, clientGraceMs, onClientsEmpty, isClosed, dropClient }) {
  let graceTimer = null;
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
    // Never re-arm an ALREADY armed grace: every stream close also calls
    // this, and cancel+rearm pushed the deadline out for as long as closes
    // kept coming. Once the grace has fired it is not armed again either: the
    // shutdown signal was already sent. A lifecycle client that attaches again
    // clears the latch, because that daemon is staying up.
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

  function clearLease(c) {
    if (!c.leaseTimer) return;
    clearTimeout(c.leaseTimer);
    c.leaseTimer = null;
  }

  // One deadline per client, `leaseMs` from now; re-arming replaces it. A call
  // of its own in flight proves the client alive, so none runs meanwhile; a
  // local client's open stream does the same.
  function renewLease(c) {
    clearLease(c);
    if (isClosed() || c.callsInFlight > 0) return;
    if (!c.remote && c.sse) return;
    const reason = c.remote ? 'lease expired' : 'stream lapsed';
    c.leaseTimer = setTimeout(() => {
      c.leaseTimer = null;
      if (clients.get(c.token) === c) dropClient(c.token, reason);
    }, c.leaseMs);
    c.leaseTimer.unref?.();
  }

  /** A new client: a remote one starts its heartbeat lease, a local one the
   *  deadline its first stream attach clears. */
  function noteRegistered(c) {
    renewLease(c);
  }

  /** A heartbeat from a remote client renews its lease. */
  function noteTouched(c) {
    if (c.remote) renewLease(c);
  }

  function noteStreamAttached(c) {
    if (!c.remote) clearLease(c);
  }

  function noteStreamClosed(c) {
    if (c.remote || c.sse) return;
    // Its owning process died: it can never read a stream again.
    if (c.leadPid && !isPidAlive(c.leadPid)) {
      dropClient(c.token, 'lead pid gone');
      return;
    }
    renewLease(c);
  }

  function noteCallStarted(c) {
    c.callsInFlight += 1;
    clearLease(c);
  }

  /** The deadline restarts from the settle of the client's last call. */
  function noteCallSettled(c) {
    c.callsInFlight = Math.max(0, c.callsInFlight - 1);
    if (c.callsInFlight === 0) renewLease(c);
  }

  function stopTimers() {
    cancel();
    for (const c of clients.values()) clearLease(c);
  }

  return {
    lifecycleClientCount,
    cancel,
    maybeArm,
    noteLifecycleClient,
    noteLifecycleDropped,
    noteRegistered,
    noteTouched,
    noteStreamAttached,
    noteStreamClosed,
    noteCallStarted,
    noteCallSettled,
    clearLease,
    stopTimers,
  };
}
