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

// Serialized (UTF-8 JSON) bytes of the retained PROJECTIONS: windows and pages
// sliced from a session's display history (which itself stays with the thread
// that built it); one larger than the whole budget is not retained.
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

const producedSlices = new WeakSet();
/** What a `produce` returns for a slice of a display history it may already
 *  hold: the value, its serialized `bytes` (measured by the producer) and
 *  whether a history was built for it (`historyBuilt`). */
export function producedSlice(value, { bytes = null, historyBuilt = true } = {}) {
  const slice = { value, bytes, historyBuilt };
  producedSlices.add(slice);
  return slice;
}

/** This realm's stamp epoch (a worker composes history stamps with its
 *  caller's). */
export function projectionStampEpoch() {
  return stampEpoch;
}

/** The identity of one display history: its session, record content and
 *  sidecar fingerprint, within one process epoch (a restart re-proves held
 *  rows by digest). Every slice of the history shares it, whichever thread
 *  built it and however often, so held rows stay proven across pages,
 *  evictions and worker restarts. */
export function historyStampOf(sessionId, textHash, textChars, fingerprint, epoch = stampEpoch) {
  const id = createHash('sha256')
    .update(`${sessionId}|${textHash}|${textChars}|${fingerprint}`)
    .digest('base64url')
    .slice(0, 22);
  return `${epoch}:h${id}`;
}

/** The retained entries and their eviction policy: byte/entry budget, paging
 *  pins, ghost admission and idle trimming. */
function createEntryStore({ maxEntries, maxBytes, maxIdleBytes }) {
  // Retain a content digest, not a second full transcript beside its projection.
  // The bound is the size of what is actually retained: the projection.
  /** key -> { textHash, textChars, bytes, group, fingerprint, value, usedAt } (Map order is LRU order). */
  const entries = new Map();
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
  // A history a reader is paging through (read with `pin` within
  // ACTIVE_ENTRY_MS) stays cached under pressure: every page would otherwise
  // build it again.
  const paging = (entry, now) => now - entry.pinnedAt <= ACTIVE_ENTRY_MS;
  // The newest entry stays (never larger than the budget: remember refuses
  // those). For an unpinned newcomer, entries being paged are not evicted; a
  // pinned one evicts whatever exceeds the budget, pinned or not.
  const prune = (now, keepPaging) => {
    const listed = [...entries];
    const newest = listed.at(-1)?.[0];
    for (const [key, entry] of listed) {
      if (!overBudget()) return;
      if (key === newest || (keepPaging && paging(entry, now))) continue;
      evict(key);
    }
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
  const remember = (key, group, textChars, textHash, fingerprint, fileStat, value, now, pin, measured) => {
    drop(key);
    // One entry per group: a growing history window replaces its smaller
    // predecessor instead of accumulating beside it.
    if (group !== null) {
      for (const [other, entry] of [...entries]) if (entry.group === group) drop(other);
    }
    // Values are slices (a window or page), never a whole history; the
    // producer's own measure is used when it has one.
    const bytes = Number.isSafeInteger(measured) && measured >= 0 ? measured : Buffer.byteLength(JSON.stringify(value));
    // Larger than the whole budget: served uncached, pinned or not.
    if (bytes > maxBytes) return;
    if (pin) ghosts.delete(key);
    else {
      if (ghosts.has(key)) {
        if (!makeRoomForGhost(bytes, now)) return;
        ghosts.delete(key);
      }
      // Never in place of a history being paged: served uncached instead.
      let pagedBytes = 0;
      for (const entry of entries.values()) if (paging(entry, now)) pagedBytes += entry.bytes;
      if (pagedBytes > 0 && pagedBytes + bytes > maxBytes) return;
    }
    const pinnedAt = pin ? now : Number.NEGATIVE_INFINITY;
    entries.set(key, { textChars, textHash, bytes, group, fingerprint, fileStat, value, usedAt: now, pinnedAt });
    retainedBytes += bytes;
    prune(now, !pin);
  };
  const touch = (key, entry, now, pin = false) => {
    entry.usedAt = now;
    if (pin) entry.pinnedAt = now;
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

  return {
    get: (key) => entries.get(key),
    remember,
    touch,
    trimIdle,
    entryWithContent,
    release(keyPrefix, now) {
      for (const [key, entry] of entries) {
        if (key.startsWith(keyPrefix)) entry.usedAt = Math.min(entry.usedAt, now - ACTIVE_ENTRY_MS - 1);
      }
      trimIdle(now);
    },
    forget(keyPrefix) {
      for (const key of [...entries.keys()]) {
        if (key.startsWith(keyPrefix)) drop(key);
      }
      for (const key of [...ghosts]) {
        if (key.startsWith(keyPrefix)) ghosts.delete(key);
      }
    },
    clear() {
      entries.clear();
      ghosts.clear();
      retainedBytes = 0;
    },
    stats: () => ({ entries: entries.size, retainedBytes, ghosts: ghosts.size }),
  };
}

export function createStoredTranscriptCache({
  // Bound retained content, not the number of small sessions. An eight-entry
  // LRU reparsed every unchanged record when nine visible sessions refreshed.
  maxEntries = Number.POSITIVE_INFINITY,
  maxBytes = STORED_TRANSCRIPT_CACHE_MAX_BYTES,
  maxIdleBytes = STORED_TRANSCRIPT_IDLE_MAX_BYTES,
} = {}) {
  const store = createEntryStore({ maxEntries, maxBytes, maxIdleBytes });
  /** key -> { text, fingerprint, promise } for reads still parsing. */
  const inFlight = new Map();
  /** key -> { fingerprint, fileStat, promise } for reads not yet answered,
   *  from before their body is loaded. */
  const reading = new Map();
  // Projections produced (here or by `project`), cached or not.
  let builds = 0;

  // `project(known)` reads, digests and projects the record elsewhere (a
  // worker thread) in one step: `{ textChars, textHash, value }`, or
  // `{ textChars, textHash, same: true }` without a projection when the
  // content is the `known` digest of the cached entry; null when the record
  // cannot be read. Undefined when it could not answer at all.
  async function readProjected({ key, group, fingerprint, fileStat, project, now, pin }) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cached = store.get(key);
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
        const entry = store.entryWithContent(key, fingerprint, answer);
        // Evicted meanwhile: project it after all.
        if (!entry) continue;
        entry.fileStat = fileStat;
        store.touch(key, entry, now, pin);
        return { value: entry.value, hit: true, read: true };
      }
      const value = answer.value ?? null;
      // A worker that served the slice from a history it already held built nothing.
      const built = Boolean(value && typeof value === 'object' && answer.historyBuilt !== false);
      if (built) builds += 1;
      if (current && value && typeof value === 'object') {
        store.remember(
          key,
          group,
          answer.textChars,
          answer.textHash,
          fingerprint,
          fileStat,
          value,
          now,
          pin,
          answer.bytes
        );
      }
      return { value, hit: false, read: true, built };
    }
    return undefined;
  }

  async function readFresh({ key, group, fingerprint, fileStat, loadText, produce, project, now, pin }) {
    if (typeof project === 'function') {
      const answered = await readProjected({ key, group, fingerprint, fileStat, project, now, pin });
      if (answered !== undefined) return answered;
      // It could not answer (worker unavailable): load and produce here.
    }
    const cached = store.get(key);
    // `loadText` may answer asynchronously (a large record is read without
    // blocking the loop); a plain string is unchanged.
    let text = loadText();
    if (typeof text?.then === 'function') text = await text;
    if (typeof text !== 'string') return { value: null, hit: false, read: true };
    const textHash = transcriptTextHash(text);
    if (cached && store.entryWithContent(key, fingerprint, { textChars: text.length, textHash }) === cached) {
      cached.fileStat = fileStat;
      store.touch(key, cached, now, pin);
      return { value: cached.value, hit: true, read: true };
    }
    const pending = inFlight.get(key);
    if (pending && pending.fingerprint === fingerprint && pending.text === text) {
      return { value: await pending.promise, hit: true, read: true };
    }
    const record = { text, fingerprint, promise: null };
    let built = false;
    const promise = (async () => {
      const produced = await produce(text);
      const slice = producedSlices.has(produced) ? produced : null;
      const value = slice ? slice.value : produced;
      built = Boolean(value && typeof value === 'object' && slice?.historyBuilt !== false);
      if (built) builds += 1;
      if (inFlight.get(key) === record && value && typeof value === 'object') {
        store.remember(key, group, text.length, textHash, fingerprint, fileStat, value, now, pin, slice?.bytes);
      }
      return value;
    })();
    record.promise = promise;
    inFlight.set(key, record);
    try {
      const value = await promise;
      return { value, hit: false, read: true, built };
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
     *  Entries naming the same `group` replace each other. `pin`: a reader is
     *  paging through this entry — it is cached however full the cache is,
     *  and for ACTIVE_ENTRY_MS no unpinned newcomer evicts it. */
    async read({
      key,
      group = null,
      fingerprint,
      fileStat = null,
      loadText,
      produce,
      project = null,
      now = Date.now(),
      pin = false,
    }) {
      store.trimIdle(now);
      const cached = store.get(key);
      if (cached && cached.fingerprint === fingerprint && settledSameFile(cached.fileStat, fileStat, now)) {
        store.touch(key, cached, now, pin);
        return { value: cached.value, hit: true, read: false };
      }
      const joined = reading.get(key);
      if (joined && joined.fingerprint === fingerprint && settledSameFile(joined.fileStat, fileStat, now)) {
        const { value } = await joined.promise;
        // A read that found nothing is not shared: this caller learns why itself.
        if (value) return { value, hit: true, read: false };
      }
      const record = { fingerprint, fileStat, promise: null };
      record.promise = readFresh({ key, group, fingerprint, fileStat, loadText, produce, project, now, pin });
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
      store.release(keyPrefix, now);
    },
    forget(keyPrefix) {
      for (const pending of [inFlight, reading]) {
        for (const key of pending.keys()) {
          if (key.startsWith(keyPrefix)) pending.delete(key);
        }
      }
      store.forget(keyPrefix);
    },
    clear() {
      store.clear();
      inFlight.clear();
      reading.clear();
      builds = 0;
    },
    stats() {
      const { entries, retainedBytes, ghosts } = store.stats();
      return { entries, retainedBytes, inFlight: inFlight.size, reading: reading.size, ghosts, builds };
    },
  };
}
