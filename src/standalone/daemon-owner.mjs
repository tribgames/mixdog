// Whether the daemon-owner.json record still names a daemon, and how the
// daemon that owns a data dir keeps that record.
//
// Ownership itself is the OS lock the daemon holds for its whole life
// (daemon-owner-lock.mjs): acquiring it IS the claim, a contender that cannot
// acquire it yields, and no timer or stall can lose it. The record is what
// everyone else reads — launchers deciding whether to wait for a booting
// owner, the pg orphan sweep, checkpoint recovery — and what daemons from
// before the lock still arbitrate on. A lock holder's record carries
// `ownership: 'os-lock'`, its pid and process start time, plus the lease
// fields those older daemons understand (heartbeat, liveness port).
//
// A live pid proves nothing on its own. A daemon terminated without running
// its exit hooks (Windows shutdown, an installer or Task Manager ending the
// process tree) leaves its owner record behind, and the OS soon hands that pid
// to an unrelated process. A pid-only check then reported a live owner for as
// long as that process ran: every launcher waited for it to publish, every
// spawned candidate yielded to it, and the desktop failed every call with
// "daemon session endpoint is unavailable".
//
// Judging a record (launchers, and a lock holder facing a pre-lock record):
// - A record names `livenessPort` from its very first write: a loopback
//   listener started BEFORE the claim (startOwnerLivenessListener; in a lock
//   holder it runs on the freeze watchdog's thread, so it answers while the
//   main thread is frozen) answers /health with the pid for the process
//   lifetime.
// - A live-pid record is reclaimable only when its heartbeat looks stale
//   (wall clock: a reused pid never beats) AND that port, probed for the full
//   OWNER_PROBE_TIMEOUT_MS, does not answer with that pid — never on
//   wall-clock staleness alone, so a clock jump never reclaims a holder that
//   answers, booting or not.
// - A daemon that holds the lock replaces a lock-format record naming another
//   pid at once: its writer held the lock this process now holds, so it is
//   gone, whatever its pid looks like now.
//
// Migration: a pre-lock daemon takes no lock. A lock holder therefore honors
// a pre-lock record by the rules above and yields to a live one; a pre-lock
// daemon sees a lock holder's record as a lease it cannot reclaim while the
// liveness port answers.
//
// Records without a heartbeat come from v1.1.2 and older (and records with a
// heartbeat but no liveness port only from unreleased intermediate builds,
// judged the same way). Their pid matching the leftover daemon.json proves
// nothing — a crashed daemon leaves both files behind — so only the endpoint
// daemon.json publishes, answering with that pid, proves them alive.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isPidAlive } from '../runtime/shared/pid-liveness.mjs';
import { readSingletonOwner, refreshSingletonOwnerAsync } from '../runtime/shared/singleton-owner.mjs';

export const DAEMON_OWNER_STALE_MS = 60_000;
export const OWNER_PROBE_TIMEOUT_MS = 3_000;
const PROBE_BODY_MAX_BYTES = 1024 * 1024;

/** Marks a record written by a daemon holding the OS owner lock. */
export const OWNER_LOCK_OWNERSHIP = 'os-lock';

/**
 * Record timings. MIXDOG_DAEMON_OWNER_STALE_MS may only shorten the stale
 * threshold (tests); every process on one data dir must see the same value.
 * The holder rewrites its heartbeat six times per threshold, so readers that
 * judge by it (launchers, pre-lock daemons) rarely need to probe.
 */
export function daemonOwnerTimings(env = process.env) {
  const configured = Number(env.MIXDOG_DAEMON_OWNER_STALE_MS);
  const staleMs =
    Number.isFinite(configured) && configured > 0
      ? Math.min(DAEMON_OWNER_STALE_MS, Math.max(600, configured))
      : DAEMON_OWNER_STALE_MS;
  return { staleMs, heartbeatMs: Math.round(staleMs / 6) };
}

/** Whether `owner` was written by a daemon holding the OS owner lock. */
export function ownerRecordFromLockHolder(owner) {
  return owner?.ownership === OWNER_LOCK_OWNERSHIP;
}

/**
 * For a daemon that has just acquired the OS owner lock: whether a live-pid
 * record naming another pid gives way. A lock holder's record does (its
 * writer is gone); a pre-lock daemon's only by daemonOwnerIsStale.
 */
export function ownerRecordYieldsToLock(owner, options) {
  return ownerRecordFromLockHolder(owner) || daemonOwnerIsStale(owner, options);
}

/** daemon.json's pid and session endpoint, or null when missing/unreadable. */
function discoveryOf(parsed) {
  const session = parsed?.endpoints?.session;
  return { pid: Number(parsed?.pid) || 0, port: Number(session?.port) || 0, token: session?.token || '' };
}

export function readDiscovery(discoveryPath) {
  try {
    return discoveryOf(JSON.parse(readFileSync(discoveryPath, 'utf8')));
  } catch {
    return null;
  }
}

/** readDiscovery without blocking the event loop. */
export async function readDiscoveryAsync(discoveryPath) {
  try {
    return discoveryOf(JSON.parse(await readFile(discoveryPath, 'utf8')));
  } catch {
    return null;
  }
}

/** The pid daemon.json names, or 0 when it is missing or unreadable. */
export function discoveryPid(discoveryPath) {
  return readDiscovery(discoveryPath)?.pid || 0;
}

/**
 * The pid a session endpoint's /health reports (0 when it does not answer
 * with one), bounded by `timeoutMs` of TOTAL duration — a response trickling
 * in byte by byte cannot stretch it. `timedOut` tells a probe cut off by the
 * bound from one refused or answered.
 */
export function probeDaemonPid({ port, token = '', timeoutMs = OWNER_PROBE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    if (!(Number.isInteger(port) && port > 0 && port < 65_536)) {
      resolve({ pid: 0, timedOut: false });
      return;
    }
    let settled = false;
    let timer = null;
    let req = null;
    const finish = (pid, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ pid, timedOut });
      req?.destroy();
    };
    timer = setTimeout(() => finish(0, true), Math.max(1, timeoutMs));
    req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        agent: false,
        headers: token ? { 'X-Mixdog-Daemon-Token': token } : {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > PROBE_BODY_MAX_BYTES) finish(0);
        });
        res.on('end', () => {
          let health = null;
          try {
            health = JSON.parse(body);
          } catch {}
          finish(res.statusCode === 200 && health?.status === 'ok' ? Number(health.pid) || 0 : 0);
        });
        res.on('error', () => finish(0));
      }
    );
    req.on('error', () => finish(0));
  });
}

function olderThan(stamp, now, staleMs) {
  const at = Date.parse(String(stamp ?? ''));
  // A clock step in either direction must not keep a dead record fresh.
  return !Number.isFinite(at) || Math.abs(now - at) > staleMs;
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : 0;
}

/** The liveness port of a leased record (heartbeat + port), else 0. */
function leasedPort(owner) {
  return owner?.heartbeatAt !== undefined ? validPort(owner.livenessPort) : 0;
}

/**
 * The holder's owner-liveness listener: loopback /health answering this pid
 * (unauthenticated, like the session /health). Started before the claim so
 * the very first record names its port; it answers whenever the event loop of
 * the thread that started it runs (the freeze watchdog's, in a lock holder).
 * Resolves null when loopback cannot be bound — the record
 * then carries no port and is judged like a legacy one.
 */
export function startOwnerLivenessListener({ pid = process.pid, log = () => {} } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', pid }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.once('error', (error) => {
      log(`owner liveness listener unavailable: ${error?.message || error}`);
      resolve(null);
    });
    server.listen(0, '127.0.0.1', () => {
      // Never what keeps the process alive.
      server.unref();
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Liveness proof for a live-pid owner record that may be reclaimable.
 * Leased record (heartbeat + liveness port): null while the heartbeat looks
 * fresh, else a probe of that port. Any other record (v1.1.2 and older, or an
 * intermediate build's record without a port): a probe of the endpoint
 * daemon.json publishes for that pid. Verdicts: `live` (answered with the
 * pid), `dead` (refused, answered otherwise, or silent for the full probe
 * timeout), `unknown` (silent for a probe cut short by `budgetMs`),
 * `unpublished` (legacy only: no endpoint to probe).
 */
export async function proveDaemonOwner(
  owner,
  {
    discoveryPath,
    now = Date.now(),
    staleMs = daemonOwnerTimings().staleMs,
    probe = probeDaemonPid,
    timeoutMs = OWNER_PROBE_TIMEOUT_MS,
    budgetMs = Number.POSITIVE_INFINITY,
  } = {}
) {
  const pid = Number(owner?.pid) || 0;
  if (!pid || !isPidAlive(pid)) return null;
  const limit = Math.max(1, Math.min(timeoutMs, budgetMs));
  const verdictOf = (answer) => {
    if (answer.pid === pid) return 'live';
    return answer.timedOut && limit < timeoutMs ? 'unknown' : 'dead';
  };
  const livenessPort = leasedPort(owner);
  if (livenessPort) {
    if (!olderThan(owner.heartbeatAt, now, staleMs)) return null;
    return { pid, verdict: verdictOf(await probe({ port: livenessPort, timeoutMs: limit })) };
  }
  const discovery = readDiscovery(discoveryPath);
  if (discovery?.pid !== pid || !validPort(discovery.port)) return { pid, verdict: 'unpublished' };
  return { pid, verdict: verdictOf(await probe({ port: discovery.port, token: discovery.token, timeoutMs: limit })) };
}

/** proveDaemonOwner for the record currently at `ownerPath`. */
export function proveDaemonOwnerRecord(ownerPath, options) {
  return proveDaemonOwner(readSingletonOwner(ownerPath).owner, options);
}

/**
 * Whether a live-pid owner record may be reclaimed (the pid check itself is
 * the caller's: readSingletonOwner / claimSingletonOwner), given `proof` from
 * proveDaemonOwner for its pid. Without that proof it stands.
 */
export function daemonOwnerIsStale(
  owner,
  { proof = null, now = Date.now(), staleMs = daemonOwnerTimings().staleMs } = {}
) {
  const pid = Number(owner?.pid) || 0;
  if (!pid || proof?.pid !== pid) return false;
  if (leasedPort(owner)) {
    // Only a failed probe of its liveness port, never staleness alone. The
    // heartbeat is re-checked: under the claim lock the holder may just have
    // beaten.
    return olderThan(owner.heartbeatAt, now, staleMs) && proof.verdict === 'dead';
  }
  if (proof.verdict === 'dead') return true;
  return proof.verdict === 'unpublished' && olderThan(owner.claimedAt, now, staleMs);
}

/**
 * The lock holder's record upkeep. Every `heartbeatMs` it rewrites `owner`
 * with a fresh wall-clock `heartbeatAt` under the claim lock (recreating a
 * deleted record), then calls `onBeat`. No span of time stops it: a busy
 * claim lock or a failed write is logged and retried, since the OS lock, not
 * the record, is the ownership.
 * - The record names another pid (a pre-lock daemon reclaimed it):
 *   `onSuperseded(record)`.
 * - `lockIntact()` turned false (the lock file was deleted or replaced, so a
 *   new daemon could lock another file): `onLockLost()`.
 * Both callbacks must make this process stop serving. `update(fields)` merges
 * new fields (a liveness listener's port) and resolves with the status of the
 * refresh that wrote them.
 *
 * Admission after a stall. A pre-lock daemon takes the record over when its
 * heartbeat looks stale and its liveness port does not answer — possible
 * while this main thread is frozen (the record goes unrefreshed) and its
 * liveness listener is down. Every turn gap over `stallMs` (noticed by the
 * `tickMs` timer or by `admit()` itself, whichever runs first after it; a
 * whole-process suspend counts too) therefore closes admission until a refresh
 * STARTED after the latest gap finds the record still naming this pid. A
 * refresh from before a gap proves nothing — it may have read the record
 * before the takeover — and that includes a gap while the refresh itself ran,
 * so the turn gap is observed again when it settles. A busy claim lock (a contender mid-claim) or a failed write keeps
 * it closed and is retried every tick; `admitAsync()` waits for that refresh.
 */
export function createOwnerRecordKeeper({
  ownerPath,
  owner,
  heartbeatMs,
  tickMs = 250,
  stallMs = 1000,
  now = Date.now,
  monoNow = () => performance.now(),
  refresh = refreshSingletonOwnerAsync,
  lockIntact = () => true,
  log = () => {},
  onBeat = () => {},
  onSuperseded,
  onLockLost,
}) {
  const record = { ...owner };
  let state = 'active';
  let timer = null;
  // The refresh in flight: { startedAt, done } (done: its settled status).
  let inFlight = null;
  let lastBeatAt = monoNow();
  let lastTurnAt = lastBeatAt;
  // When the latest unverified stall was noticed, else null.
  let stalledAt = null;

  function halt(next) {
    state = next;
    if (timer) clearInterval(timer);
    timer = null;
  }

  function noteTurn(t) {
    if (t - lastTurnAt > stallMs) stalledAt = t;
    lastTurnAt = t;
  }

  function settle(startedAt, result) {
    if (state !== 'active') return result.status;
    if (result.status === 'refreshed') {
      // A stall while it ran (no turn seen since) may postdate its read.
      noteTurn(monoNow());
      if (stalledAt !== null && startedAt >= stalledAt) stalledAt = null;
      onBeat();
    } else if (result.status === 'superseded') {
      halt('superseded');
      onSuperseded(result.owner);
    } else if (result.status === 'busy') log('owner record refresh skipped: claim lock busy');
    return result.status;
  }

  function beat() {
    if (state !== 'active') return null;
    if (!lockIntact()) {
      halt('lock-lost');
      onLockLost();
      return 'lock-lost';
    }
    if (inFlight) return 'pending';
    const startedAt = monoNow();
    lastBeatAt = startedAt;
    const written = { ...record, heartbeatAt: new Date(now()).toISOString() };
    const done = Promise.resolve()
      .then(() => refresh(ownerPath, written))
      .catch((error) => {
        log(`owner record refresh failed: ${error?.message || error}`);
        return { status: 'failed' };
      })
      .then((result) => {
        inFlight = null;
        return settle(startedAt, result);
      });
    inFlight = { startedAt, done };
    return 'pending';
  }

  /** The status of a refresh started at or after `from` (started if needed). */
  async function refreshSince(from) {
    while (state === 'active') {
      const current = inFlight;
      if (!current) {
        const started = beat();
        if (started !== 'pending') return started;
        continue;
      }
      const status = await current.done;
      if (current.startedAt >= from) return status;
    }
    return null;
  }

  function tick() {
    if (state !== 'active') return;
    const t = monoNow();
    noteTurn(t);
    if (stalledAt !== null ? !inFlight : t - lastBeatAt >= heartbeatMs) beat();
  }

  /** Gate for every register/call: closed after a stall until re-verified. */
  function admit() {
    if (state !== 'active') return false;
    noteTurn(monoNow());
    if (stalledAt === null) return true;
    if (!inFlight) beat();
    return false;
  }

  return {
    start() {
      if (timer || state !== 'active') return;
      timer = setInterval(tick, tickMs);
      timer.unref?.();
    },
    beat,
    tick,
    admit,
    /** admit(), waiting for the re-verifying refresh instead of refusing.
     *  The turn gap is observed again after every wait (admit() does): a
     *  stall during one needs a refresh started after it, a few at most. */
    async admitAsync() {
      for (let round = 0; round < 3; round += 1) {
        if (admit()) return true;
        if (state !== 'active') return false;
        if ((await refreshSince(stalledAt)) !== 'refreshed') return false;
      }
      return admit();
    },
    update(fields) {
      Object.assign(record, fields);
      return refreshSince(monoNow());
    },
    /** Settles with the in-flight refresh's status (null when none runs). */
    settled() {
      return inFlight?.done ?? Promise.resolve(null);
    },
    /** A stall is waiting to be re-verified (admission is closed). */
    get verifying() {
      return state === 'active' && stalledAt !== null;
    },
    /** Stop rewriting the record (shutdown). */
    stop() {
      if (state === 'active') halt('stopped');
    },
    get state() {
      return state;
    },
  };
}

