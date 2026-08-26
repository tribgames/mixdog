import { normalize } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export const SESSION_RUNTIME_WORKER_UNHEALTHY_EVENT = 'mixdog:session-runtime-worker-unhealthy';

const ROOT_FAILURE_WINDOW_MS = 30_000;
const ROOT_FAILURE_THRESHOLD = 3;
const ABORT_PRESSURE_WINDOW_MS = 5 * 60_000;
const ABORT_PRESSURE_THRESHOLD = 3;
const EXPECTED_PATH_ERRORS = new Set(['EACCES', 'ENOENT', 'ENOTDIR', 'EPERM']);

let lastFailureAt = 0;
let unhealthyEmitted = false;
const failedRoots = new Map();
const abortPressureAt = [];

function isCurrentSessionRuntimeWorker() {
  return String(process.env.MIXDOG_SESSION_RUNTIME_WORKER_PID || '') === String(process.pid);
}

function canonicalRoot(path) {
  const value = normalize(String(path || ''));
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function resetFailures() {
  lastFailureAt = 0;
  unhealthyEmitted = false;
  failedRoots.clear();
}

export function reportRuntimeWorkerUnhealthy(detail = {}) {
  if (!isCurrentSessionRuntimeWorker() || unhealthyEmitted) return false;
  unhealthyEmitted = true;
  process.emit(SESSION_RUNTIME_WORKER_UNHEALTHY_EVENT, {
    reason: String(detail.reason || 'session runtime worker unhealthy'),
    ...detail,
  });
  return true;
}

export function recordRuntimeDirectoryReadSuccess() {
  resetFailures();
}

export function reportRuntimeDirectoryReadFailure(path, error, now = Date.now()) {
  if (!isCurrentSessionRuntimeWorker()) return false;
  const code = String(error?.code || 'UNKNOWN').toUpperCase();
  if (EXPECTED_PATH_ERRORS.has(code)) {
    resetFailures();
    return false;
  }
  if (now - lastFailureAt > ROOT_FAILURE_WINDOW_MS) resetFailures();
  lastFailureAt = now;
  failedRoots.set(canonicalRoot(path), {
    path: String(path || ''),
    code,
    message: String(error?.message || error || 'readdir failed'),
  });
  if (failedRoots.size < ROOT_FAILURE_THRESHOLD) return false;
  const failures = [...failedRoots.values()];
  return reportRuntimeWorkerUnhealthy({
    reason: `readdir failed across ${failures.length} distinct roots`,
    code,
    path: String(path || ''),
    distinctRoots: failures.length,
    failures,
  });
}

// ── Per-shard event-loop lag ───────────────────────────────────────────────
// Each runtime shard runs provider parsing, transcript projection and tool
// results on its OWN event loop, so lag is the per-shard saturation signal the
// daemon cannot see (it only measures itself). Lag is DIAGNOSTIC + ROUTING
// input, never a kill signal: a saturated shard still owns accepted input and
// in-flight turns, so the host quarantines it from NEW placement instead of
// recycling it out from under that work.
export const RUNTIME_LAG_DEFAULTS = Object.freeze({
  intervalMs: 5_000,
  warnP99Ms: 250,
  degradedP99Ms: 2_000,
  degradedSamples: 3,
  recoverP99Ms: 750,
});

function lagMs(value) {
  return Number.isFinite(value) ? Math.round(value / 1e6) : 0;
}

/**
 * Sample this process's event-loop delay on a fixed interval.
 * Returns a stop function; the timer is unref'd so it never holds the process.
 */
export function startRuntimeEventLoopLagMonitor({
  intervalMs = RUNTIME_LAG_DEFAULTS.intervalMs,
  resolution = 20,
  onSample = () => {},
} = {}) {
  const histogram = monitorEventLoopDelay({ resolution });
  histogram.enable();
  const timer = setInterval(() => {
    const sample = {
      p50Ms: lagMs(histogram.percentile(50)),
      p95Ms: lagMs(histogram.percentile(95)),
      p99Ms: lagMs(histogram.percentile(99)),
      maxMs: lagMs(histogram.max),
      meanMs: lagMs(histogram.mean),
      intervalMs,
      at: Date.now(),
    };
    histogram.reset();
    try { onSample(sample); } catch { /* telemetry must never throw upward */ }
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    try { histogram.disable(); } catch {}
  };
}

/**
 * Hysteresis state machine over lag samples: a shard becomes `degraded` only
 * after repeated sustained lag and recovers once it drops well below the
 * trigger, so a single GC pause never quarantines a healthy shard.
 */
export function createRuntimeLagTracker(overrides = {}) {
  const config = { ...RUNTIME_LAG_DEFAULTS, ...(overrides || {}) };
  let consecutive = 0;
  let degraded = false;
  let sample = null;
  return {
    get config() { return config; },
    get degraded() { return degraded; },
    get sample() { return sample; },
    record(next) {
      sample = next && typeof next === 'object' ? next : null;
      const p99 = Number(sample?.p99Ms) || 0;
      if (p99 >= config.degradedP99Ms) {
        consecutive += 1;
        if (!degraded && consecutive >= config.degradedSamples) {
          degraded = true;
          return { degraded, changed: true, sample, consecutive };
        }
        return { degraded, changed: false, sample, consecutive };
      }
      consecutive = 0;
      if (degraded && p99 <= config.recoverP99Ms) {
        degraded = false;
        return { degraded, changed: true, sample, consecutive };
      }
      return { degraded, changed: false, sample, consecutive };
    },
    reset() {
      consecutive = 0;
      degraded = false;
      sample = null;
    },
  };
}

export function reportRuntimeAbortListenerPressure(warning, now = Date.now(), retainedListeners = 0) {
  if (!isCurrentSessionRuntimeWorker()) return false;
  if (!Number.isFinite(Number(retainedListeners)) || Number(retainedListeners) <= 50) {
    return false;
  }
  while (abortPressureAt.length > 0 && now - abortPressureAt[0] > ABORT_PRESSURE_WINDOW_MS) {
    abortPressureAt.shift();
  }
  abortPressureAt.push(now);
  if (abortPressureAt.length < ABORT_PRESSURE_THRESHOLD) return false;
  const count = abortPressureAt.length;
  abortPressureAt.length = 0;
  return reportRuntimeWorkerUnhealthy({
    reason: `abort listener pressure repeated ${count} times`,
    code: 'ABORT_LISTENER_PRESSURE',
    count,
    retainedListeners: Number(retainedListeners),
    warning: String(warning?.message || warning || ''),
  });
}
