/**
 * Daemon-wide scheduler for the sessions' runtime-derived status (route,
 * context gauge, agent status, workspace/HEAD target, delegated approvals).
 *
 * Each session registers one pass. Change events mark it dirty; the scheduler
 * coalesces marks and runs every ready pass once, in one task. A pass
 * publishes only what changed. Nothing runs without a mark: there is no poll.
 */
import { performance } from 'node:perf_hooks';
import { subscribeConfigInputEpoch } from '../runtime/shared/config-epoch.mjs';

// The first mark waits one short beat so a burst of mutations (one turn event
// sets several fields) runs one pass.
export const STATUS_SETTLE_MS = 16;
// A session runs at most this often while marks keep arriving (a streaming
// turn), so a change reaches subscribers within this + one settle beat + one
// store frame — under 250 ms.
export const STATUS_MIN_INTERVAL_MS = 200;

export function createSessionStatusScheduler({
  settleMs = STATUS_SETTLE_MS,
  minIntervalMs = STATUS_MIN_INTERVAL_MS,
  now = () => performance.now(),
  timers = { setTimeout, clearTimeout },
  // (markAll) → unsubscribe: daemon-wide change events, held while any session is registered.
  subscribeGlobalChanges = null,
} = {}) {
  const entries = new Set();
  // Insertion-ordered: the longest-waiting session runs first.
  const dirty = new Set();
  let timer = null;
  let timerAt = Infinity;
  let running = false;
  let unsubscribeGlobal = null;
  const counters = { recomputes: 0, runs: 0 };

  function arm(at) {
    if (running || entries.size === 0) return;
    if (timer && timerAt <= at) return;
    if (timer) timers.clearTimeout(timer);
    timerAt = at;
    timer = timers.setTimeout(run, Math.max(0, at - now()));
    timer.unref?.();
  }

  function rearm() {
    let next = Infinity;
    for (const entry of dirty) next = Math.min(next, entry.readyAt);
    if (next !== Infinity) arm(next);
  }

  function remove(entry) {
    if (!entries.delete(entry)) return;
    dirty.delete(entry);
    entry.dirty = false;
    if (entries.size === 0) {
      if (timer) timers.clearTimeout(timer);
      timer = null;
      timerAt = Infinity;
      unsubscribeGlobal?.();
      unsubscribeGlobal = null;
    }
  }

  function mark(entry, readyAt) {
    if (!entries.has(entry)) return;
    if (entry.dirty) {
      if (readyAt >= entry.readyAt) return;
      entry.readyAt = readyAt;
    } else {
      entry.dirty = true;
      entry.readyAt = readyAt;
      dirty.add(entry);
    }
    arm(readyAt);
  }

  const markReady = (entry) => mark(entry, Math.max(now() + settleMs, entry.lastRunAt + minIntervalMs));

  function runEntry(entry) {
    counters.recomputes += 1;
    try {
      entry.recompute();
    } catch {
      // One session's failing read must not starve the others; its next
      // change event runs it again.
    }
    entry.lastRunAt = now();
  }

  // Every ready pass, in one task; a pass marked while this runs waits for
  // its own due time.
  function run() {
    timer = null;
    timerAt = Infinity;
    running = true;
    counters.runs += 1;
    const at = now();
    for (const entry of [...dirty]) {
      if (entry.readyAt > at || !entry.dirty) continue;
      dirty.delete(entry);
      entry.dirty = false;
      if (entry.isDisposed()) {
        remove(entry);
        continue;
      }
      runEntry(entry);
    }
    running = false;
    rearm();
  }

  function markAll() {
    for (const entry of entries) markReady(entry);
  }

  /** `recompute()`: the session's status pass. `isDisposed()`: drops it when
   *  true. Starts dirty: the first pass runs right away. */
  function register({ recompute, isDisposed = () => false }) {
    const entry = { recompute, isDisposed, dirty: false, readyAt: 0, lastRunAt: -Infinity };
    entries.add(entry);
    if (entries.size === 1 && typeof subscribeGlobalChanges === 'function') {
      unsubscribeGlobal = subscribeGlobalChanges(markAll) || null;
    }
    mark(entry, now() + settleMs);
    return {
      markDirty: () => markReady(entry),
      dispose: () => remove(entry),
    };
  }

  return {
    register,
    markAll,
    size: () => entries.size,
    counters: () => ({ ...counters }),
  };
}

/** The daemon-wide input every session's pass reads: the config-input epoch,
 *  which advances on every config, credential, account, binding or keychain
 *  change, in this process or another, and on expiry. The only place this
 *  source is named, so a different notification swaps in here. */
function subscribeDaemonChanges(markAll) {
  return subscribeConfigInputEpoch(() => markAll());
}

let daemonScheduler = null;

/** The process's scheduler: every session runtime of the daemon shares it. */
export function sessionStatusScheduler() {
  daemonScheduler ??= createSessionStatusScheduler({ subscribeGlobalChanges: subscribeDaemonChanges });
  return daemonScheduler;
}
