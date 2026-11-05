/**
 * File identity stamps and the strict lifecycle reader of a legacy
 * `<id>.json` record. A session's authoritative record goes through the
 * legacy seam (session-log-reader.mjs resolveSessionRecord); this module is
 * what readers of the json document itself share.
 */
import { readFileSync, statSync } from 'node:fs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from '../lifecycle-scan.mjs';
import { holdsNoData } from '../../../../shared/atomic-file.mjs';

export const CANONICAL_RECORD_UNREADABLE = Symbol('lifecycle-ambiguous');

// ── File identity stamps ─────────────────────────────────────────────────────
// { dev, ino, size, mtimeNs, ctimeNs } from a bigint stat.
export function sessionStampOf(info) {
  return Object.freeze({
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  });
}

export function statSessionStamp(target) {
  return sessionStampOf(statSync(target, { bigint: true }));
}

export function sameSessionStamp(a, b) {
  return (
    !!a &&
    !!b &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

// An observation whose change time is this close to "now" could still share
// its stamp with a later IN-PLACE rewrite landing in the same filesystem
// timestamp tick (coarse clocks: jiffies, the Windows timer, 1–2 s on
// HFS+/FAT). Such racy observations are never cached; the next check re-reads.
const RACY_STAMP_WINDOW_NS = 2_000_000_000n;

function settledStamp(stamp, nowNs) {
  const changed = stamp.ctimeNs > stamp.mtimeNs ? stamp.ctimeNs : stamp.mtimeNs;
  return nowNs - changed > RACY_STAMP_WINDOW_NS;
}

/** Whether a verdict parsed from bytes observed at `stamp` may be cached under it. */
export function isSettledSessionStamp(stamp, nowNs = BigInt(Date.now()) * 1_000_000n) {
  return !!stamp && settledStamp(stamp, nowNs);
}

/**
 * Strict reads of a json record. Lifecycle reads (`lifecycleOnly`) stat
 * first: a cached settled stamp returns its verdict without reading;
 * everything else — including every stat failure — reads and strictly parses
 * the CURRENT bytes. Only parsed lifecycle fields are cached, never file
 * text. Full reads always receive a fresh, privately owned document.
 * `ownCommitsOnly` never uses the cache.
 */
export function createCanonicalSessionReader({
  readText = (target) => readFileSync(target, 'utf-8'),
  statStamp = statSessionStamp,
  nowNs = () => BigInt(Date.now()) * 1_000_000n,
  maxEntries = 256,
} = {}) {
  const entries = new Map(); // target → { stamp, value }
  const forget = (target) => {
    entries.delete(target);
  };
  const observe = (target) => {
    try {
      return statStamp(target);
    } catch {
      return null;
    }
  };
  const remember = (target, stamp, value) => {
    if (maxEntries <= 0) return;
    entries.set(target, { stamp, value });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  };
  const read = (target, lifecycleOnly = false, { ownCommitsOnly = false } = {}) => {
    const before = lifecycleOnly ? observe(target) : null;
    if (before && !ownCommitsOnly) {
      const cached = entries.get(target);
      if (cached && sameSessionStamp(cached.stamp, before)) {
        entries.delete(target);
        entries.set(target, cached);
        return cached.value;
      }
    }
    let raw;
    try {
      raw = readText(target);
    } catch (error) {
      forget(target);
      return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? null : CANONICAL_RECORD_UNREADABLE;
    }
    // Empty or NUL-filled (a crash left no data): nothing owns this identity,
    // exactly like a missing file.
    const noData = holdsNoData(raw);
    const record = noData ? null : readTopLevelLifecycleRecord(raw);
    const invalid = !noData && isLifecycleUnreadable(record);
    if (!lifecycleOnly) return noData ? null : invalid ? CANONICAL_RECORD_UNREADABLE : record;
    const value = noData
      ? null
      : invalid
        ? CANONICAL_RECORD_UNREADABLE
        : Object.freeze({ id: record.id, closed: record.closed, generation: record.generation });
    forget(target);
    // Reused only when the bytes provably came from `before` (unchanged
    // around the read), and only past the racy window.
    const stable = Boolean(before) && sameSessionStamp(before, observe(target));
    if (stable && settledStamp(before, nowNs())) remember(target, before, value);
    return value;
  };
  return Object.assign(read, {
    forget,
    /**
     * A strict parse another reader already made of bytes it proved to
     * belong to `stamp` (stat → read → stat, unchanged): cached exactly as
     * this reader's own lifecycle reads are — settled stamps only, reused
     * only while the full stamp is unchanged.
     */
    rememberStrictVerdict(target, stamp, record) {
      if (!stamp || isLifecycleUnreadable(record) || !settledStamp(stamp, nowNs())) return;
      remember(target, stamp, Object.freeze({ id: record.id, closed: record.closed, generation: record.generation }));
    },
    clear() {
      entries.clear();
    },
    // No file text is retained; `retainedChars` stays for callers that report it.
    stats: () => ({ entries: entries.size, retainedChars: 0 }),
  });
}

export const readCanonicalSessionRecord = createCanonicalSessionReader();
