import { normalize } from 'node:path';

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
