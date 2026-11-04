// Entry for a daemon under observation: observes the main thread, then loads
// the daemon named by MIXDOG_PROBE_DAEMON_URL (any tree, so the same probe
// measures an older release). Used by daemon-steady-state.slow.test.mjs and
// scripts/daemon-load-bench.mjs. Node built-ins only.
//
// While a window is open the probe records, for the main thread only:
//   - every synchronous node:fs call (method + calling site), and
//   - every timer callback that runs (site, kind, the most fires of one
//     self-re-arming chain, time spent inside), plus the event-loop delay and
//     utilization of the window.
// A window is driven over a loopback socket (path in MIXDOG_PROBE_PORT_FILE),
// because a supervised daemon has no IPC channel. The socket is event-driven
// and unref'd; the probe arms no timer of its own, except the gap ticker of a
// window opened with `start ticker` (the busy-sessions bench).
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import module from 'node:module';
import net from 'node:net';
import nodeTimers from 'node:timers';
import timersPromises from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const SELF = fileURLToPath(import.meta.url);
const realFs = { ...fs };
let windowOpen = false;
let windowStartedAt = 0;
let windowId = 0;
let eluStart = null;
let cpuStart = null;
let syncFs = new Map();
let timerSites = new Map();
let promiseTimers = new Map();
// The timer callback running right now (callbacks do not nest).
let running = null;
const histogram = monitorEventLoopDelay({ resolution: 10 });

// What the window did to session storage, by call (sync or promise-based):
// reads/stats of `sessions/*.json` and every touch of the summary index files.
// `kind` is the fs method; the count is per method, so a rewrite shows as
// `rename` (or writeFile) on the index and a refresh as `readFile`/`open` on records.
let storageTouches = new Map();
function noteStorageTouch(method, args) {
  const target = typeof args[0] === 'string' ? args[0] : '';
  let area = '';
  if (target.includes('session-summaries.json')) area = target.endsWith('.lock') ? 'summary-lock' : 'summary-index';
  else if (target.includes('mixdog-workspace-admission')) area = 'admission-ledger';
  else if (/[\\/]sessions[\\/][^\\/]+\.json$/.test(target)) area = 'session-record';
  else if (target.endsWith('.compaction-archive.jsonl')) area = 'archive';
  if (!area) return;
  const key = `${area} ${method.replace(/Sync$/, '')}`;
  storageTouches.set(key, (storageTouches.get(key) ?? 0) + 1);
}

/** The first stack frame outside this file and Node internals: `path:line`. */
function callSite() {
  const holder = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 12;
  Error.captureStackTrace(holder, callSite);
  Error.stackTraceLimit = limit;
  for (const line of String(holder.stack).split('\n').slice(1)) {
    const match = /^at (?:.*? \()?(.*?):(\d+):\d+\)?$/.exec(line.trim());
    if (!match || match[1].startsWith('node:')) continue;
    const file = match[1].startsWith('file://') ? fileURLToPath(match[1]) : match[1];
    if (file !== SELF) return `${file}:${match[2]}`;
  }
  return 'node:internal';
}

for (const name of Object.keys(realFs)) {
  if (!name.endsWith('Sync') || typeof realFs[name] !== 'function') continue;
  fs[name] = function observedSync(...args) {
    if (windowOpen) {
      noteStorageTouch(name, args);
      const key = `${name} ${callSite()}`;
      syncFs.set(key, (syncFs.get(key) ?? 0) + 1);
    }
    return realFs[name].apply(this, args);
  };
}

// Blocking waits on the main thread (Atomics.wait: lock sleeps, the commit
// lock, workspace admission). They are idle for the CPU but count as active
// event-loop time, so they are tallied per call site: count and time blocked.
const realAtomicsWait = Atomics.wait;
let atomicsWaits = new Map();
Atomics.wait = function observedAtomicsWait(...args) {
  if (!windowOpen) return realAtomicsWait.apply(this, args);
  const site = callSite();
  const startedAt = performance.now();
  try {
    return realAtomicsWait.apply(this, args);
  } finally {
    const stat = atomicsWaits.get(site) ?? { count: 0, blockedMs: 0 };
    stat.count += 1;
    stat.blockedMs += performance.now() - startedAt;
    atomicsWaits.set(site, stat);
  }
};

function observeTimer(kind, original) {
  const observed = function observedTimer(callback, delay, ...args) {
    if (typeof callback !== 'function') return original.call(this, callback, delay, ...args);
    const site = callSite();
    // A timer armed from its own callback's site continues that timer's chain,
    // whatever its delay: a loop, which `chainFires` counts per window.
    const chain = running?.site === site ? running.chain : { window: 0, fires: 0 };
    const entry = { site, chain };
    const wrapped = function timerCallback(...callbackArgs) {
      const previous = running;
      running = entry;
      const startedAt = performance.now();
      try {
        return callback.apply(this, callbackArgs);
      } finally {
        running = previous;
        if (windowOpen) {
          if (chain.window !== windowId) Object.assign(chain, { window: windowId, fires: 0 });
          chain.fires += 1;
          const stat = timerSites.get(site) ?? { kind, fires: 0, chainFires: 0, busyMs: 0, delay: Number(delay) || 0 };
          stat.fires += 1;
          stat.chainFires = Math.max(stat.chainFires, chain.fires);
          stat.busyMs += performance.now() - startedAt;
          timerSites.set(site, stat);
        }
      }
    };
    return original.call(this, wrapped, delay, ...args);
  };
  for (const symbol of Object.getOwnPropertySymbols(original)) observed[symbol] = original[symbol];
  return observed;
}

// The independent gap ticker below arms its own timers with the unobserved
// original, so it never shows up in the timer statistics.
const unobservedSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = observeTimer('timeout', globalThis.setTimeout);
globalThis.setInterval = observeTimer('interval', globalThis.setInterval);
nodeTimers.setTimeout = globalThis.setTimeout;
nodeTimers.setInterval = globalThis.setInterval;

// timers/promises resolves through the promise, so there is no callback to
// time: count completions per call site instead.
const realPromiseTimeout = timersPromises.setTimeout;
timersPromises.setTimeout = function observedPromiseTimeout(delay, ...rest) {
  const site = callSite();
  return realPromiseTimeout.call(this, delay, ...rest).then((value) => {
    if (windowOpen) promiseTimers.set(site, (promiseTimers.get(site) ?? 0) + 1);
    return value;
  });
};

for (const name of ['open', 'readFile', 'writeFile', 'appendFile', 'rename', 'link', 'unlink', 'stat', 'readdir']) {
  const real = fsPromises[name];
  fsPromises[name] = function observedAsync(...args) {
    if (windowOpen) noteStorageTouch(name, args);
    return real.apply(this, args);
  };
}

module.syncBuiltinESMExports();

// Gap ticker (opt-in per window: `start ticker`, so idle windows stay
// unchanged). A self-re-arming unref'd timer records the time between
// consecutive callbacks. This is the daemon's own "event loop stalled" notion
// (a gap over 1 s), measured independently of the delay histogram.
const TICK_MS = 50;
const GAP_THRESHOLDS_MS = [1000, 5000];
const TOP_GAPS = 10;
let ticker = null;

function recordGap(state, endedAt) {
  const gap = endedAt - state.last;
  state.last = endedAt;
  state.maxGapMs = Math.max(state.maxGapMs, gap);
  for (const threshold of GAP_THRESHOLDS_MS) {
    if (gap <= threshold) continue;
    state.over[threshold].count += 1;
    state.over[threshold].totalMs += gap;
  }
  if (gap > GAP_THRESHOLDS_MS[0]) {
    state.top.push({ atMs: Math.round(endedAt - gap - state.startedAt), gapMs: Math.round(gap) });
    state.top.sort((a, b) => b.gapMs - a.gapMs);
    state.top.length = Math.min(state.top.length, TOP_GAPS);
  }
}

function startTicker() {
  const now = performance.now();
  const state = { startedAt: now, last: now, maxGapMs: 0, timer: null, top: [], over: {} };
  for (const threshold of GAP_THRESHOLDS_MS) state.over[threshold] = { count: 0, totalMs: 0 };
  const tick = () => {
    recordGap(state, performance.now());
    state.timer = unobservedSetTimeout(tick, TICK_MS);
    state.timer.unref();
  };
  state.timer = unobservedSetTimeout(tick, TICK_MS);
  state.timer.unref();
  return state;
}

function stopTicker(state) {
  clearTimeout(state.timer);
  recordGap(state, performance.now());
  const round = ({ count, totalMs }) => ({ count, totalMs: Math.round(totalMs) });
  return {
    tickMs: TICK_MS,
    maxGapMs: Math.round(state.maxGapMs),
    over1s: round(state.over[1000]),
    over5s: round(state.over[5000]),
    topGaps: state.top,
  };
}

function openWindow(withTicker = false) {
  ticker = withTicker ? startTicker() : null;
  syncFs = new Map();
  atomicsWaits = new Map();
  storageTouches = new Map();
  timerSites = new Map();
  promiseTimers = new Map();
  histogram.reset();
  eluStart = performance.eventLoopUtilization();
  cpuStart = process.cpuUsage();
  windowStartedAt = performance.now();
  windowId += 1;
  windowOpen = true;
}

// `utilization` is performance.eventLoopUtilization over the window: the share
// of wall time the loop thread was not parked in the OS poll. That includes
// native work in the poll phase (fs.watch / directory-change dispatch, worker
// message decoding) which V8's CPU profiler files under `(idle)`, because it
// marks the whole prepare->check span idle. A `--cpu-prof` of busy JS is
// therefore a lower bound; the main thread's own CPU time (per-thread, from the
// OS) tracks this figure (measured: 2.3 s of thread CPU in 5 s = ELU 50 %, and
// both fell together to 0.5 s / 16 % when the watchers were stubbed).
function closeWindow() {
  windowOpen = false;
  const elapsedMs = performance.now() - windowStartedAt;
  const elu = performance.eventLoopUtilization(eluStart);
  const cpu = process.cpuUsage(cpuStart);
  const ms = (nanoseconds) => Math.round((nanoseconds / 1e6) * 100) / 100;
  const timers = [...timerSites].map(([site, stat]) => ({
    site,
    ...stat,
    busyMs: Math.round(stat.busyMs * 100) / 100,
  }));
  return {
    elapsedMs: Math.round(elapsedMs),
    activeMs: Math.round(elu.active),
    utilization: elu.utilization,
    // Whole-process CPU (all threads) over the window, in percent of one core.
    cpuPercent: Math.round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 1000) / 10,
    delayMs: { p50: ms(histogram.percentile(50)), p99: ms(histogram.percentile(99)), max: ms(histogram.max) },
    syncFs: [...syncFs].map(([key, count]) => {
      const [method, site] = key.split(' ');
      return { method, site, count };
    }),
    timers,
    timerBusyMs: Math.round(timers.reduce((sum, stat) => sum + stat.busyMs, 0) * 100) / 100,
    promiseTimers: [...promiseTimers].map(([site, count]) => ({ site, count })),
    storageTouches: Object.fromEntries([...storageTouches].sort()),
    atomicsWaits: [...atomicsWaits].map(([site, stat]) => ({
      site,
      count: stat.count,
      blockedMs: Math.round(stat.blockedMs),
    })),
    ...(ticker ? { gapTicker: stopTicker(ticker) } : {}),
  };
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  let pending = '';
  socket.on('data', (chunk) => {
    pending += chunk;
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const command = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      if (command === 'start' || command === 'start ticker') {
        openWindow(command === 'start ticker');
        socket.write('{}\n');
      } else if (command === 'stop') {
        socket.write(`${JSON.stringify(closeWindow())}\n`);
      }
    }
  });
});
server.unref();
histogram.enable();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
realFs.writeFileSync(process.env.MIXDOG_PROBE_PORT_FILE, String(server.address().port));

// A mutation under test: a module that re-adds the kind of work this probe
// exists to catch, loaded into the same process before the daemon.
if (process.env.MIXDOG_STEADY_STATE_MUTATION) await import(process.env.MIXDOG_STEADY_STATE_MUTATION);
await import(process.env.MIXDOG_PROBE_DAEMON_URL);
