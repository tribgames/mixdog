'use strict';

import { availableParallelism } from 'node:os';
import { createOwnerFairGate } from './owner-fair-gate.mjs';
import { currentToolExecutionOwner } from './tool-execution-owner.mjs';
import { acquireRemoteSpawnLease, remoteSpawnLeasesEnabled } from './child-spawn-remote.mjs';

// ── Module-global child-spawn semaphore ──────────────────────────────────
//
// Single-daemon premise: tool execution is in-process, so a module-level
// singleton semaphore CAN bound the number of concurrent child processes (rg,
// mixdog-graph, …) across ALL agents/workers in this daemon.
//
// Default: Windows search scales conservatively from 1..4 with CPU count;
// code-graph remains 1. Other platforms are unbounded. Windows measurements
// showed both extremes are poor: cap 1 creates multi-session queue latency,
// while unbounded multithreaded rg amplifies Defender/process-scan and disk
// contention. Separate lanes isolate short search from long graph builds.
// MIXDOG_CHILD_SPAWN_MAX_INFLIGHT overrides globally.
//
// IMPORTANT: these are resource-control knobs and are deliberately NOT exposed
// on any tool JSON schema / tool parameter surface. Operators may set the
// shared MIXDOG_CHILD_SPAWN_MAX_INFLIGHT fallback or a lane-specific override.

export function resolveDefaultChildSpawnMaxInflight(env = process.env, platform = process.platform) {
  const override = Number(env.MIXDOG_CHILD_SPAWN_MAX_INFLIGHT);
  if (Number.isFinite(override) && override >= 1) return Math.floor(override);
  return platform === 'win32' ? 1 : Infinity;
}

export function resolveDefaultChildSpawnLaneMaxInflight(
  laneName,
  env = process.env,
  platform = process.platform,
  parallelism = availableParallelism(),
) {
  const lane = _laneName(laneName);
  const key = lane.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const laneOverride = Number(env[`MIXDOG_CHILD_SPAWN_${key}_MAX_INFLIGHT`]);
  if (Number.isFinite(laneOverride) && laneOverride >= 1) return Math.floor(laneOverride);
  const sharedOverride = Number(env.MIXDOG_CHILD_SPAWN_MAX_INFLIGHT);
  if (Number.isFinite(sharedOverride) && sharedOverride >= 1) return Math.floor(sharedOverride);
  const cpus = Math.max(1, Math.floor(Number(parallelism) || 1));
  if (platform !== 'win32') {
    // No AV amplification, but disk/CPU saturation is platform-neutral: an
    // unbounded multi-agent burst still convoys. Bound search generously.
    return lane === 'search' ? Math.max(4, Math.min(12, Math.ceil(cpus / 2))) : Infinity;
  }
  // Shell/child process creation window (CreateProcess + Defender scan).
  // Slots are held only across the spawn itself, so a small cap smooths the
  // AV convoy without limiting how many commands run concurrently.
  if (lane === 'process-spawn') return Math.max(2, Math.min(4, Math.floor(cpus / 6) || 2));
  // One cold graph build saturates memory/disk; allow a second only on big hosts.
  if (lane === 'code-graph') return cpus >= 12 ? 2 : 1;
  if (lane !== 'search') return 1;
  // Multiple rg processes beat one under multi-session load, but each process
  // is itself threaded and Defender amplifies excess fan-out. Burst stress
  // measured cap-4 starvation (find p50 15s at 8 concurrent sessions), so
  // scale with cores and cap at eight: 4→2, 8→3, 12→4, 18→6, 24+→8.
  return Math.max(2, Math.min(8, Math.ceil(cpus / 3)));
}

const DEFAULT_MAX_INFLIGHT = resolveDefaultChildSpawnMaxInflight();
const LANE_ALIASES = new Map([
  ['default', 'search'],
  ['build', 'code-graph'],
]);

function _laneName(name) {
  const clean = String(name || 'search').trim().toLowerCase() || 'search';
  return LANE_ALIASES.get(clean) || clean;
}

function _laneLimit(name) {
  return resolveDefaultChildSpawnLaneMaxInflight(name);
}

function _laneSetting(name, suffix, fallback) {
  const key = _laneName(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const laneValue = Number(process.env[`MIXDOG_CHILD_SPAWN_${key}_${suffix}`]);
  if (Number.isFinite(laneValue) && laneValue >= 1) return Math.floor(laneValue);
  const sharedValue = Number(process.env[`MIXDOG_CHILD_SPAWN_${suffix}`]);
  return Number.isFinite(sharedValue) && sharedValue >= 1
    ? Math.floor(sharedValue)
    : fallback;
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
  const limit = _laneLimit(name);
  const queueMax = _laneSetting(name, 'MAX_QUEUE', 1024);
  const waitTimeoutMs = _laneSetting(name, 'WAIT_TIMEOUT_MS', 30_000);
  return {
    limit,
    queueMax,
    waitTimeoutMs,
    gate: createOwnerFairGate({
      name: `${name} child spawn`,
      activeMax: limit,
      queueMax,
      minOwnerQueue: Math.max(8, Math.floor(queueMax / 32)),
      waitTimeoutMs,
    }),
  };
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
let _lastFallbackWarnAt = 0;

function _warnLeaseFallback(error, laneName) {
  const now = Date.now();
  if (now - _lastFallbackWarnAt < SLOW_WARN_THROTTLE_MS) return;
  _lastFallbackWarnAt = now;
  try {
    process.stderr.write(
      `[child-spawn-gate] lane=${laneName} machine spawn budget unavailable`
      + ` (${error?.message || error}); using this process's bounded local lane\n`,
    );
  } catch { /* ignore */ }
}

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
export function acquire(signal = null, laneName = 'search', options = {}) {
  if (signal && signal.aborted) {
    return Promise.reject(signal.reason ?? _abortError());
  }
  const normalizedLaneName = _laneName(laneName);
  const lane = _lane(normalizedLaneName);
  const ownerKey = options?.ownerKey || currentToolExecutionOwner();
  const waitTimeoutMs = options?.waitTimeoutMs ?? lane.waitTimeoutMs;
  // Session shards defer to the machine-wide budget owned by the daemon-side
  // pool; the local lane remains the bounded fallback when the pool channel
  // cannot answer. Real admission rejections (wait timeout, queue full)
  // surface unchanged.
  if (remoteSpawnLeasesEnabled()) {
    return acquireRemoteSpawnLease({
      lane: normalizedLaneName,
      ownerKey,
      signal,
      waitTimeoutMs,
    }).catch((error) => {
      if (error?.code !== 'ELEASEFALLBACK') throw error;
      // Only a genuinely dead pool channel reaches here (the client re-arms
      // while the link is alive). Say so loudly: from this point the cap is
      // per-process, so N shards can hold N× the machine-wide budget.
      _warnLeaseFallback(error, normalizedLaneName);
      return _acquireLocal(signal, normalizedLaneName, lane, ownerKey, waitTimeoutMs);
    });
  }
  return _acquireLocal(signal, normalizedLaneName, lane, ownerKey, waitTimeoutMs);
}

function _acquireLocal(signal, normalizedLaneName, lane, ownerKey, waitTimeoutMs) {
  if (signal && signal.aborted) {
    return Promise.reject(signal.reason ?? _abortError());
  }
  const admitted = Promise.withResolvers();
  const held = Promise.withResolvers();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    held.resolve();
  };
  const running = lane.gate.run(ownerKey, async () => {
    admitted.resolve(release);
    await held.promise;
  }, {
    signal,
    waitTimeoutMs,
    onAdmit: (waitedMs) => _maybeWarnSlow(waitedMs, normalizedLaneName, {
      limit: lane.limit,
      queue: { length: lane.gate.queued },
    }),
  });
  running.catch((error) => admitted.reject(error));
  return admitted.promise;
}

function _abortError() {
  const e = new Error('child-spawn-gate: aborted while queued');
  e.code = 'ABORT_ERR';
  return e;
}

/**
 * Best-effort capacity probe for NON-COMPETING prewarm/warmup work. Returns
 * true only when a slot could be taken right now without queuing — i.e. below
 * the cap AND with no waiter already queued. Speculative warmers
 * code_graph / find prewarm) consult this to skip/defer when the daemon is
 * busy, so a fire-and-forget warm never pushes a real tool query into the
 * queue (the "non-competing under fanout" guarantee). This is a probe, NOT a
 * reservation: the answer can go stale under a race, which is acceptable for
 * best-effort work. Real queries must use acquire()/withGate() and never gate
 * themselves on this.
 */
export function hasSpareCapacity(laneName = 'search') {
  const lane = _lane(laneName);
  return lane.gate.active < lane.limit && lane.gate.queued === 0;
}

export function snapshot() {
  return {
    mode: remoteSpawnLeasesEnabled() ? 'remote-lease' : 'local',
    maxInflight: Number.isFinite(DEFAULT_MAX_INFLIGHT) ? DEFAULT_MAX_INFLIGHT : null,
    lanes: [..._lanes.entries()].map(([name, lane]) => {
      const state = lane.gate.snapshot();
      return {
        name,
        inflight: state.active,
        queued: state.queued,
        limit: Number.isFinite(lane.limit) ? lane.limit : null,
        queueMax: lane.queueMax,
        waitTimeoutMs: lane.waitTimeoutMs,
        owners: state.owners,
        oldestWaitMs: state.oldestWaitMs,
        admitted: state.admitted,
        rejected: state.rejected,
        timedOut: state.timedOut,
        averageWaitMs: state.averageWaitMs,
        maxWaitMs: state.maxWaitMs,
      };
    }),
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
