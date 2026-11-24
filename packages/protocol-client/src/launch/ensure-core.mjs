// Launcher side of "attach or start": reads discovery, starts a core when none runs, and waits until discovery
// says `serving` (lifecycle spec §5.4: "launcher start = spawn detached → discovery serving").
import { spawn } from 'node:child_process';
import { beginDaemonSpawnCapture } from './crash-capture/spawn-capture.mjs';
import { contained } from '../link-log.mjs';

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const POLL_MS = 50;
/** How many ready windows in a row an at-work core may report nothing new before the wait fails. */
const STALLED_WINDOWS = 6;
/** The states of a running core that end by themselves (lifecycle spec §5.4). */
const SELF_ENDING_STATES = new Set(['booting', 'migrating', 'draining']);

/**
 * Starts `mixdogd serve` detached from this process, so closing the terminal never stops running work. A launcher
 * that owns its core (`detached: false`, the desktop app) starts it as an ordinary child instead: the core ends with
 * the launcher and belongs to its process group. Its fd 2 goes
 * to the boot's crash capture (`<data>/daemon-crash`), whose sidecar the core fills with its own exit; resolves the
 * capture.
 */
export function launchCore({
  bin = process.env.MIXDOGD_BIN || 'mixdogd',
  env = process.env,
  spawnImpl = spawn,
  log = () => {},
  beginCapture = beginDaemonSpawnCapture,
  detached = true,
  desktopConfirmationPipe = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const capture = beginCapture({ launcher: 'core', log });
    // `coreSpawnFailed`: no process was started (a missing or unrunnable binary), so there is no exit to wait for or compare.
    const notStarted = (error) =>
      Object.assign(new Error(`cannot start ${bin}: ${error.message}`), {
        coreSpawnFailed: { bin, code: error.code ?? null },
      });
    let child;
    try {
      const args = desktopConfirmationPipe ? ['serve', '--desktop-confirmation-pipe'] : ['serve'];
      const pipe = desktopConfirmationPipe ? 'pipe' : 'ignore';
      child = spawnImpl(bin, args, { detached, stdio: [pipe, pipe, capture.stderrStdio], windowsHide: true, env });
    } catch (error) {
      capture.noteSpawnError(error);
      reject(notStarted(error));
      return;
    }
    capture.track(child, { detached });
    child.once('error', (error) => reject(notStarted(error)));
    child.once('spawn', () => {
      child.stderr?.unref?.();
      child.unref();
      resolve(capture);
    });
  });
}

function notReadyError(last, { launched = true } = {}) {
  const state = last ? `the core is ${last.state}` : 'no core published its endpoint';
  const owner =
    !launched && !last?.blocked && last && Number.isInteger(last.pid) && !last.rpcPort
      ? `; its owner (pid ${last.pid}) is alive and holds the data directory but has not published an endpoint`
      : '';
  return Object.assign(new Error(`core is not ready: ${state}${owner}`), { coreDiscovery: last ?? null });
}

/** The process a start waits on before it can own the data directory: the one a `blocked` core names, or the earlier version's
 *  daemon this launcher asked to step aside (`retiring`, with what it answered). `coreBlockedAccess` is how the launcher can act
 *  on it (the blocked core's control listener, the earlier daemon's own endpoint): credentials, never shown. */
function blockedError(pid, last, retiring, message) {
  const blocked = last?.state === 'blocked' ? last.blocked : null;
  const legacy = last?.state === 'legacy' && last.pid === pid ? last : retiring?.pid === pid ? retiring.endpoint : null;
  return Object.assign(new Error(`core is not ready: ${message}`), {
    coreDiscovery: last ?? null,
    coreBlocked: {
      pid,
      kind: blocked?.kind ?? 'waitExit',
      image: typeof blocked?.image === 'string' && blocked.image ? blocked.image : null,
      commandLine: typeof blocked?.commandLine === 'string' && blocked.commandLine ? blocked.commandLine : null,
      // Only the core's `release{pid}` may let a start past an owner the core could not prove: the core publishes such a block as
      // `undecidable`, and one it waits out with no release as `waitExit` (mgmt.rs `Blocked`).
      releasable: blocked?.kind === 'undecidable',
      // The earlier version's daemon, when it is the process: what it answered when asked to step aside (null when it was not asked).
      legacy: Boolean(legacy) || blocked?.kind === 'waitExit',
      retire: retiring?.pid === pid ? retiring.answer : null,
    },
    coreBlockedAccess: {
      core: blocked && last.controlPort && last.token ? { controlPort: last.controlPort, token: last.token } : null,
      legacy: legacy?.sessionPort && legacy?.token ? { port: legacy.sessionPort, token: legacy.token } : null,
    },
  });
}

/** The pid a `blocked` discovery names. */
function blockerOf(last) {
  return last?.state === 'blocked' && Number.isInteger(last.blocked?.pid) ? last.blocked.pid : null;
}

/** A start waits on the earlier version's daemon `retiring` asked to step aside, which agreed: it ends once its running work has. */
function waitsOnRetiring(last, retiring) {
  if (!retiring?.accepted || !last) return false;
  return (last.state === 'legacy' && last.pid === retiring.pid) || blockerOf(last) === retiring.pid;
}

/** What the person waiting is shown: what the core does before it serves (the conversion of the earlier version's data, the
 *  index rebuild) with the counts the file names of it, or the earlier daemon it waits on. */
function stageOf(last, retiring) {
  if (waitsOnRetiring(last, retiring)) return { stage: 'legacy', done: 0, total: 0 };
  const counts = { done: last?.rebuild?.done ?? 0, total: last?.rebuild?.total ?? 0 };
  if (last?.state === 'migrating') return { stage: 'migration', ...counts };
  if (last?.rebuild) return { stage: 'rebuild', ...counts };
  return null;
}

function endedBeforeServing(capture, last) {
  const record = capture?.snapshot?.();
  if (!record?.exitedAt) return null;
  // A contender that yields (exit 0: another process holds the data directory's lock) while the file names no other core is a start
  // that ended too: what holds the lock has published nothing to attach to, and the record says so.
  if (last && last.state !== 'legacy' && last.pid !== record.pid) return null;
  const summary = capture.summary?.() ?? {};
  const reason =
    summary.exitReason ||
    (record.exitSignal ? `killed by ${record.exitSignal}` : `exited with code ${record.exitCode ?? '?'}`);
  const said = summary.stderrErrorLine || summary.stderrLastLine;
  return Object.assign(
    new Error(`core is not ready: the core ended before serving (${reason})${said ? `: ${said}` : ''}`),
    {
      coreDiscovery: last ?? null,
      coreExit: {
        code: record.exitCode ?? null,
        signal: record.exitSignal ?? null,
        // The recorded reason (a field of the record, not a quote of stderr): what the exit is told apart by.
        reason: summary.exitReason ?? null,
        stderrPath: summary.stderrPath ?? null,
      },
    }
  );
}

/** Whether the core `last` names says it is in a state that ends by itself and answers its control listener unstalled. A wait on
 *  the earlier version's daemon that agreed to step aside ends by itself too: while it runs (the file may name it, or the core
 *  blocked on it, which answers its control listener). */
async function atWork(last, ping, retiring) {
  if (!last) return false;
  if (last.state === 'legacy') return waitsOnRetiring(last, retiring);
  if (!(SELF_ENDING_STATES.has(last.state) || waitsOnRetiring(last, retiring)) || !last.controlPort || !last.token)
    return false;
  const { answered, stalledMs } = await ping(last);
  return answered && stalledMs === 0;
}

function rebuildReporter(onProgress) {
  const tell = contained(onProgress);
  let told = null;
  let toldBoot = null;
  return (progress, boot = null) => {
    const of = progress ? boot : null;
    if (
      progress?.stage === told?.stage &&
      progress?.done === told?.done &&
      progress?.total === told?.total &&
      of === toldBoot
    )
      return;
    told = progress;
    toldBoot = of;
    tell(progress, of);
  };
}

/** Whether the process `pid` still runs (a process this user may not signal runs too). */
export function processRuns(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * What a launcher knows of the earlier version's daemons it asked to step aside (`retireLegacy`), one fact for every attempt
 * that shares it: each daemon is asked once, whichever attempt saw it first, and an attempt that sees only the core blocked on
 * it (its file replaced by the core's) gets the same answer and the daemon's own endpoint.
 */
export function legacyRetirement(retireLegacy = async () => null) {
  const asked = new Map();
  return {
    /** Asks the daemon `last` names, once; resolves `{pid, accepted, answer, endpoint}`. */
    ask(last) {
      let record = asked.get(last.pid);
      if (!record) {
        record = Promise.resolve(retireLegacy(last)).then((answer) => ({
          pid: last.pid,
          accepted: answer?.accepted === true,
          answer: answer ?? null,
          endpoint: { sessionPort: last.sessionPort ?? null, token: last.token ?? null },
        }));
        asked.set(last.pid, record);
      }
      return record;
    },
    /** What `pid` answered (once it has), or null when it was never asked. */
    of(pid) {
      return asked.get(pid) ?? Promise.resolve(null);
    },
  };
}

/**
 * Resolves the serving core's discovery. A `blocked` core is the user's decision, so it fails at once instead of
 * waiting (`coreBlocked` names the process), unless it waits on the earlier version's daemon that `retirement` asked to
 * step aside and that agreed; `booting`, `migrating` and `draining` end by themselves, so they are waited out. A core this
 * call started that ends before serving fails at once too, with its exit and what it last said (a contender that yielded
 * the data directory's lock to a holder that names no core included).
 *
 * A discovery file outlives a process that was killed (and the 1.4.5 daemon wrote the same file): one that names a
 * process no longer running names no core, so a core is started as when there is no file. Waiting for it never ends.
 *
 * `readyTimeoutMs` is how long a core may go without being known to be at work. When it has passed, a running core
 * that says it is `booting`, `migrating` or `draining` is asked over its control listener: one that answers with a
 * runtime that is not stalled is at work (a first start builds the session index from every log, a migration converts
 * the data) and is waited for that long again; its end is its own to report (`serving`, `blocked`, or its exit). A
 * process that holds the data directory and answers nothing is not waited for further.
 */
export async function ensureCore({
  readDiscovery,
  launch = launchCore,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  readyTimeoutMs = Number(process.env.MIXDOG_DAEMON_READY_TIMEOUT_MS) || DEFAULT_READY_TIMEOUT_MS,
  now = Date.now,
  log = () => {},
  runs = processRuns,
  ping = pingCore,
  onProgress = () => {},
  retireLegacy = async () => null,
  retirement = legacyRetirement(retireLegacy),
} = {}) {
  let deadline = now() + Math.max(1, readyTimeoutMs);
  let launched = false;
  let capture = null;
  let last = null;
  let quiet = 0;
  let quietSeen = null;
  /** The earlier version's daemon asked to step aside (by this call or another sharing `retirement`), and whether it agreed. */
  let retiring = null;
  const report = rebuildReporter(onProgress);
  try {
    for (;;) {
      if (now() >= deadline) {
        if (!(await atWork(last, ping, retiring))) break;
        // A core that answers but has said nothing new (its state and its counts) for `STALLED_WINDOWS` windows in a row is not at
        // work in any way the person can see: that is an error, not a wait that never ends.
        const seen = `${last.state}:${last.rebuild?.done ?? ''}/${last.rebuild?.total ?? ''}`;
        quiet = seen === quietSeen ? quiet + 1 : 0;
        quietSeen = seen;
        if (quiet >= STALLED_WINDOWS) {
          const quietFor = Math.round((quiet * readyTimeoutMs) / 1000);
          if (waitsOnRetiring(last, retiring)) {
            throw blockedError(
              retiring.pid,
              last,
              retiring,
              `the earlier Mixdog (pid ${retiring.pid}) agreed to close but has not finished its running work for ${quietFor} s`
            );
          }
          throw Object.assign(notReadyError(last, { launched }), {
            message: `core is not ready: the core is ${last.state} and has reported no progress for ${quietFor} s`,
          });
        }
        log(`core ${last.state}: still at work, waiting`);
        deadline = now() + Math.max(1, readyTimeoutMs);
      }
      try {
        last = await readDiscovery();
      } catch (error) {
        if (error?.name !== 'CoreDiscoveryError' || error.code !== 'absent') throw error;
        last = null;
      }
      if (last && Number.isInteger(last.pid) && !runs(last.pid)) last = null;
      // The earlier version's daemon is asked once to step aside, before anything is started against it: it answers to a newer
      // build by closing once its running work has ended (what it did for every newer 1.4 build), so the start resolves itself.
      // An attempt that finds the core blocked on it takes what it answered.
      const retiringPid = last?.state === 'legacy' ? last.pid : blockerOf(last);
      if (retiringPid !== null && retiringPid !== undefined && retiring?.pid !== retiringPid) {
        const known = await (last.state === 'legacy' ? retirement.ask(last) : retirement.of(retiringPid));
        if (known) {
          retiring = known;
          if (known.accepted) log(`the earlier daemon (pid ${known.pid}) agreed to close once its work ends`);
        }
      }
      report(stageOf(last, retiring), last?.pid ?? null);
      if (last?.state === 'serving' && last.rpcPort) {
        capture?.noteReady?.();
        return last;
      }
      // A block on the daemon that agreed to close ends with it; any other is the person's to resolve.
      const blocker = blockerOf(last);
      if (last?.state === 'blocked' && !waitsOnRetiring(last, retiring)) {
        throw blockedError(
          blocker,
          last,
          retiring,
          blocker === null
            ? 'the core is blocked by an earlier owner of the data directory'
            : `the data directory is held by an earlier process (pid ${blocker})`
        );
      }
      const ended = endedBeforeServing(capture, last);
      if (ended) throw ended;
      // A legacy endpoint cannot serve this client. Start the Rust contender so
      // its ownership gate can judge the old process (waiting for it to close when it agreed to).
      if ((!last || last.state === 'legacy') && !launched) {
        launched = true;
        log('starting core');
        capture = await launch({ log });
      }
      await sleep(Math.min(POLL_MS, Math.max(1, deadline - now())));
    }
    // The earlier version's daemon that did not agree to close (or did not answer) still holds the data directory: the core
    // started against it waits on it, and the file names the daemon again (it republishes over the core's).
    if (last?.state === 'legacy') {
      throw blockedError(
        last.pid,
        last,
        retiring,
        `the earlier Mixdog (pid ${last.pid}) still holds the data directory`
      );
    }
    throw notReadyError(last, { launched });
  } finally {
    report(null);
  }
}

/** How often the launcher asks its core whether it still answers. */
export const CORE_PING_INTERVAL_MS = 5_000;
/** How long one ask may take before it counts as unanswered. */
export const CORE_PING_TIMEOUT_MS = 4_000;
/**
 * How long a core may answer nothing, awake, before it is ended: the old supervisor's freeze limit
 * (`DAEMON_FREEZE_LIMIT_MS`, 120 s). The core's own stall monitor ends its process at the same limit, so a core whose launcher has
 * gone (one started detached by the CLI) does not outlive its hang either.
 */
export const CORE_UNANSWERED_LIMIT_MS = 120_000;
/** A look this much later than the interval says the machine slept: the time unanswered starts again. */
export const CORE_SLEEP_GAP_MS = 5_000;

/**
 * Asks the core named by `discovery` over its control listener (a thread of its own, so it answers while the runtime is
 * wedged). `answered` is false for no answer within `timeoutMs` and for a refusal; when it answered, `stalledMs` is how long
 * its runtime has answered nothing (the control status's `stalledMs`).
 */
export async function pingCore(discovery, { timeoutMs = CORE_PING_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${discovery.controlPort}/mgmt/status`, {
      headers: { authorization: `Bearer ${discovery.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { answered: false, stalledMs: 0 };
    const status = await response.json();
    return { answered: true, stalledMs: Math.max(0, Number(status?.stalledMs) || 0) };
  } catch {
    return { answered: false, stalledMs: 0 };
  }
}

/**
 * Ends a core of this launcher that has stopped answering (a hung core serves nothing and nobody else would end it).
 * Every `intervalMs` the serving core that `ownedPid()` names is asked over its control listener; once it has answered
 * nothing for `unansweredLimitMs` of awake time (no answer, or a runtime reporting a stall that long) the process is killed
 * and `onKilled` is told, and the next attach-or-start launches a replacement (the dead pid names no core). A core this
 * launcher did not start is never touched; a core started detached by a launcher that has gone ends itself at the same
 * limit (its stall monitor). Returns `stop()`.
 */
export function watchCore({
  readDiscovery,
  ownedPid,
  ping = pingCore,
  kill = (pid) => process.kill(pid, 'SIGKILL'),
  onKilled = () => {},
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  now = Date.now,
  intervalMs = CORE_PING_INTERVAL_MS,
  unansweredLimitMs = CORE_UNANSWERED_LIMIT_MS,
  runs = processRuns,
  log = () => {},
  onEnding = () => {},
} = {}) {
  const say = contained(onEnding);
  let stopped = false;
  let unansweredSince = null;
  let watched = null;
  let looked = now();
  const done = (async () => {
    while (!stopped) {
      await sleep(intervalMs);
      if (stopped) break;
      const at = now();
      // The machine slept (or this process was not scheduled): what looks like a long silence is not the core's.
      if (at - looked > intervalMs + CORE_SLEEP_GAP_MS) unansweredSince = null;
      looked = at;
      let discovery;
      try {
        discovery = await readDiscovery();
      } catch {
        unansweredSince = null;
        continue;
      }
      const owned = ownedPid();
      if (
        discovery?.state !== 'serving' ||
        !Number.isInteger(discovery.pid) ||
        discovery.pid !== owned ||
        !discovery.controlPort ||
        !discovery.token ||
        !runs(discovery.pid)
      ) {
        unansweredSince = null;
        continue;
      }
      if (watched !== discovery.pid) {
        watched = discovery.pid;
        unansweredSince = null;
      }
      const { answered, stalledMs } = await ping(discovery);
      if (answered && stalledMs === 0) {
        unansweredSince = null;
        continue;
      }
      unansweredSince ??= at;
      const unansweredFor = Math.max(stalledMs, answered ? 0 : now() - unansweredSince);
      if (unansweredFor < unansweredLimitMs) continue;
      log(`core ${discovery.pid} has answered nothing for ${Math.round(unansweredFor / 1000)} s: ending it`);
      // Said before the kill, with why (no answer to the status ask, or an answer reporting a stalled runtime); `say` is never on the kill's path.
      say({
        pid: discovery.pid,
        reason: answered ? 'runtimeStalled' : 'statusUnanswered',
        unansweredMs: Math.round(unansweredFor),
        stalledMs,
        limitMs: unansweredLimitMs,
      });
      try {
        kill(discovery.pid);
      } catch (error) {
        if (error?.code !== 'ESRCH') log(`core ${discovery.pid} could not be ended: ${error?.message ?? error}`);
      }
      unansweredSince = null;
      watched = null;
      await onKilled(discovery);
    }
  })();
  return {
    stop: () => {
      stopped = true;
    },
    done,
  };
}
