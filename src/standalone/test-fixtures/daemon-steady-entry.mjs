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
// and unref'd; the probe itself arms no timer of its own.
import fs from 'node:fs';
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
      const key = `${name} ${callSite()}`;
      syncFs.set(key, (syncFs.get(key) ?? 0) + 1);
    }
    return realFs[name].apply(this, args);
  };
}

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

module.syncBuiltinESMExports();

function openWindow() {
  syncFs = new Map();
  timerSites = new Map();
  promiseTimers = new Map();
  histogram.reset();
  eluStart = performance.eventLoopUtilization();
  cpuStart = process.cpuUsage();
  windowStartedAt = performance.now();
  windowId += 1;
  windowOpen = true;
}

function closeWindow() {
  windowOpen = false;
  const elapsedMs = performance.now() - windowStartedAt;
  const elu = performance.eventLoopUtilization(eluStart);
  const cpu = process.cpuUsage(cpuStart);
  const ms = (nanoseconds) => Math.round((nanoseconds / 1e6) * 100) / 100;
  const timers = [...timerSites].map(([site, stat]) => ({ site, ...stat, busyMs: Math.round(stat.busyMs * 100) / 100 }));
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
      if (command === 'start') {
        openWindow();
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
