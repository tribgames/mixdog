import { readFileSync, statSync } from 'node:fs';
import { receiveMessageOnPort } from 'node:worker_threads';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from '../lifecycle-scan.mjs';

export const CANONICAL_RECORD_UNREADABLE = Symbol('lifecycle-ambiguous');

// ── File identity stamps ─────────────────────────────────────────────────────
// { dev, ino, size, mtimeNs, ctimeNs } from a bigint stat. Every session writer
// replaces the canonical file by rename, which always brings a NEW inode and a
// new change time, so another writer's replacement — same size or not — never
// carries the stamp of the file this realm observed or committed.
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

// ── Own commits ──────────────────────────────────────────────────────────────
// After this realm renames a session file into place it knows the exact
// lifecycle it wrote. The stamp of that rename, verified to still be OUR inode,
// lets every later authority check reuse the verdict for a single stat; any
// other stamp (foreign writer, rename by another process, deletion, a barrier
// rewrite) misses and takes the strict read.
const OWN_COMMIT_LIMIT = 1024;
const _ownCommits = new Map(); // target → { stamp, value }

const _ownField = (doc, key) => (Object.prototype.propertyIsEnumerable.call(doc, key) ? doc[key] : undefined);

/** The lifecycle value the strict reader would return for JSON.stringify(doc),
 *  or null when that cannot be vouched for without parsing. */
export function lifecycleOfSessionDocument(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.toJSON === 'function') return null;
  const id = _ownField(doc, 'id');
  const closed = _ownField(doc, 'closed');
  const generation = _ownField(doc, 'generation');
  if (id !== undefined && (typeof id !== 'string' || !id)) return null;
  if (closed !== undefined && typeof closed !== 'boolean') return null;
  if (generation !== undefined && (typeof generation !== 'number' || !Number.isFinite(generation))) return null;
  return Object.freeze({ id, closed, generation });
}

/** Stamp of a scratch file right before it is renamed onto the canonical path. */
export function stampSessionScratch(tmp) {
  try {
    return statSessionStamp(tmp);
  } catch {
    return null;
  }
}

function _rememberOwnCommit(target, stamp, value) {
  const entry = Object.freeze({ stamp, value });
  _ownCommits.delete(target);
  _ownCommits.set(target, entry);
  while (_ownCommits.size > OWN_COMMIT_LIMIT) _ownCommits.delete(_ownCommits.keys().next().value);
  return entry;
}

/**
 * Record the rename this realm just performed. A rename keeps inode, size and
 * mtime, so the canonical file must still show the scratch file's identity;
 * anything else means another writer already replaced it and nothing is
 * recorded (the next check reads strictly).
 */
export function recordOwnSessionCommit(target, scratchStamp, lifecycle) {
  _ownCommits.delete(target);
  if (!scratchStamp || !lifecycle) return null;
  let stamp;
  try {
    stamp = statSessionStamp(target);
  } catch {
    return null;
  }
  if (
    stamp.dev !== scratchStamp.dev ||
    stamp.ino !== scratchStamp.ino ||
    stamp.size !== scratchStamp.size ||
    stamp.mtimeNs !== scratchStamp.mtimeNs
  ) {
    return null;
  }
  const entry = _rememberOwnCommit(target, stamp, lifecycle);
  _publishOwnCommit(target, entry);
  return entry;
}

// ── Own commits across realms ────────────────────────────────────────────────
// The save worker and its parent each rename session files the other realm
// checks. A commit announced only in the worker's reply stayed invisible to
// the parent until that reply was processed, so every check in between — the
// pre-admission of the next pipelined save, a load — missed the stamp, dropped
// the record and re-read the whole file. Each commit is therefore also posted
// on a port shared with the peer realm the moment it is recorded, and every
// lookup first absorbs those synchronously (receiveMessageOnPort). A peer
// commit is adopted only while the canonical file still carries exactly its
// stamp: a foreign replacement after the peer's rename never matches.
let _ownCommitPeer = null;

/** Share own commits with the realm on the other end of `port` (null detaches). */
export function connectOwnCommitPeer(port) {
  if (_ownCommitPeer && _ownCommitPeer !== port) {
    // The departing peer's last commits are already queued here: adopt them
    // before the port closes, or the next check re-reads what it wrote.
    _absorbPeerCommits();
    _ownCommitPeer.close();
  }
  _ownCommitPeer = port ?? null;
  // Receipt is synchronous only; the port must never hold the event loop.
  _ownCommitPeer?.unref();
}

function _publishOwnCommit(target, entry) {
  try {
    _ownCommitPeer?.postMessage({ target, entry });
  } catch {
    /* peer gone: its next check reads strictly */
  }
}

function _absorbPeerCommits() {
  if (!_ownCommitPeer) return;
  for (let got = receiveMessageOnPort(_ownCommitPeer); got; got = receiveMessageOnPort(_ownCommitPeer)) {
    _adoptOwnSessionCommit(got.message?.target, got.message?.entry);
  }
}

/** Adopt a commit recorded by the peer realm of this process, only while the
 *  canonical file still carries exactly that stamp. */
function _adoptOwnSessionCommit(target, entry) {
  const value = entry?.value ? lifecycleOfSessionDocument(entry.value) : null;
  if (!value || !entry.stamp) return false;
  let current;
  try {
    current = statSessionStamp(target);
  } catch {
    return false;
  }
  if (!sameSessionStamp(current, entry.stamp)) return false;
  _rememberOwnCommit(target, current, value);
  return true;
}

/** The own-commit verdict for `target` when `stamp` is exactly that commit. */
export function ownCommittedLifecycle(target, stamp) {
  _absorbPeerCommits();
  const entry = _ownCommits.get(target);
  if (!entry) return null;
  if (sameSessionStamp(entry.stamp, stamp)) return entry.value;
  _ownCommits.delete(target);
  return null;
}

/**
 * Lifecycle reads (`lifecycleOnly`) stat first: an own-commit stamp (or, unless
 * `ownCommitsOnly`, a cached settled stamp) returns its verdict without reading;
 * everything else — including every stat failure — reads and strictly parses
 * the CURRENT bytes exactly as before. Only parsed lifecycle fields are cached,
 * never file text. Full lifecycle barriers always receive a fresh, privately
 * owned document.
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
    if (before) {
      const own = ownCommittedLifecycle(target, before);
      if (own) return own;
      const cached = entries.get(target);
      if (!ownCommitsOnly && cached && sameSessionStamp(cached.stamp, before)) {
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
    const record = readTopLevelLifecycleRecord(raw);
    const invalid = isLifecycleUnreadable(record);
    if (!lifecycleOnly) return invalid ? CANONICAL_RECORD_UNREADABLE : record;
    const value = invalid
      ? CANONICAL_RECORD_UNREADABLE
      : Object.freeze({ id: record.id, closed: record.closed, generation: record.generation });
    forget(target);
    // Cached only when the bytes provably came from `before` (unchanged
    // around the read) and that stamp is past the racy window.
    if (before && settledStamp(before, nowNs()) && sameSessionStamp(before, observe(target))) {
      remember(target, before, value);
    }
    return value;
  };
  return Object.assign(read, {
    forget,
    /**
     * A strict parse another reader already made of bytes it proved to
     * belong to `stamp` (stat → read → stat, unchanged): cached exactly as
     * this reader's own lifecycle reads are — settled stamps only, reused
     * only while the full stamp is unchanged. Own-commit-only checks never
     * consult it.
     */
    rememberStrictVerdict(target, stamp, record) {
      if (!stamp || isLifecycleUnreadable(record) || !settledStamp(stamp, nowNs())) return;
      remember(target, stamp, Object.freeze({ id: record.id, closed: record.closed, generation: record.generation }));
    },
    clear() {
      entries.clear();
    },
    // No file text is retained any more; `retainedChars` stays for callers
    // that report it.
    stats: () => ({ entries: entries.size, retainedChars: 0 }),
  });
}

export const readCanonicalSessionRecord = createCanonicalSessionReader();
