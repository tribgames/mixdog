// Whether the daemon-owner.json record still names a daemon, and the lease a
// daemon holds on it.
//
// A live pid proves nothing on its own. A daemon terminated without running
// its exit hooks (Windows shutdown, an installer or Task Manager ending the
// process tree) leaves its owner record behind, and the OS soon hands that pid
// to an unrelated process. A pid-only check then reported a live owner for as
// long as that process ran: every launcher waited for it to publish, every
// spawned candidate yielded to it, and the desktop failed every call with
// "daemon session endpoint is unavailable".
//
// Single-owner safety never rests on the wall clock:
// - Holder: keeps its lease in monotonic time since its last successful
//   refresh. An expired lease fences it (refuse work, shut down) instead of
//   being renewed, and every register/call asks `admit()` first. After an
//   event-loop stall nothing is served until a refresh under the claim lock
//   proves the record still names it — a contender's claim takes that lock.
//   A lease that ran out DURING such a stall (live when the loop stopped) is
//   the one exception to the fence: the holder never had a turn to refresh
//   or to fence, and a contender's reclaim is decided under the claim lock
//   against the record's heartbeat there (daemonOwnerIsStale re-checks it),
//   so a refresh that finds the record still naming this pid proves no
//   contender took it and none can on its earlier proof. Without that, a sole
//   daemon whose loop the machine starved past the lease killed itself and
//   every running turn with no other daemon to take over.
// - Holder's record names `livenessPort` from its very first claim: a tiny
//   loopback listener started BEFORE the claim (startOwnerLivenessListener)
//   answers /health with the pid, through boot and for the process lifetime.
// - Contender: may reclaim a live-pid record only when its heartbeat looks
//   stale (wall clock: a reused pid never beats) AND that port, probed for the
//   full OWNER_PROBE_TIMEOUT_MS, does not answer with that pid — never on
//   wall-clock staleness alone, so a clock jump never reclaims a holder that
//   answers, booting or not; a holder silent for that long has stalled past
//   `stallMs` and re-verifies before serving again.
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

/**
 * Lease timings. MIXDOG_DAEMON_OWNER_STALE_MS may only shorten the stale
 * threshold (tests); every process on one data dir must see the same value.
 * Six beats per threshold; fenced at two thirds of it (40 s of 60 s, leaving
 * the 15 s shutdown budget inside it); the lease is checked every `tickMs`
 * and a turn gap over `stallMs` (< OWNER_PROBE_TIMEOUT_MS) counts as a stall.
 */
export function daemonOwnerTimings(env = process.env) {
  const configured = Number(env.MIXDOG_DAEMON_OWNER_STALE_MS);
  const staleMs =
    Number.isFinite(configured) && configured > 0
      ? Math.min(DAEMON_OWNER_STALE_MS, Math.max(600, configured))
      : DAEMON_OWNER_STALE_MS;
  const heartbeatMs = Math.round(staleMs / 6);
  const tickMs = Math.min(250, Math.round(heartbeatMs / 4));
  return { staleMs, heartbeatMs, fenceMs: Math.round((staleMs * 2) / 3), tickMs, stallMs: tickMs * 4 };
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
 * the very first record names its port; it answers whenever this process's
 * event loop runs. Resolves null when loopback cannot be bound — the record
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
 * The holder's side of the lease, in monotonic time (`monoNow`). Every
 * `tickMs` it checks the lease, notices stalls, and every `heartbeatMs`
 * rewrites `owner` with a fresh wall-clock `heartbeatAt` under the claim lock
 * (recreating a deleted record), then calls `onBeat`.
 * - No successful refresh for `fenceMs`: fenced, never renewed (`onFenced`) —
 *   unless the lease ran out inside one stall (live when the loop stopped):
 *   then the refresh is retried every tick for `heartbeatMs` after the loop
 *   resumes, and fenced only if none succeeds by then.
 * - The record names another pid: `onSuperseded(record)`.
 * - A turn gap over `stallMs`: `admit()` refuses work until a refresh succeeds.
 *   The gap is logged once, with `describeStall(fromMono, toMono)` appended.
 * Both callbacks must make this process stop serving.
 */
export function createOwnerHeartbeat({
  ownerPath,
  owner,
  heartbeatMs,
  fenceMs,
  tickMs,
  stallMs,
  now = Date.now,
  monoNow = () => performance.now(),
  refresh = refreshSingletonOwnerAsync,
  log = () => {},
  describeStall = null,
  onBeat = () => {},
  onSuperseded,
  onFenced,
}) {
  const record = { ...owner };
  let state = 'active';
  let leaseFrom = monoNow();
  let lastRefreshAt = record.heartbeatAt ?? null;
  let lastBeatAt = leaseFrom;
  let lastTurnAt = leaseFrom;
  let needsVerify = false;
  // Monotonic time the loop resumed from a stall that outlived the lease.
  let stallResumedAt = null;
  // The refresh in flight: a promise of its settled status, else null.
  let pending = null;
  // When the latest stall was noticed: only a refresh started after it can
  // re-verify the record (an older one may have read it before the stall).
  let stallNotedAt = Number.NEGATIVE_INFINITY;
  let timer = null;

  function halt(next) {
    state = next;
    if (timer) clearInterval(timer);
    timer = null;
  }

  function leaseExpired(t) {
    return t - leaseFrom >= fenceMs;
  }

  // Expired and past re-verification: the refreshes failed while the loop
  // ran, or no refresh landed within `heartbeatMs` of resuming from a stall.
  function mustFence(t) {
    return leaseExpired(t) && !(stallResumedAt !== null && t - stallResumedAt < heartbeatMs);
  }

  function fence(t) {
    if (state !== 'active') return;
    halt('fenced');
    log(`owner lease not refreshed for ${Math.round(t - leaseFrom)}ms (last ${lastRefreshAt}) — fencing`);
    onFenced({ lastRefreshAt, sinceMs: Math.round(t - leaseFrom) });
  }

  function noteTurn(t) {
    const from = lastTurnAt;
    // Rebased before reporting: one long block is one gap, however many
    // callers (tick, admit) observe it afterwards.
    lastTurnAt = t;
    if (t - from <= stallMs) return;
    needsVerify = true;
    stallNotedAt = t;
    if (state === 'active' && !leaseExpired(from) && leaseExpired(t)) stallResumedAt = t;
    let detail = '';
    try {
      detail = describeStall?.(from, t) || '';
    } catch {
      /* attribution must not disturb the lease */
    }
    log(
      `event loop stalled ${Math.round(t - from)}ms — owner lease must be re-verified before serving` +
        (detail ? ` | ${detail}` : '')
    );
  }

  // A refresh's verdict, applied once it is known. Fenced, superseded or
  // stopped while it ran: nothing is renewed. A renewal counts from the
  // moment the refresh started (`t`), never from when it answered.
  function settle(t, heartbeatAt, result) {
    if (state !== 'active') return result.status;
    if (result.status === 'refreshed') {
      if (leaseExpired(t)) {
        log(
          `owner lease re-verified ${Math.round(t - leaseFrom)}ms after its last refresh (event-loop stall)` +
            ' — the record still names this process; serving again'
        );
      }
      leaseFrom = t;
      lastRefreshAt = heartbeatAt;
      if (t >= stallNotedAt) {
        needsVerify = false;
        stallResumedAt = null;
      }
      onBeat();
    } else if (result.status === 'superseded') {
      halt('superseded');
      onSuperseded(result.owner);
    } else if (result.status === 'busy') {
      log('owner heartbeat skipped: claim lock busy');
    }
    return result.status;
  }

  function failedRefresh(error) {
    log(`owner heartbeat failed: ${error?.message || error}`);
    return { status: 'failed' };
  }

  // One refresh at a time. An asynchronous refresh (the default: its file
  // work and lock retries never block the loop) answers 'pending' here and
  // settles later; the lease and fence keep their monotonic deadlines while
  // it runs — a refresh still unanswered at the fence does not hold it off.
  function beat() {
    if (state !== 'active') return null;
    if (pending) return 'pending';
    const t = monoNow();
    lastBeatAt = t;
    // Checked before every renewal: an overdue beat must fence, not extend a
    // lease a contender may already have reclaimed — except right after a
    // stall that outlived the lease, where the refresh itself (under the
    // claim lock) answers whether one did.
    if (mustFence(t)) {
      fence(t);
      return 'fenced';
    }
    const heartbeatAt = new Date(now()).toISOString();
    let result;
    try {
      result = refresh(ownerPath, { ...record, heartbeatAt });
    } catch (error) {
      result = failedRefresh(error);
    }
    if (typeof result?.then !== 'function') return settle(t, heartbeatAt, result);
    pending = result
      .then(
        (value) => value,
        (error) => failedRefresh(error)
      )
      .then((value) => {
        pending = null;
        return settle(t, heartbeatAt, value);
      });
    return 'pending';
  }

  function tick() {
    if (state !== 'active') return;
    const t = monoNow();
    noteTurn(t);
    if (mustFence(t)) fence(t);
    else if (needsVerify ? t - lastBeatAt >= tickMs : t - lastBeatAt >= heartbeatMs) beat();
  }

  return {
    start() {
      if (timer || state !== 'active') return;
      timer = setInterval(tick, tickMs);
      timer.unref?.();
    },
    /** Gate for every register/call: true while the lease is held and verified. */
    admit() {
      if (state === 'fenced' || state === 'superseded') return false;
      const t = monoNow();
      // Shutting down: no ticks run to measure stalls; the lease still bounds it.
      if (state === 'stopped') return !leaseExpired(t);
      noteTurn(t);
      if (mustFence(t)) {
        fence(t);
        return false;
      }
      // Re-verified at most once per tick: a busy claim lock must not block
      // the loop on every request.
      if (needsVerify && t - lastBeatAt >= tickMs) beat();
      return state === 'active' && !needsVerify;
    },
    /** admit(), but a request arriving while the lease is being re-verified
     *  waits for the verifying refresh instead of being refused outright: at
     *  most two refreshes (one started before the stall cannot verify). */
    async admitAsync() {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (this.admit()) return true;
        if (!pending) return false;
        await pending;
      }
      return this.admit();
    },
    beat,
    tick,
    /** Settles with the in-flight refresh's status (null when none runs). */
    settled() {
      return pending ?? Promise.resolve(null);
    },
    /** Stop beating (shutdown). admit() keeps refusing once the lease runs out. */
    stop() {
      if (state === 'active') halt('stopped');
    },
    get state() {
      return state;
    },
  };
}
