/**
 * Bounded cache for cold transcript projections.
 *
 * A stored session read parses the whole record and rebuilds every transcript
 * row: 100-600ms of main-thread CPU for a multi-megabyte session. Two callers
 * pay that at once (a pane's prefetch read and its subscribe both land within
 * the same commit) and a merely VISIBLE cold pane pays it again every second
 * on the refresh clock, so every other cold open queues behind it.
 *
 * Validity is content identity: equal text and sidecar fingerprints mean an
 * identical projection, so the cached object is returned as-is (callers never
 * mutate it — they spread or deep-clone). A file whose stat still matches and
 * whose last write is old enough that no same-stamp rewrite is possible is
 * accepted without re-reading its body, which is what keeps the once-a-second
 * cold-view refresh off the disk entirely.
 */

import { createHash } from 'node:crypto';

// Serialized (UTF-8 JSON) bytes of the retained PROJECTIONS. A tail-window
// projection is ~0.1-1 MB; a legacy 512-item page of a worker transcript can
// reach ~16 MB, so this keeps a couple of those or dozens of tail windows.
export const STORED_TRANSCRIPT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
// Coarse filesystems stamp mtime at whole seconds (FAT: two). A write landing
// inside that window after our read could keep the same stat, so only a file
// untouched for longer than this is trusted by stat alone.
const SETTLED_FILE_AGE_MS = 2_500;
// Thrash guard. The refresh clock reads every visible cold pane round-robin;
// when their projections together exceed the byte budget (a handful of legacy
// 512-item pages of worker transcripts), plain LRU evicts each entry just
// before its next read and EVERY refresh re-reads and re-parses EVERY
// unchanged file. A key evicted for space and requested again (a ghost) is
// the signal: it is admitted only by evicting entries nobody has been served
// for ACTIVE_ENTRY_MS; otherwise the entries being refreshed stay and the
// newcomer is served uncached.
const ACTIVE_ENTRY_MS = 5_000;
const GHOST_LIMIT = 256;

function sameFileStat(left, right) {
  return (
    Boolean(left && right) &&
    ['mtimeMs', 'ctimeMs', 'size', 'ino', 'dev'].every(
      (field) => Number.isFinite(left[field]) && left[field] === right[field]
    )
  );
}

let stampSequence = 0;
const stampEpoch = `${process.pid}:${Date.now().toString(36)}`;

/** Process-unique identity for one cached projection. Equal stamps mean the
 *  same object graph; a re-parse (eviction, changed content) yields a new one. */
export function nextProjectionStamp() {
  stampSequence += 1;
  return `${stampEpoch}:${stampSequence}`;
}

export function createStoredTranscriptCache({
  // Bound retained content, not the number of small sessions. An eight-entry
  // LRU reparsed every unchanged record when nine visible sessions refreshed.
  maxEntries = Number.POSITIVE_INFINITY,
  maxBytes = STORED_TRANSCRIPT_CACHE_MAX_BYTES,
} = {}) {
  // Retain a content digest, not a second full transcript beside its projection.
  // The bound is the size of what is actually retained: the projection.
  /** key -> { textHash, textChars, bytes, group, fingerprint, value, usedAt } (Map order is LRU order). */
  const entries = new Map();
  /** key -> { text, fingerprint, promise } for reads still parsing. */
  const inFlight = new Map();
  /** Keys evicted for space (insertion order = age), bounded. */
  const ghosts = new Set();
  let retainedBytes = 0;

  const drop = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    retainedBytes -= entry.bytes;
    entries.delete(key);
  };
  const evict = (key) => {
    drop(key);
    ghosts.delete(key);
    ghosts.add(key);
    if (ghosts.size > GHOST_LIMIT) ghosts.delete(ghosts.values().next().value);
  };
  const overBudget = (extraEntries = 0, extraBytes = 0) =>
    entries.size + extraEntries > maxEntries || retainedBytes + extraBytes > maxBytes;
  const prune = () => {
    while (entries.size > 0 && overBudget()) evict(entries.keys().next().value);
  };
  // A returning ghost may displace only idle entries (oldest first).
  const makeRoomForGhost = (bytes, now) => {
    const idle = [];
    let freedEntries = 0;
    let freedBytes = 0;
    for (const [other, entry] of entries) {
      if (!overBudget(1 - freedEntries, bytes - freedBytes)) break;
      if (now - entry.usedAt <= ACTIVE_ENTRY_MS) continue;
      idle.push(other);
      freedEntries += 1;
      freedBytes += entry.bytes;
    }
    if (overBudget(1 - freedEntries, bytes - freedBytes)) return false;
    for (const other of idle) evict(other);
    return true;
  };
  const remember = (key, group, textChars, textHash, fingerprint, fileStat, value, now) => {
    drop(key);
    // One entry per group: a growing history window replaces its smaller
    // predecessor instead of accumulating beside it.
    if (group !== null) {
      for (const [other, entry] of [...entries]) if (entry.group === group) drop(other);
    }
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > maxBytes) return;
    if (ghosts.has(key)) {
      if (!makeRoomForGhost(bytes, now)) return;
      ghosts.delete(key);
    }
    entries.set(key, { textChars, textHash, bytes, group, fingerprint, fileStat, value, usedAt: now });
    retainedBytes += bytes;
    prune();
  };
  const touch = (key, entry, now) => {
    entry.usedAt = now;
    entries.delete(key);
    entries.set(key, entry);
  };

  return {
    /** The cached projection for this exact content, or a fresh one from
     *  `produce`. `loadText` runs only when stat alone cannot vouch for
     *  the entry. Concurrent callers with the same content share one parse.
     *  Entries naming the same `group` replace each other. */
    async read({ key, group = null, fingerprint, fileStat = null, loadText, produce, now = Date.now() }) {
      const cached = entries.get(key);
      if (
        cached &&
        cached.fingerprint === fingerprint &&
        sameFileStat(cached.fileStat, fileStat) &&
        now - Math.max(fileStat.mtimeMs, fileStat.ctimeMs) > SETTLED_FILE_AGE_MS
      ) {
        touch(key, cached, now);
        return { value: cached.value, hit: true, read: false };
      }
      const text = loadText();
      if (typeof text !== 'string') return { value: null, hit: false, read: true };
      // UTF-16 preserves exact JavaScript code units, including lone surrogates
      // that UTF-8 would collapse into the same replacement character.
      const textHash = createHash('sha256').update(text, 'utf16le').digest('hex');
      if (
        cached &&
        cached.fingerprint === fingerprint &&
        cached.textChars === text.length &&
        cached.textHash === textHash
      ) {
        cached.fileStat = fileStat;
        touch(key, cached, now);
        return { value: cached.value, hit: true, read: true };
      }
      const pending = inFlight.get(key);
      if (pending && pending.fingerprint === fingerprint && pending.text === text) {
        return { value: await pending.promise, hit: true, read: true };
      }
      const record = { text, fingerprint, promise: null };
      const promise = (async () => {
        const value = await produce(text);
        if (inFlight.get(key) === record && value && typeof value === 'object') {
          remember(key, group, text.length, textHash, fingerprint, fileStat, value, now);
        }
        return value;
      })();
      record.promise = promise;
      inFlight.set(key, record);
      try {
        return { value: await promise, hit: false, read: true };
      } finally {
        if (inFlight.get(key) === record) inFlight.delete(key);
      }
    },
    forget(keyPrefix) {
      for (const key of inFlight.keys()) {
        if (key.startsWith(keyPrefix)) inFlight.delete(key);
      }
      for (const key of [...entries.keys()]) {
        if (key.startsWith(keyPrefix)) drop(key);
      }
      for (const key of [...ghosts]) {
        if (key.startsWith(keyPrefix)) ghosts.delete(key);
      }
    },
    clear() {
      entries.clear();
      inFlight.clear();
      ghosts.clear();
      retainedBytes = 0;
    },
    stats() {
      return { entries: entries.size, retainedBytes, inFlight: inFlight.size };
    },
  };
}
