// Preloaded into a case's daemon (world.mjs passes it as the daemon's `execArgv`): the turn metadata a compaction's handoff hashes
// (compact/messages.mjs `compactHeader`: each message's `at`, `elapsedMs` and `attemptId`, tui/session/turn.mjs) comes from the clock
// and the uuids, so both are scripted. The uuids count within a daemon start; the start's number is kept in the run's home (MIXDOG_HOME
// is <case>/home/.mixdog, made anew for each run).
//
// The clock is virtual time along each causal chain: it stands at an instant of its own for each daemon start, and a timer's callback
// (and all that follows from it) runs at the instant it was set for, its setter's instant plus its delay. A wait measured by the clock
// (the final report's quiet period, agent-task-sessions.mjs `followTaskToFinal`) then ends after its timer, while what a chain reads
// never depends on how many other timers fired meanwhile.
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import module from 'node:module';
import { join } from 'node:path';
import timers from 'node:timers';

// The daemon's own children inherit its flags: the memory daemon (MIXDOG_MEMORY_DAEMON=1, memory-runtime-proxy/daemon-spawn.mjs) keeps
// the real clock, so its idle stop (MIXDOG_MEMORY_IDLE_TTL_MS) comes and the case ends with nothing of it running.
if (process.env.MIXDOG_MEMORY_DAEMON !== '1') scriptTheWorld();

function scriptTheWorld() {
const startsFile = join(process.env.MIXDOG_HOME, '..', 'daemon-starts.txt');
const start = (existsSync(startsFile) ? Number(readFileSync(startsFile, 'utf8')) : 0) + 1;
writeFileSync(startsFile, String(start));
// Concurrent sites (a turn's attempt id, a send's id, a background writer's) draw in an order that varies from run to run; each site's
// own sequence does not (lib/determinism.mjs, one stream per call site): a uuid is numbered within the code location that asked for it.
const drawn = new Map();
const uuid = () => {
  const site = (new Error().stack ?? '').split('\n')[2]?.trim() ?? '';
  drawn.set(site, (drawn.get(site) ?? 0) + 1);
  const h = crypto.createHash('sha256').update(`${start} ${site} ${drawn.get(site)}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
crypto.randomUUID = uuid;
Object.defineProperty(globalThis.crypto, 'randomUUID', { value: uuid, configurable: true });
// Ten minutes per start: a restart is not an absence (an hour would make every queued row the restart restores a stale one,
// tui-steering-persist.mjs STALE_STEERING_RESTORE_TTL_MS).
const base = 1_800_000_000_000 + start * 600_000;
const instant = new AsyncLocalStorage();
const now = () => instant.getStore() ?? base;
Date.now = now;
// A short timer moves nothing: whether a chain goes on from one (a stream's flush, a debounce) or from the event it waits for races
// from run to run, so only a wait of a second or more (the report's 2.5 s quiet period) is time on the clock.
const delayOf = (ms) => ((Number(ms) || 0) >= 1000 ? Number(ms) : 0);
const realTimeout = globalThis.setTimeout;
const realInterval = globalThis.setInterval;
const setTimeoutAt = (fn, ms, ...args) => {
  if (typeof fn !== 'function') return realTimeout(fn, ms, ...args);
  const at = now() + delayOf(ms);
  return realTimeout((...given) => instant.run(at, fn, ...given), ms, ...args);
};
const setIntervalAt = (fn, ms, ...args) => {
  if (typeof fn !== 'function') return realInterval(fn, ms, ...args);
  const from = now();
  let ticks = 0;
  return realInterval((...given) => instant.run(from + (ticks += 1) * delayOf(ms), fn, ...given), ms, ...args);
};
globalThis.setTimeout = setTimeoutAt;
globalThis.setInterval = setIntervalAt;
timers.setTimeout = setTimeoutAt;
timers.setInterval = setIntervalAt;
module.syncBuiltinESMExports();
}
