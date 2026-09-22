/**
 * Runtime-liveness evidence for the destructive paths (close, detach,
 * delete): the freshness of a session's `.hb` sidecar, the veto rules derived
 * from it and the caller-supplied `isSessionLive` probe.
 *
 * Separate from the write pipeline on purpose — a veto is a pure READ taken
 * before any commit lock is held, and markSessionClosed / deleteSession must
 * apply exactly the same rules.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getStoreDir, deleteHeartbeat } from './paths-heartbeat.mjs';

export function _heartbeatMtime(id) {
  try {
    const path = join(getStoreDir(), `${id}.hb`);
    return existsSync(path) ? statSync(path).mtimeMs || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * Freshness of a session's `.hb` heartbeat sidecar (0 when absent). Used by
 * the fork-on-resume guard: a fresh heartbeat published by another process
 * means the session is actively being driven there RIGHT NOW.
 */
export function readSessionHeartbeatMtime(id) {
  if (!id) return 0;
  return _heartbeatMtime(id);
}

export function _runtimeLivenessVeto(id, options = {}) {
  return typeof options.isSessionLive === 'function' && options.isSessionLive(id);
}

export function _heartbeatLivenessVeto(id, options = {}) {
  const heartbeatMtime = _heartbeatMtime(id);
  if (!(heartbeatMtime > 0)) return false;
  const hasHeartbeatSnapshot = Object.hasOwn(options, 'heartbeatSnapshotMtime');
  const snapshotMtime = Number(options.heartbeatSnapshotMtime) || 0;
  if (hasHeartbeatSnapshot && heartbeatMtime > snapshotMtime) return true;
  const freshMs = Number(options.heartbeatFreshMs);
  return Number.isFinite(freshMs) && freshMs > 0 && Date.now() - heartbeatMtime <= freshMs;
}

export function _deleteHeartbeatUnlessNewer(id, options = {}) {
  const hasHeartbeatSnapshot = Object.hasOwn(options, 'heartbeatSnapshotMtime');
  const snapshotMtime = Number(options.heartbeatSnapshotMtime) || 0;
  if (!hasHeartbeatSnapshot || _heartbeatMtime(id) <= snapshotMtime) {
    deleteHeartbeat(id);
  }
}
