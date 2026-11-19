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
    let child;
    try {
      const args = desktopConfirmationPipe ? ['serve', '--desktop-confirmation-pipe'] : ['serve'];
      const pipe = desktopConfirmationPipe ? 'pipe' : 'ignore';
      child = spawnImpl(bin, args, { detached, stdio: [pipe, pipe, capture.stderrStdio], windowsHide: true, env });
    } catch (error) {
      capture.noteSpawnError(error);
      reject(new Error(`cannot start ${bin}: ${error.message}`));
      return;
    }
    capture.track(child, { detached });
    child.once('error', (error) => reject(new Error(`cannot start ${bin}: ${error.message}`)));
    child.once('spawn', () => {
      child.stderr?.unref?.();
      child.unref();
      resolve(capture);
    });
  });
}

/**
 * `core is not ready`, naming what the launcher saw last. When it started no core of its own, the core is not blocked
 * (a blocked core names its own reason) and a live process holds the data directory without ever having published an
 * endpoint, that owner is named (its pid), so the user knows what to end instead of reading only that no core published
 * its endpoint.
 */
function notReadyError(last, { launched = true } = {}) {
  const state = last ? `the core is ${last.state}` : 'no core published its endpoint';
  const detail = last?.blocked ? ` (${JSON.stringify(last.blocked)})` : '';
  const owner = !launched && !last?.blocked && last && Number.isInteger(last.pid) && !last.rpcPort
    ? `; its owner (pid ${last.pid}) is alive and holds the data directory but has not published an endpoint`
    : '';
  return Object.assign(new Error(`core is not ready: ${state}${detail}${owner}`), { coreDiscovery: last ?? null });
}

/**
 * The core this launcher started has ended without serving, when nothing else can still bring one up: it ended
 * abnormally (a clean exit is a contender that lost the claim to another core, which is waited for), and discovery
 * names no core or names the ended one. Null while that is not known.
 */
function endedBeforeServing(capture, last) {
  const record = capture?.snapshot?.();
  if (!record?.exitedAt) return null;
  if (record.exitCode === 0 && !record.exitSignal) return null;
  if (last && last.state !== 'legacy' && last.pid !== record.pid) return null;
  const summary = capture.summary?.() ?? {};
  const reason = summary.exitReason || (record.exitSignal ? `killed by ${record.exitSignal}` : `exited with code ${record.exitCode ?? '?'}`);
  const said = summary.stderrErrorLine || summary.stderrLastLine;
  return Object.assign(new Error(`core is not ready: the core ended before serving (${reason})${said ? `: ${said}` : ''}`), {
    coreDiscovery: last ?? null,
    coreExit: {
      code: record.exitCode ?? null,
      signal: record.exitSignal ?? null,
      // The recorded reason (a field of the record, not a quote of stderr): what the exit is told apart by.
      reason: summary.exitReason ?? null,
      stderrPath: summary.stderrPath ?? null,
    },
  });
}

/** Whether the core `last` names says it is in a state that ends by itself and answers its control listener unstalled. */
async function atWork(last, ping) {
  if (!last || !SELF_ENDING_STATES.has(last.state) || !last.controlPort || !last.token) return false;
  const { answered, stalledMs } = await ping(last);
  return answered && stalledMs === 0;
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
 * Resolves the serving core's discovery. A `blocked` core is the user's decision, so it fails at once instead of
 * waiting; `booting`, `migrating` and `draining` end by themselves, so they are waited out. A core this call started
 * that ends abnormally before serving fails at once too, with its exit and what it last said.
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
} = {}) {
  let deadline = now() + Math.max(1, readyTimeoutMs);
  let launched = false;
  let capture = null;
  let last = null;
  let quiet = 0;
  let quietSeen = null;
  // What the core says its index rebuild has come to (`{done, total}` sessions), told when it changes; null when none runs.
  const tell = contained(onProgress);
  // `boot` names the core process the counts are of: the counts of one boot only grow, and a new boot starts again.
  let told = null;
  let toldBoot = null;
  const report = (progress, boot = null) => {
    const of = progress ? boot : null;
    if (progress?.done === told?.done && progress?.total === told?.total && of === toldBoot) return;
    told = progress;
    toldBoot = of;
    tell(progress, of);
  };
  // A report belongs to this call: however it ends (serving, a refusal, a read that fails, the deadline) the last one is withdrawn.
  try {
    for (;;) {
      if (now() >= deadline) {
        if (!(await atWork(last, ping))) break;
        // A core that answers but has said nothing new (its state and its counts) for `STALLED_WINDOWS` windows in a row is not at
        // work in any way the person can see: that is an error, not a wait that never ends.
        const seen = `${last.state}:${last.rebuild?.done ?? ''}/${last.rebuild?.total ?? ''}`;
        quiet = seen === quietSeen ? quiet + 1 : 0;
        quietSeen = seen;
        if (quiet >= STALLED_WINDOWS) {
          throw Object.assign(notReadyError(last, { launched }), {
            message: `core is not ready: the core is ${last.state} and has reported no progress for ${Math.round((quiet * readyTimeoutMs) / 1000)} s`,
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
      report(last?.rebuild ?? null, last?.pid ?? null);
      if (last?.state === 'serving' && last.rpcPort) {
        capture?.noteReady?.();
        return last;
      }
      if (last?.state === 'blocked') throw notReadyError(last, { launched });
      const ended = endedBeforeServing(capture, last);
      if (ended) throw ended;
      // A legacy endpoint cannot serve this client. Start the Rust contender so
      // its ownership gate can judge the old process; the launcher never stops it.
      if ((!last || last.state === 'legacy') && !launched) {
        launched = true;
        log('starting core');
        capture = await launch({ log });
      }
      await sleep(Math.min(POLL_MS, Math.max(1, deadline - now())));
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
      if (!discovery || discovery.state !== 'serving' || !Number.isInteger(discovery.pid) || discovery.pid !== owned
        || !discovery.controlPort || !discovery.token || !runs(discovery.pid)) {
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
      // Said before the kill, with why: no answer to the status ask, or an answer that reports a stalled runtime.
      // Said with why (no answer to the status ask, or an answer reporting a stalled runtime); `say` is never on the kill's path.
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
  return { stop: () => { stopped = true; }, done };
}
