// Freeze recovery for the daemon's main thread, watched from outside it.
//
// The daemon's ownership is an OS lock held for the process lifetime
// (daemon-owner-lock.mjs), so a stalled main thread no longer loses it — and
// a main thread that never comes back would hold it, and every client, for
// good. A worker thread watches a progress counter the main thread bumps every
// `pulseMs` (SharedArrayBuffer + Atomics); when the main thread has made no
// progress for `limitMs` of time this worker itself witnessed, it has its
// diagnostics written and kills the whole process — when they are written or
// at a short deadline, whichever comes first — which the launcher replaces and
// whose lock the kernel releases.
//
// Two witnesses: both threads read process.hrtime (one monotonic clock for
// every thread; performance.now() has a per-thread origin), and only an
// interval between two regular watchdog ticks counts as frozen time. A whole
// process suspended (laptop sleep, a debugger, a starved machine) advances the
// clock without any watchdog tick and is never counted.
//
// The worker also hosts the owner-liveness listener the owner record names
// (daemon-owner.mjs): an older daemon or launcher probing it gets an answer
// while the main thread is frozen, so it never reclaims a process that still
// holds the lock.
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { workerExecArgv } from '../runtime/shared/worker-exec-argv.mjs';

export const DAEMON_FREEZE_LIMIT_MS = 120_000;
// A main-thread turn gap logged as an event-loop stall (diagnostics only).
export const STALL_LOG_MS = 1000;
const WORK_KEYS = Object.freeze(['activeCalls', 'queuedCalls', 'busySessions', 'busyMemoryAgents', 'turnBusySessions']);
// Layout: BigInt64 [progress counter, hrtime ns of the last progress], then
// one Int32 per WORK_KEYS entry (in-flight counts mirrored at each pulse),
// then one Int32 a watchdog sets when it is the one ending the process.
const WORK_OFFSET = 16;
const KILL_OFFSET = WORK_OFFSET + 4 * WORK_KEYS.length;
const BUFFER_BYTES = KILL_OFFSET + 4;
// Redundant watchdog threads, each judging and able to kill on its own.
export const WATCHDOG_WORKERS = 2;

/**
 * MIXDOG_DAEMON_FREEZE_LIMIT_MS overrides the limit (tests shorten it). The
 * watchdog ticks 20 times per limit (at most every second); a tick gap over
 * `suspendGapMs` means the watchdog was not running either.
 */
export function freezeWatchdogTimings(env = process.env) {
  const configured = Number(env.MIXDOG_DAEMON_FREEZE_LIMIT_MS);
  const limitMs =
    Number.isFinite(configured) && configured > 0 ? Math.max(500, Math.round(configured)) : DAEMON_FREEZE_LIMIT_MS;
  const tickMs = Math.max(25, Math.min(1000, Math.round(limitMs / 20)));
  return { limitMs, tickMs, pulseMs: Math.min(250, tickMs), suspendGapMs: Math.max(2000, tickMs * 5) };
}

export function freezeSharedViews(buffer) {
  return {
    beats: new BigInt64Array(buffer, 0, 2),
    work: new Int32Array(buffer, WORK_OFFSET, WORK_KEYS.length),
    kill: new Int32Array(buffer, KILL_OFFSET, 1),
  };
}

export function readMirroredWork(work) {
  return Object.fromEntries(WORK_KEYS.map((key, index) => [key, Atomics.load(work, index)]));
}

function count(value) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.max(0, Math.min(0x7fffffff, number)) : 0;
}

/**
 * The watchdog's verdict, fed once per watchdog tick with the monotonic time
 * (ms) and the main thread's progress counter: the main thread's witnessed
 * freeze so far (0 right after progress). An interval longer than
 * `suspendGapMs` between two ticks proves nothing about the main thread (this
 * thread did not run either) and is left out.
 */
export function createFreezeJudge({ suspendGapMs }) {
  let lastTickAt = null;
  let lastProgress;
  let frozenMs = 0;
  return {
    observe(nowMs, progress) {
      const gap = lastTickAt === null ? 0 : nowMs - lastTickAt;
      lastTickAt = nowMs;
      if (progress !== lastProgress) {
        lastProgress = progress;
        frozenMs = 0;
      } else if (gap <= suspendGapMs) {
        frozenMs += Math.max(0, gap);
      }
      return frozenMs;
    },
  };
}

/**
 * Main-thread side: the progress pulse and the watchdog workers' lifecycle.
 *
 * `workers` redundant threads (two) each judge the main thread and can end
 * the process on their own. Restarting one is the main thread's job, and a
 * main thread frozen right after a worker died can do nothing — with one
 * worker that freeze was never ended. With two, freeze recovery is lost only
 * while both are down at once; each costs an idle isolate (a few MB).
 *
 * `start()` resolves with an owner-liveness port (the lowest-numbered ready
 * worker's listener), or null when none reported ready in `readyTimeoutMs`.
 * From then on every change of that port — a late ready, a worker exiting or
 * coming back — goes to `onLivenessPort(port)`, null when no worker is ready.
 *
 * A worker that exits or crashes is logged and restarted, indefinitely, after
 * `restartDelayMs` doubling per consecutive exit of that worker up to
 * `restartMaxDelayMs` (reset once it stayed up `restartStableMs`): a fault in
 * the safety net is no freeze, and ending every running turn for one would be
 * worse than a retried thread. But when no worker at all has been ready for
 * `maxDownMs` (they cannot start, or keep dying at once),
 * `onUnrecoverable(downMs)` is called once: the daemon must then stop,
 * gracefully, so the launcher replaces it with a process that can watch
 * itself. Default: the freeze limit itself, so an unwatched stretch never
 * outlasts the bound it stands in for.
 */
export function createFreezeWatchdog({
  limitMs,
  tickMs,
  pulseMs,
  suspendGapMs,
  logPath,
  dataDir = null,
  startedAtMs = performance.timeOrigin,
  livenessPid = process.pid,
  getWork = () => ({}),
  onStall = null,
  onLivenessPort = () => {},
  onUnrecoverable = () => {},
  log = () => {},
  workerUrl = new URL('./daemon-freeze-watchdog-worker.mjs', import.meta.url),
  workers = WATCHDOG_WORKERS,
  restartDelayMs = 1000,
  restartMaxDelayMs = 15_000,
  restartStableMs = 60_000,
  maxDownMs = limitMs,
  readyTimeoutMs = 5000,
  diagnosticsDeadlineMs = 2000,
}) {
  const buffer = new SharedArrayBuffer(BUFFER_BYTES);
  const { beats, work } = freezeSharedViews(buffer);
  // Per worker: its thread, its listener port and when it reported ready
  // (null: not ready), its consecutive exits and pending restart.
  const slots = Array.from({ length: workers }, (_, slot) => ({
    slot,
    thread: null,
    port: null,
    readyAt: null,
    exits: 0,
    restartTimer: null,
  }));
  let stopped = false;
  let pulseTimer = null;
  let downTimer = null;
  let lastPulseAt = performance.now();
  let unrecoverable = false;
  // Until start() settles: its resolver and timeout. Then: the port reported.
  let resolveStart = null;
  let startTimer = null;
  let reported = null;

  function pulse() {
    const t = performance.now();
    if (onStall && t - lastPulseAt > STALL_LOG_MS) {
      try {
        onStall(lastPulseAt, t);
      } catch {
        /* attribution must not disturb the pulse */
      }
    }
    lastPulseAt = t;
    let counts = {};
    try {
      counts = getWork() || {};
    } catch {}
    WORK_KEYS.forEach((key, index) => Atomics.store(work, index, count(counts[key])));
    Atomics.store(beats, 1, process.hrtime.bigint());
    Atomics.add(beats, 0, 1n);
  }

  const readySlots = () => slots.filter((s) => s.thread && s.readyAt !== null);

  // No worker ready: armed (once per daemon it may fire); one ready: cleared.
  function updateDownTimer() {
    if (readySlots().length) {
      if (downTimer) clearTimeout(downTimer);
      downTimer = null;
      return;
    }
    if (downTimer || unrecoverable || stopped) return;
    const downSince = performance.now();
    downTimer = setTimeout(() => {
      downTimer = null;
      if (stopped || readySlots().length) return;
      unrecoverable = true;
      const downMs = Math.round(performance.now() - downSince);
      log(`freeze watchdog not running for ${downMs}ms — this daemon cannot bound a freeze`);
      onUnrecoverable(downMs);
    }, maxDownMs);
    downTimer.unref?.();
  }

  function finishStart(port) {
    const resolve = resolveStart;
    resolveStart = null;
    clearTimeout(startTimer);
    reported = port;
    // Only the awaited start kept the process alive.
    for (const s of slots) s.thread?.unref();
    resolve(port);
  }

  // The port to name: the lowest-numbered ready worker's, else null.
  function report() {
    const ready = readySlots();
    const port = ready.find((s) => s.port)?.port ?? null;
    if (resolveStart) {
      if (port !== null || ready.length === slots.length) finishStart(port);
      return;
    }
    if (port === reported) return;
    reported = port;
    try {
      onLivenessPort(port);
    } catch {}
  }

  function restartAfter(s, code) {
    if (s.readyAt !== null && performance.now() - s.readyAt >= restartStableMs) s.exits = 0;
    s.thread = null;
    s.port = null;
    s.readyAt = null;
    s.exits += 1;
    const delayMs = Math.min(restartMaxDelayMs, restartDelayMs * 2 ** Math.min(s.exits - 1, 20));
    log(`freeze watchdog worker ${s.slot} exited (code ${code}) — restarting in ${delayMs}ms`);
    updateDownTimer();
    report();
    s.restartTimer = setTimeout(() => {
      s.restartTimer = null;
      if (!stopped) spawn(s);
    }, delayMs);
    s.restartTimer.unref?.();
  }

  function spawn(s) {
    let thread;
    try {
      thread = new Worker(workerUrl, {
        name: `mixdog-freeze-watchdog-${s.slot}`,
        // The daemon's heap cap and similar process flags are refused here.
        execArgv: workerExecArgv(),
        workerData: {
          buffer,
          slot: s.slot,
          limitMs,
          tickMs,
          suspendGapMs,
          logPath,
          dataDir,
          startedAtMs,
          livenessPid,
          diagnosticsDeadlineMs,
        },
      });
    } catch (error) {
      log(`freeze watchdog worker ${s.slot} failed to start: ${error?.message || error}`);
      restartAfter(s, 'spawn-failed');
      return;
    }
    s.thread = thread;
    if (!resolveStart) thread.unref();
    thread.on('message', (message) => {
      if (message?.type !== 'ready' || s.thread !== thread || stopped) return;
      const port = Number(message.livenessPort);
      s.port = Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
      s.readyAt = performance.now();
      updateDownTimer();
      report();
    });
    thread.on('error', (error) =>
      log(`freeze watchdog worker ${s.slot} error: ${error?.stack || error?.message || error}`)
    );
    thread.on('exit', (code) => {
      if (s.thread === thread && !stopped) restartAfter(s, code);
    });
  }

  return {
    start() {
      if (pulseTimer || stopped) return Promise.resolve(null);
      pulse();
      pulseTimer = setInterval(pulse, pulseMs);
      pulseTimer.unref?.();
      const started = new Promise((resolve) => {
        resolveStart = resolve;
      });
      startTimer = setTimeout(() => finishStart(readySlots().find((s) => s.port)?.port ?? null), readyTimeoutMs);
      updateDownTimer();
      for (const s of slots) spawn(s);
      return started;
    },
    stop() {
      stopped = true;
      const timers = [pulseTimer, downTimer, startTimer, ...slots.map((s) => s.restartTimer)];
      for (const timer of timers) if (timer) clearTimeout(timer);
      pulseTimer = null;
      downTimer = null;
      if (resolveStart) finishStart(null);
      const threads = slots.map((s) => s.thread).filter(Boolean);
      for (const s of slots) s.thread = null;
      return Promise.all(threads.map((thread) => thread.terminate())).then(() => {});
    },
    /** At least one worker is up and has reported ready. */
    get running() {
      return readySlots().length > 0;
    },
  };
}
