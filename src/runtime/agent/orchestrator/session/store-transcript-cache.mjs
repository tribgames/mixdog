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

const DEFAULT_MAX_TEXT_CHARS = 64 * 1024 * 1024;
// Coarse filesystems stamp mtime at whole seconds (FAT: two). A write landing
// inside that window after our read could keep the same stat, so only a file
// untouched for longer than this is trusted by stat alone.
const SETTLED_FILE_AGE_MS = 2_500;

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
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
} = {}) {
  // Retain a content digest, not a second full transcript beside its projection.
  // The original character count still bounds the amount of projected content.
  /** key -> { textHash, textChars, fingerprint, value } (Map order is LRU order). */
  const entries = new Map();
  /** key -> { text, fingerprint, promise } for reads still parsing. */
  const inFlight = new Map();
  let retainedChars = 0;

  const drop = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    retainedChars -= entry.textChars;
    entries.delete(key);
  };
  const prune = () => {
    while (entries.size > 0 && (entries.size > maxEntries || retainedChars > maxTextChars)) {
      drop(entries.keys().next().value);
    }
  };
  const remember = (key, textChars, textHash, fingerprint, fileStat, value) => {
    drop(key);
    if (textChars > maxTextChars) return;
    entries.set(key, { textChars, textHash, fingerprint, fileStat, value });
    retainedChars += textChars;
    prune();
  };
  const touch = (key, entry) => {
    entries.delete(key);
    entries.set(key, entry);
  };

  return {
    /** The cached projection for this exact content, or a fresh one from
     *  `produce`. `loadText` runs only when stat alone cannot vouch for
     *  the entry. Concurrent callers with the same content share one parse. */
    async read({ key, fingerprint, fileStat = null, loadText, produce, now = Date.now() }) {
      const cached = entries.get(key);
      if (
        cached &&
        cached.fingerprint === fingerprint &&
        sameFileStat(cached.fileStat, fileStat) &&
        now - Math.max(fileStat.mtimeMs, fileStat.ctimeMs) > SETTLED_FILE_AGE_MS
      ) {
        touch(key, cached);
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
        touch(key, cached);
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
          remember(key, text.length, textHash, fingerprint, fileStat, value);
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
    },
    clear() {
      entries.clear();
      inFlight.clear();
      retainedChars = 0;
    },
    stats() {
      return { entries: entries.size, retainedChars, inFlight: inFlight.size };
    },
  };
}
