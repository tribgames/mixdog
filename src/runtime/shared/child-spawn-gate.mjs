'use strict';

// ── Module-global child-spawn semaphore ──────────────────────────────────
//
// Single-daemon premise: tool execution is in-process, so a module-level
// singleton semaphore CAN bound the number of concurrent child processes (rg,
// mixdog-graph, …) across ALL agents/workers in this daemon.
//
// Default: 1 on win32, unbounded elsewhere. Measured on Windows (explore-bench
// 13-way fan-out, 2026-08-05): concurrent rg spawns thrash the AV child-scan
// path — wall 31-61s unbounded vs 20-23s at cap 1, monotonic 1<2<6≈∞, tool
// p50 14.6s→11.0s, quality unchanged. Spawns are short (rg/graph only; shell
// is deliberately NOT gated), so serializing them overlaps LLM waits instead
// of starving anything. MIXDOG_CHILD_SPAWN_MAX_INFLIGHT still overrides.
//
// IMPORTANT: this is a resource-control knob and is deliberately NOT exposed
// on any tool JSON schema / tool parameter surface. The only tuning surface
// is the MIXDOG_CHILD_SPAWN_MAX_INFLIGHT env override.

function _defaultMaxInflight() {
  const override = Number(process.env.MIXDOG_CHILD_SPAWN_MAX_INFLIGHT);
  if (Number.isFinite(override) && override >= 1) return Math.floor(override);
  return process.platform === 'win32' ? 1 : Infinity;
}

const MAX_INFLIGHT = _defaultMaxInflight();

// ── Lanes ────────────────────────────────────────────────────────────────
// One shared cap number, applied PER LANE with independent counters/queues:
//   'default' — short-lived spawns (rg). Holding time is one search run.
//   'build'   — long-lived builds (code-graph worker / graph binary). A cold
//               graph build can hold its slot for seconds-to-minutes; on the
//               win32 cap=1 default a single shared lane would let one build
//               stall every rg spawn behind it. Separate lanes remove that
//               starvation class while keeping each spawn family bounded.
function _makeLane() {
  return { inflight: 0, queue: [] };
}
const _lanes = new Map();
function _lane(name) {
  let lane = _lanes.get(name);
  if (!lane) { lane = _makeLane(); _lanes.set(name, lane); }
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
      `[child-spawn-gate] lane=${laneName} queue wait ${waitedMs}ms (inflight cap=${MAX_INFLIGHT}, queued=${lane.queue.length}); `
      + 'raise MIXDOG_CHILD_SPAWN_MAX_INFLIGHT if this persists\n',
    );
  } catch { /* ignore */ }
}

function _drain(laneName, lane) {
  while (lane.inflight < MAX_INFLIGHT && lane.queue.length > 0) {
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
 * @param {string} [laneName] — 'default' (short spawns) or 'build'.
 * @returns {Promise<() => void>}
 */
export function acquire(signal = null, laneName = 'default') {
  if (signal && signal.aborted) {
    return Promise.reject(signal.reason ?? _abortError());
  }
  const lane = _lane(laneName);
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      lane.inflight = Math.max(0, lane.inflight - 1);
      _drain(laneName, lane);
    };
    if (lane.inflight < MAX_INFLIGHT && lane.queue.length === 0) {
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
export function hasSpareCapacity(laneName = 'default') {
  const lane = _lane(laneName);
  return lane.inflight < MAX_INFLIGHT && lane.queue.length === 0;
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
async function withGate(fn, signal = null, laneName = 'default') {
  const release = await acquire(signal, laneName);
  try {
    return await fn({ signal: signal || null });
  } finally {
    release();
  }
}
