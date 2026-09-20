// Retention of daemon crash captures, stated exactly:
//   * COMPLETED boots (the launcher saw the exit, or neither the daemon nor its
//     launcher is alive any more) share a budget of CRASH_CAPTURE_KEEP_BOOTS
//     boots and CRASH_CAPTURE_KEEP_BYTES bytes. An oversized completed capture
//     is TRIMMED to its last CRASH_CAPTURE_TAIL_BYTES — the fatal report is the
//     tail — and keeps its sidecar; the newest completed boot is never deleted,
//     because that is the crash somebody is about to investigate.
//   * ACTIVE boots (a live daemon, or a launch still in progress) and UNKNOWN
//     boots (identity missing or damaged, so nobody can prove the writer is
//     gone) are never read-modified, never trimmed and never unlinked. Their
//     bytes sit OUTSIDE the completed-boot budget: at any moment the directory
//     holds the completed budget PLUS the active and unknown captures, and an
//     active capture's size is bounded only by what the daemon writes to fd 2
//     until it exits. Retention never guesses from age: losing a live daemon's
//     fatal evidence is worse than keeping an orphan file.
import fs from 'node:fs';
import path from 'node:path';
import { isPidAlive } from '../../runtime/shared/pid-liveness.mjs';
import { daemonCrashCaptureDir } from './paths.mjs';

// Prune only files this module creates: `daemon-<yyyymmdd>-<hhmmss>-<pid>-<rand>`.
const CAPTURE_STEM_RE = /^daemon-\d{8}-\d{6}-\d+-[0-9a-f]{4}$/;
const CAPTURE_SUFFIXES = ['.err.log', '.json'];
// Debris from this module's own atomic sidecar writes (writeFileAtomicSync
// names its temp `.<basename>.<hex>.tmp`), never anyone else's file.
const CAPTURE_TEMP_RE = /^\.daemon-\d{8}-\d{6}-(\d+)-[0-9a-f]{4}\.json\.[0-9a-f]+\.tmp$/;
export const CRASH_CAPTURE_KEEP_BOOTS = 8;
const CRASH_CAPTURE_KEEP_BYTES = 2 * 1024 * 1024;
const CRASH_CAPTURE_TAIL_BYTES = 256 * 1024;

function captureStem(name) {
  for (const suffix of CAPTURE_SUFFIXES) {
    if (!name.endsWith(suffix)) continue;
    const stem = name.slice(0, -suffix.length);
    if (CAPTURE_STEM_RE.test(stem)) return stem;
  }
  return null;
}

/**
 * Ownership state of one boot's capture: `completed`, `active` or `unknown`.
 *
 * Only a PROVEN dead owner makes a boot prunable — an exit the launcher
 * recorded, or a child pid that is recorded and no longer alive. Anything the
 * metadata cannot prove (no sidecar yet, a damaged sidecar, a launcher that
 * died before publishing its child pid) is `unknown` and stays on disk: age is
 * not evidence, and an hours-old capture may still belong to a running daemon
 * whose metadata was damaged.
 */
export function daemonCaptureBootState(boot, { pidAlive = isPidAlive } = {}) {
  let record = null;
  if (boot.recordPath) {
    try {
      record = JSON.parse(fs.readFileSync(boot.recordPath, 'utf8'));
    } catch {
      record = null;
    }
  }
  if (!record || typeof record !== 'object') return 'unknown';
  if (record.exitedAt) return 'completed';
  if (pidAlive(record.pid)) return 'active';
  if (record.pid === null || record.pid === undefined) {
    // Launch in progress: fd 2 is open and no child pid has been published.
    // A dead launcher here proves nothing about a child it may have forked.
    return pidAlive(record.launcherPid) ? 'active' : 'unknown';
  }
  // A recorded child pid that is gone: that daemon is provably over, even when
  // the launcher died before it could write the exit record.
  return 'completed';
}

/** Keep the tail of an oversized COMPLETED capture instead of deleting the
 *  whole file: a V8 fatal report is the last thing written. */
function trimCaptureTail(rawPath, maxBytes) {
  try {
    const size = fs.statSync(rawPath).size;
    if (size <= maxBytes) return size;
    const handle = fs.openSync(rawPath, 'r');
    let tail = Buffer.allocUnsafe(maxBytes);
    try {
      const bytesRead = fs.readSync(handle, tail, 0, maxBytes, size - maxBytes);
      tail = tail.subarray(0, bytesRead);
    } finally {
      fs.closeSync(handle);
    }
    const header = Buffer.from(`[capture trimmed: dropped ${size - tail.length} earlier byte(s)]\n`);
    fs.writeFileSync(rawPath, Buffer.concat([header, tail]));
    return header.length + tail.length;
  } catch {
    return -1;
  }
}

function collectBoots(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const boots = new Map();
  const temps = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const temp = CAPTURE_TEMP_RE.exec(entry.name);
    if (temp) {
      // Our own atomic-write temp. Its writer is the launcher pid encoded in
      // the target stem — the only thing that can prove it is debris.
      temps.push({ path: path.join(dir, entry.name), writerPid: Number(temp[1]) || 0 });
      continue;
    }
    const stem = captureStem(entry.name);
    if (!stem) continue;
    const full = path.join(dir, entry.name);
    let size = 0;
    let mtimeMs = 0;
    try {
      const stat = fs.statSync(full);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    const boot = boots.get(stem) || {
      stem,
      files: [],
      bytes: 0,
      mtimeMs: 0,
      recordPath: null,
      rawPath: null,
      rawBytes: 0,
    };
    boot.files.push(full);
    boot.bytes += size;
    boot.mtimeMs = Math.max(boot.mtimeMs, mtimeMs);
    if (entry.name.endsWith('.json')) boot.recordPath = full;
    else {
      boot.rawPath = full;
      boot.rawBytes = size;
    }
    boots.set(stem, boot);
  }
  return {
    ordered: [...boots.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || (a.stem < b.stem ? 1 : -1)),
    temps,
  };
}

/** Bound retained COMPLETED captures across daemon restarts. Active captures
 *  are left exactly as they are, the newest completed crash is never deleted,
 *  and nothing outside this module's own naming is ever touched. */
export function pruneDaemonCrashCaptures({
  dir = daemonCrashCaptureDir(),
  keepBoots = CRASH_CAPTURE_KEEP_BOOTS,
  keepBytes = CRASH_CAPTURE_KEEP_BYTES,
  tailBytes = CRASH_CAPTURE_TAIL_BYTES,
  pidAlive = isPidAlive,
} = {}) {
  const maxBoots = Math.max(1, Number(keepBoots) || CRASH_CAPTURE_KEEP_BOOTS);
  const maxBytes = Math.max(64 * 1024, Number(keepBytes) || CRASH_CAPTURE_KEEP_BYTES);
  const maxTail = Math.max(4 * 1024, Number(tailBytes) || CRASH_CAPTURE_TAIL_BYTES);
  const collected = collectBoots(dir);
  if (!collected) {
    return { removed: 0, trimmed: 0, keptBoots: 0, keptBytes: 0, activeBoots: 0, unknownBoots: 0 };
  }
  const { ordered, temps } = collected;
  for (const temp of temps) {
    // Only a dead writer proves a temp is debris. A live (or unidentifiable)
    // writer keeps it: an unfinished atomic write is not garbage by age.
    if (!temp.writerPid || pidAlive(temp.writerPid)) continue;
    try {
      fs.rmSync(temp.path, { force: true });
    } catch {}
  }
  let removed = 0;
  let trimmed = 0;
  let keptBoots = 0;
  let keptBytes = 0;
  let activeBoots = 0;
  let unknownBoots = 0;
  let newestCompletedSeen = false;
  for (const boot of ordered) {
    const state = daemonCaptureBootState(boot, { pidAlive });
    if (state !== 'completed') {
      // Active and unknown boots are untouchable and sit outside the budget.
      if (state === 'active') activeBoots += 1;
      else unknownBoots += 1;
      continue;
    }
    const newestCompleted = !newestCompletedSeen;
    newestCompletedSeen = true;
    let bytes = boot.bytes;
    if (boot.rawPath && boot.rawBytes > maxTail) {
      const size = trimCaptureTail(boot.rawPath, maxTail);
      if (size >= 0) {
        bytes = bytes - boot.rawBytes + size;
        trimmed += 1;
      }
    }
    // The newest completed boot survives even when it alone spends the whole
    // byte budget: its trimmed tail and sidecar ARE the crash evidence.
    if (newestCompleted || (keptBoots < maxBoots && keptBytes + bytes <= maxBytes)) {
      keptBoots += 1;
      keptBytes += bytes;
      continue;
    }
    for (const file of boot.files) {
      try {
        fs.rmSync(file, { force: true });
        removed += 1;
      } catch {
        /* a locked capture simply stays */
      }
    }
  }
  return { removed, trimmed, keptBoots, keptBytes, activeBoots, unknownBoots };
}
