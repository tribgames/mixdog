'use strict';

// ── Module-global child-spawn semaphore ──────────────────────────────────
//
// Single-daemon premise: tool execution is in-process, so a module-level
// singleton semaphore CAN bound the number of concurrent child processes (rg,
// mixdog-graph, …) across ALL agents/workers in this daemon.
//
// Default: unbounded on every platform. A machine whose AV/process policy
// benefits from serialization may opt into a finite limit with
// MIXDOG_CHILD_SPAWN_MAX_INFLIGHT, but the product does not silently turn
// independent session tools into one global FIFO.
//
// IMPORTANT: these are resource-control knobs and are deliberately NOT exposed
// on any tool JSON schema / tool parameter surface. Operators may set the
// shared MIXDOG_CHILD_SPAWN_MAX_INFLIGHT fallback or a lane-specific override.

function _defaultMaxInflight() {
  const override = Number(process.env.MIXDOG_CHILD_SPAWN_MAX_INFLIGHT);
  if (Number.isFinite(override) && override >= 1) return Math.floor(override);
  return Infinity;
}

const DEFAULT_MAX_INFLIGHT = _defaultMaxInflight();
const LANE_ALIASES = new Map([
  ['default', 'search'],
  ['build', 'code-graph'],
]);

function _laneName(name) {
  const clean = String(name || 'search').trim().toLowerCase() || 'search';
  return LANE_ALIASES.get(clean) || clean;
}

function _laneLimit(name) {
  const key = _laneName(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const override = Number(process.env[`MIXDOG_CHILD_SPAWN_${key}_MAX_INFLIGHT`]);
  return Number.isFinite(override) && override >= 1
    ? Math.floor(override)
    : DEFAULT_MAX_INFLIGHT;
}

// ── Lanes ────────────────────────────────────────────────────────────────
// Independent optional limits and queues:
//   'search'     — short-lived rg processes.
//   'code-graph' — long-lived graph workers / native graph binaries. A cold
//               graph build can hold its slot for seconds-to-minutes; a
//               single shared lane would let one build
//               stall every rg spawn behind it. Separate lanes remove that
//               starvation class while keeping each spawn family bounded.
function _makeLane(name) {
  return { inflight: 0, queue: [], limit: _laneLimit(name) };
}
const _lanes = new Map();
function _lane(name) {
  const normalized = _laneName(name);
  let lane = _lanes.get(normalized);
  if (!lane) { lane = _makeLane(normalized); _lanes.set(normalized, lane); }
  return lane;
}

// Warn (once-throttled, stderr only) when a waiter sat in the queue longer
// than this — a coarse signal that the cap is undersized for the load. Kept
// intentionally quiet so a busy daemon does not spam stderr.
const SLOW_WAIT_MS = Math.max(
  1000,
  Number(process.env.MIXDOG_CHILD_SPAWN_SLOW_MS) || 10000,
);
const SLOW_WARN_THROTTLE_MS = 30000;

let _lastSlowWarnAt = 0;

function _maybeWarnSlow(waitedMs, laneName, lane) {
  if (waitedMs < SLOW_WAIT_MS) return;
  const now = Date.now();
  if (now - _lastSlowWarnAt < SLOW_WARN_THROTTLE_MS) return;
  _lastSlowWarnAt = now;
  try {
    process.stderr.write(
      `[child-spawn-gate] lane=${laneName} queue wait ${waitedMs}ms (inflight cap=${lane.limit}, queued=${lane.queue.length}); `
      + 'raise the lane-specific MIXDOG_CHILD_SPAWN_*_MAX_INFLIGHT if this persists\n',
    );
  } catch { /* ignore */ }
}

function _drain(laneName, lane) {
  while (lane.inflight < lane.limit && lane.queue.length > 0) {
    const waiter = lane.queue.shift();
    if (waiter.onAbort && waiter.signal) {
      try { waiter.signal.removeEventListener('abort', waiter.onAbort); } catch { /* ignore */ }
    }
    lane.inflight++;
    _maybeWarnSlow(Date.now() - waiter.enqueuedAt, laneName, lane);
    waiter.resolve();
  }
}

/**
 * Acquire one child-spawn slot. Resolves immediately when below the cap,
 * otherwise queues until a slot frees. The returned function releases the
 * slot and is idempotent (safe to call from multiple settle paths — only the
 * first call counts). Supports an optional AbortSignal: aborting while still
 * queued rejects with the signal reason and removes the waiter (no leak); a
 * post-acquire abort is a no-op here — the caller owns teardown and must still
 * call release().
 *
 * @param {AbortSignal | null} [signal]
 * @param {string} [laneName] — 'search' (rg) or 'code-graph'.
 * @returns {Promise<() => void>}
 */
export function acquire(signal = null, laneName = 'search') {
  if (signal && signal.aborted) {
    return Promise.reject(signal.reason ?? _abortError());
  }
  const normalizedLaneName = _laneName(laneName);
  const lane = _lane(normalizedLaneName);
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      lane.inflight = Math.max(0, lane.inflight - 1);
      _drain(normalizedLaneName, lane);
    };
    if (lane.inflight < lane.limit && lane.queue.length === 0) {
      lane.inflight++;
      resolve(release);
      return;
    }
    const waiter = {
      enqueuedAt: Date.now(),
      signal: signal || null,
      onAbort: null,
      resolve: () => resolve(release),
      reject,
    };
    if (signal) {
      waiter.onAbort = () => {
        const idx = lane.queue.indexOf(waiter);
        if (idx !== -1) lane.queue.splice(idx, 1);
        try { signal.removeEventListener('abort', waiter.onAbort); } catch { /* ignore */ }
        reject(signal.reason ?? _abortError());
      };
      try { signal.addEventListener('abort', waiter.onAbort, { once: true }); } catch { /* ignore */ }
    }
    lane.queue.push(waiter);
  });
}

function _abortError() {
  const e = new Error('child-spawn-gate: aborted while queued');
  e.code = 'ABORT_ERR';
  return e;
}

/**
 * Best-effort capacity probe for NON-COMPETING prewarm/warmup work. Returns
 * true only when a slot could be taken right now without queuing — i.e. below
 * the cap AND with no waiter already queued. Speculative warmers (explore's
 * code_graph / find prewarm) consult this to skip/defer when the daemon is
 * busy, so a fire-and-forget warm never pushes a real tool query into the
 * queue (the "non-competing under fanout" guarantee). This is a probe, NOT a
 * reservation: the answer can go stale under a race, which is acceptable for
 * best-effort work. Real queries must use acquire()/withGate() and never gate
 * themselves on this.
 */
export function hasSpareCapacity(laneName = 'search') {
  const lane = _lane(laneName);
  return lane.inflight < lane.limit && lane.queue.length === 0;
}

export function snapshot() {
  return {
    maxInflight: Number.isFinite(DEFAULT_MAX_INFLIGHT) ? DEFAULT_MAX_INFLIGHT : null,
    lanes: [..._lanes.entries()].map(([name, lane]) => ({
      name,
      inflight: lane.inflight,
      queued: lane.queue.length,
      limit: Number.isFinite(lane.limit) ? lane.limit : null,
    })),
  };
}

/**
 * Run `fn` while holding one child-spawn slot. Release is guaranteed in a
 * finally so a throw/return from `fn` cannot leak a slot or deadlock the gate.
 *
 * @template T
 * @param {(args: { signal: AbortSignal | null }) => Promise<T> | T} fn
 * @param {AbortSignal | null} [signal]
 * @param {string} [laneName]
 * @returns {Promise<T>}
 */
async function withGate(fn, signal = null, laneName = 'search') {
  const release = await acquire(signal, laneName);
  try {
    return await fn({ signal: signal || null });
  } finally {
    release();
  }
}
