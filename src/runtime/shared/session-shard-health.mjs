import { normalize } from 'node:path';

export const SESSION_SHARD_UNHEALTHY_EVENT = 'mixdog:session-shard-unhealthy';

const ROOT_FAILURE_WINDOW_MS = 30_000;
const ROOT_FAILURE_THRESHOLD = 3;
const ABORT_PRESSURE_WINDOW_MS = 5 * 60_000;
const ABORT_PRESSURE_THRESHOLD = 3;
const EXPECTED_PATH_ERRORS = new Set(['EACCES', 'ENOENT', 'ENOTDIR', 'EPERM']);

let lastFailureAt = 0;
let unhealthyEmitted = false;
const failedRoots = new Map();
const abortPressureAt = [];

function isCurrentSessionShard() {
  return String(process.env.MIXDOG_SESSION_SHARD_PID || '') === String(process.pid);
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

export function reportShardUnhealthy(detail = {}) {
  if (!isCurrentSessionShard() || unhealthyEmitted) return false;
  unhealthyEmitted = true;
  process.emit(SESSION_SHARD_UNHEALTHY_EVENT, {
    reason: String(detail.reason || 'session shard unhealthy'),
    ...detail,
  });
  return true;
}

export function recordShardDirectoryReadSuccess() {
  resetFailures();
}

export function reportShardDirectoryReadFailure(path, error, now = Date.now()) {
  if (!isCurrentSessionShard()) return false;
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
  return reportShardUnhealthy({
    reason: `readdir failed across ${failures.length} distinct roots`,
    code,
    path: String(path || ''),
    distinctRoots: failures.length,
    failures,
  });
}

export function reportShardAbortListenerPressure(warning, now = Date.now(), retainedListeners = 0) {
  if (!isCurrentSessionShard()) return false;
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
  return reportShardUnhealthy({
    reason: `abort listener pressure repeated ${count} times`,
    code: 'ABORT_LISTENER_PRESSURE',
    count,
    retainedListeners: Number(retainedListeners),
    warning: String(warning?.message || warning || ''),
  });
}
