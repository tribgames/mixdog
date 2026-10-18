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
const STORED_TRANSCRIPT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
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
// Projections nobody is being served (a view that left, a hover/boot
// prefetch never opened) stay for a quick revisit only within this budget;
// the full budget above is for the views still refreshing.
const STORED_TRANSCRIPT_IDLE_MAX_BYTES = 4 * 1024 * 1024;

function sameFileStat(left, right) {
  return (
    Boolean(left && right) &&
    ['mtimeMs', 'ctimeMs', 'size', 'ino', 'dev'].every(
      (field) => Number.isFinite(left[field]) && left[field] === right[field]
    )
  );
}

// The file at `fileStat` provably still holds the bytes read under `known`.
const settledSameFile = (known, fileStat, now) =>
  sameFileStat(known, fileStat) && now - Math.max(fileStat.mtimeMs, fileStat.ctimeMs) > SETTLED_FILE_AGE_MS;

/** Content identity of a record's text. UTF-16 preserves exact JavaScript
 *  code units, including lone surrogates that UTF-8 would collapse into the
 *  same replacement character. */
export function transcriptTextHash(text) {
  return createHash('sha256').update(text, 'utf16le').digest('hex');
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
  maxIdleBytes = STORED_TRANSCRIPT_IDLE_MAX_BYTES,
} = {}) {
  // Retain a content digest, not a second full transcript beside its projection.
  // The bound is the size of what is actually retained: the projection.
  /** key -> { textHash, textChars, bytes, group, fingerprint, value, usedAt } (Map order is LRU order). */
  const entries = new Map();
  /** key -> { text, fingerprint, promise } for reads still parsing. */
  const inFlight = new Map();
  /** key -> { fingerprint, fileStat, promise } for reads not yet answered,
   *  from before their body is loaded. */
  const reading = new Map();
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
  // Oldest idle entries go first until the idle ones fit their own budget.
  const trimIdle = (now) => {
    let idleBytes = 0;
    for (const entry of entries.values()) if (now - entry.usedAt > ACTIVE_ENTRY_MS) idleBytes += entry.bytes;
    for (const [key, entry] of [...entries]) {
      if (idleBytes <= maxIdleBytes) break;
      if (now - entry.usedAt <= ACTIVE_ENTRY_MS) continue;
      idleBytes -= entry.bytes;
      drop(key);
    }
  };

  // The cached entry, when it still holds content identified by `digest`.
  const entryWithContent = (key, fingerprint, digest) => {
    const entry = entries.get(key);
    return entry &&
      entry.fingerprint === fingerprint &&
      entry.textChars === digest.textChars &&
      entry.textHash === digest.textHash
      ? entry
      : null;
  };

  // `project(known)` reads, digests and projects the record elsewhere (a
  // worker thread) in one step: `{ textChars, textHash, value }`, or
  // `{ textChars, textHash, same: true }` without a projection when the
  // content is the `known` digest of the cached entry; null when the record
  // cannot be read. Undefined when it could not answer at all.
  async function readProjected({ key, group, fingerprint, fileStat, project, now }) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cached = entries.get(key);
      const known =
        attempt === 0 && cached?.fingerprint === fingerprint
          ? { textChars: cached.textChars, textHash: cached.textHash }
          : null;
      // A newer read of this key, clear or forget replaces or drops the
      // record; only a still-current answer may then be remembered.
      const record = { text: null, fingerprint, promise: null };
      inFlight.set(key, record);
      let answer;
      try {
        answer = await project(known);
      } catch {
        answer = undefined;
      }
      const current = inFlight.get(key) === record;
      if (current) inFlight.delete(key);
      if (answer === undefined) return undefined;
      if (answer === null || typeof answer !== 'object') return { value: null, hit: false, read: true };
      if (answer.same === true) {
        const entry = entryWithContent(key, fingerprint, answer);
        // Evicted meanwhile: project it after all.
        if (!entry) continue;
        entry.fileStat = fileStat;
        touch(key, entry, now);
        return { value: entry.value, hit: true, read: true };
      }
      const value = answer.value ?? null;
      if (current && value && typeof value === 'object') {
        remember(key, group, answer.textChars, answer.textHash, fingerprint, fileStat, value, now);
      }
      return { value, hit: false, read: true };
    }
    return undefined;
  }

  async function readFresh({ key, group, fingerprint, fileStat, loadText, produce, project, now }) {
    if (typeof project === 'function') {
      const answered = await readProjected({ key, group, fingerprint, fileStat, project, now });
      if (answered !== undefined) return answered;
      // It could not answer (worker unavailable): load and produce here.
    }
    const cached = entries.get(key);
    // `loadText` may answer asynchronously (a large record is read without
    // blocking the loop); a plain string is unchanged.
    let text = loadText();
    if (typeof text?.then === 'function') text = await text;
    if (typeof text !== 'string') return { value: null, hit: false, read: true };
    const textHash = transcriptTextHash(text);
    if (cached && entryWithContent(key, fingerprint, { textChars: text.length, textHash }) === cached) {
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
  }

  return {
    /** The cached projection for this exact content, or a fresh one from
     *  `project` (when given and able to answer) or `produce`. `loadText` /
     *  `project` run only when stat alone cannot vouch for the entry.
     *  Concurrent callers with the same content share one parse; callers of
     *  one unchanged, settled file share one read before it is even loaded.
     *  Entries naming the same `group` replace each other. */
    async read({
      key,
      group = null,
      fingerprint,
      fileStat = null,
      loadText,
      produce,
      project = null,
      now = Date.now(),
    }) {
      trimIdle(now);
      const cached = entries.get(key);
      if (cached && cached.fingerprint === fingerprint && settledSameFile(cached.fileStat, fileStat, now)) {
        touch(key, cached, now);
        return { value: cached.value, hit: true, read: false };
      }
      const joined = reading.get(key);
      if (joined && joined.fingerprint === fingerprint && settledSameFile(joined.fileStat, fileStat, now)) {
        const { value } = await joined.promise;
        // A read that found nothing is not shared: this caller learns why itself.
        if (value) return { value, hit: true, read: false };
      }
      const record = { fingerprint, fileStat, promise: null };
      record.promise = readFresh({ key, group, fingerprint, fileStat, loadText, produce, project, now });
      reading.set(key, record);
      try {
        return await record.promise;
      } finally {
        if (reading.get(key) === record) reading.delete(key);
      }
    },
    /** The last view of these projections left: they turn idle now and stay
     *  only within the idle budget, ready for a revisit. */
    release(keyPrefix, now = Date.now()) {
      for (const [key, entry] of entries) {
        if (key.startsWith(keyPrefix)) entry.usedAt = Math.min(entry.usedAt, now - ACTIVE_ENTRY_MS - 1);
      }
      trimIdle(now);
    },
    forget(keyPrefix) {
      for (const pending of [inFlight, reading]) {
        for (const key of pending.keys()) {
          if (key.startsWith(keyPrefix)) pending.delete(key);
        }
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
      reading.clear();
      ghosts.clear();
      retainedBytes = 0;
    },
    stats() {
      return {
        entries: entries.size,
        retainedBytes,
        inFlight: inFlight.size,
        reading: reading.size,
        ghosts: ghosts.size,
      };
    },
  };
}
