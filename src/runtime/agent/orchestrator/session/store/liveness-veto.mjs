/**
 * Runtime-liveness veto for the destructive paths (close, delete): the
 * caller-supplied `isSessionLive` probe over the daemon's in-memory runtime
 * state, plus — for the sweep (`legacyOwnerVeto`) — the legacy `.hb` / `.own`
 * markers an OLDER Mixdog process still running beside this one (mid-upgrade)
 * keeps publishing. No current build writes those markers; they are only ever
 * READ here, never refreshed.
 *
 * Separate from the write pipeline on purpose — a veto is a pure READ taken
 * before any commit lock is held, and markSessionClosed / deleteSession must
 * apply exactly the same rule.
 */
import { join } from 'node:path';
import { getStoreDir } from './session-paths.mjs';
import { probePath, readTextFile, PROBE_PRESENT } from './fs-probe.mjs';

export const LEGACY_MARKER_SUFFIXES = ['.hb', '.own'];
// An older live owner rewrote `.hb` every ≤5s mid-turn and `.own` every ~20s
// while holding the session open; one untouched this long holds nothing.
export const LEGACY_MARKER_FRESH_MS = 2 * 60 * 1000;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM means the pid exists.
    return error?.code === 'EPERM';
  }
}

/** A legacy marker's evidence, or null when it is not there to judge. The
 *  marker holds `<msTimestamp>\n<pid>\n`; a pid-less (pre-pid) marker names
 *  no owner, so it is neither live nor dead. */
export function readLegacyMarker(path, now = Date.now()) {
  const probe = probePath(path);
  if (probe.state !== PROBE_PRESENT) return null;
  const read = readTextFile(path);
  const pid = read.state === PROBE_PRESENT ? Number(read.text.split('\n')[1]) || 0 : 0;
  const alive = pid > 0 && processAlive(pid);
  return {
    fresh: now - (probe.mtimeMs || 0) <= LEGACY_MARKER_FRESH_MS,
    ownerAlive: alive,
    ownerDead: pid > 0 && !alive,
  };
}

/** Whether a legacy marker of the session names a live owner pid with a
 *  fresh heartbeat: that session is driven by another live process. */
export function _legacyOwnerLivenessVeto(id, now = Date.now()) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return false;
  const dir = getStoreDir();
  return LEGACY_MARKER_SUFFIXES.some((suffix) => {
    const marker = readLegacyMarker(join(dir, `${id}${suffix}`), now);
    return Boolean(marker?.fresh && marker.ownerAlive);
  });
}

export function _runtimeLivenessVeto(id, options = {}) {
  if (typeof options.isSessionLive === 'function' && options.isSessionLive(id)) return true;
  return options.legacyOwnerVeto === true && _legacyOwnerLivenessVeto(id);
}
