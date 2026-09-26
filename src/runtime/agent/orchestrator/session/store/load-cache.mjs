import { statSync, readFileSync } from 'node:fs';
import { getPluginData } from '../../config.mjs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from '../lifecycle-scan.mjs';
import { shareJsonStrings } from '../../../../shared/json-snapshot.mjs';
import {
  sessionStampOf,
  ownCommittedLifecycle,
  readCanonicalSessionRecord,
  acceptStrictSessionRecords,
} from './canonical-reader.mjs';
import { sessionPath } from './paths-heartbeat.mjs';
import { noteMemoryRelease } from '../../../../shared/idle-gc.mjs';

// Recent full-session reads are much hotter than writes while a user hops
// between conversations. Verify the file identity on every access, but reuse
// the parsed object while the atomic file has not changed. When the caller
// already owns a preferred live snapshot, retain only its disk validation
// header, not another full transcript.
const SESSION_LOAD_CACHE_LIMIT = 8;
// Retained documents are also bounded by their source text: eight large
// transcripts pinned ~100 MB of parsed documents under the entry cap alone. A
// document larger than the whole budget keeps only its validation header.
const SESSION_LOAD_CACHE_MAX_CHARS = 8 * 1024 * 1024;
// Validation headers ({ id, generation } under a full file stamp) are tiny and
// are what lets a live/pending copy be served without re-reading a file this
// process did not write yet; they get their own, much larger limit so more
// than eight active sessions do not evict each other's.
const SESSION_LOAD_HEADER_LIMIT = 512;
const _sessionLoadCache = new Map(); // path → { signature, header, session|null, chars }
let _sessionLoadCacheChars = 0;
let _sessionLoadCacheDocs = 0;
let _sessionLoadCacheDataDir = null;

function _dropCached(path) {
  const entry = _sessionLoadCache.get(path);
  if (!entry) return;
  _sessionLoadCacheChars -= entry.chars;
  if (entry.session) _sessionLoadCacheDocs -= 1;
  _sessionLoadCache.delete(path);
}

function _putCached(path, entry) {
  _dropCached(path);
  _sessionLoadCache.set(path, entry);
  _sessionLoadCacheChars += entry.chars;
  if (entry.session) _sessionLoadCacheDocs += 1;
  _trimSessionLoadCache();
}

/** Drop everything cached for `id` (its runtime was closed, unloaded or evicted). */
export function forgetSessionLoadCache(id) {
  if (!id) return;
  _dropCached(sessionPath(id));
  _dropHandoff(sessionPath(id));
  // A whole session just became unreachable: tell the idle collector a
  // large release is waiting (it sweeps once the host is idle again).
  noteMemoryRelease();
}

// A data-dir switch (tests, profile change) invalidates every cached path.
function _syncCacheDataDir() {
  const dataDir = getPluginData();
  if (_sessionLoadCacheDataDir === dataDir) return;
  _sessionLoadCacheDataDir = dataDir;
  _sessionLoadCache.clear();
  _sessionLoadCacheChars = 0;
  _sessionLoadCacheDocs = 0;
  _handoffs.clear();
  _handoffChars = 0;
  _handoffBatch = 0;
}

// ── Pending hand-offs ────────────────────────────────────────────────────────
// A strict parse handed over by another reader (a pane's cold read, the
// pre-load existence check) waits here until the resume it precedes claims
// it. At boot every visible pane is read before the first runtime finishes
// booting, so these could not share the ordinary eight-document budget: the
// 31st hand-off evicted the first long before its resume came. They get their
// own bound and a short life instead — a claimed one becomes an ordinary
// entry, an unclaimed one (a pane nobody resumes) is released after
// HANDOFF_TTL_MS.
const HANDOFF_MAX_DOCS = 64;
const HANDOFF_MAX_CHARS = 64 * 1024 * 1024;
const HANDOFF_TTL_MS = 20_000;
const _handoffs = new Map(); // path → { signature, session, chars, expiresAt }
let _handoffChars = 0;
let _handoffTimer = null;

// Hand-offs taken since the pending list was last empty: a boot restore batch.
let _handoffBatch = 0;

function _dropHandoff(path) {
  const entry = _handoffs.get(path);
  if (!entry) return null;
  _handoffChars -= entry.chars;
  _handoffs.delete(path);
  if (_handoffs.size === 0 && _handoffBatch > 0) {
    // The restore batch is over (every hand-off claimed or expired): its
    // file texts, private projection parses and superseded copies are now
    // garbage. One idle sweep reclaims them instead of leaving the boot peak
    // resident until V8 happens to collect.
    _handoffBatch = 0;
    noteMemoryRelease();
  }
  return entry;
}

function _expireHandoffs() {
  _handoffTimer = null;
  const now = Date.now();
  for (const [path, entry] of _handoffs) if (entry.expiresAt <= now) _dropHandoff(path);
  _scheduleHandoffExpiry();
}

function _scheduleHandoffExpiry() {
  if (_handoffTimer || _handoffs.size === 0) return;
  const next = Math.min(...[..._handoffs.values()].map((entry) => entry.expiresAt));
  _handoffTimer = setTimeout(_expireHandoffs, Math.max(0, next - Date.now()));
  // Releasing memory must never be the reason a process stays up.
  _handoffTimer.unref?.();
}

const _signatureOf = (stamp) => `${stamp.dev}:${stamp.ino}:${stamp.size}:${stamp.mtimeNs}:${stamp.ctimeNs}`;

// A strict parse another reader in this realm made of bytes it proved to come
// from `stamp` (see offerStrictSessionRecord). Held as a pending hand-off under
// that full stamp, only when the record names the session this path belongs
// to and nothing is cached or pending for this exact file yet (an existing
// entry may already be handed out).
function _adoptStrictRecord(path, stamp, record, chars) {
  _syncCacheDataDir();
  if (typeof record?.id !== 'string' || !record.doc || path !== sessionPath(record.id)) return false;
  if (!(chars > 0) || chars > HANDOFF_MAX_CHARS) return false;
  const signature = _signatureOf(stamp);
  if (_sessionLoadCache.get(path)?.signature === signature) return false;
  if (_handoffs.get(path)?.signature === signature) return false;
  _dropHandoff(path);
  const now = Date.now();
  for (const [other, entry] of _handoffs) if (entry.expiresAt <= now) _dropHandoff(other);
  _handoffs.set(path, { signature, session: record.doc, chars, expiresAt: now + HANDOFF_TTL_MS });
  _handoffChars += chars;
  _handoffBatch += 1;
  // Oldest first: the pane read longest ago is the least likely to be resumed next.
  for (const oldest of _handoffs.keys()) {
    if (_handoffs.size <= HANDOFF_MAX_DOCS && _handoffChars <= HANDOFF_MAX_CHARS) break;
    _dropHandoff(oldest);
  }
  _scheduleHandoffExpiry();
  return true;
}
acceptStrictSessionRecords(_adoptStrictRecord);

/** Test/diagnostic seam: entries, retained documents and their source characters. */
export function sessionLoadCacheStats() {
  return {
    entries: _sessionLoadCache.size,
    documents: _sessionLoadCacheDocs,
    chars: _sessionLoadCacheChars,
    pendingHandoffs: _handoffs.size,
    pendingHandoffChars: _handoffChars,
  };
}

// A session file is only ever replaced atomically (write tmp → rename over
// the canonical path). A reader that stats one inode and then reads "the
// path" can therefore straddle a replacement: the stat describes the old
// file while the read returns the new bytes, or the old inode is already
// gone (ENOENT) even though a perfectly valid replacement exists — which the
// naive version reported as {exists:true, session:null} / {exists:false},
// i.e. loadSession()/getSession() returning null for a live session. Every
// observation below is therefore a STABLE SNAPSHOT: stat → read → stat, and
// the result is only trusted (and only cached) when the identity signature is
// unchanged around the read. An unstable observation is retried a bounded
// number of times, so the replacement window closes and we still fail closed
// on genuine corruption instead of spinning.
const SESSION_LOAD_STABLE_ATTEMPTS = 5;

// Deterministic fault injection point (tests only): invoked immediately
// before every stat and every read with { phase, path, attempt }. The hook
// may mutate the file system (simulating an atomic rename landing between
// the two syscalls) or return an Error to make that syscall fail.
//
// STRUCTURAL GATE: the seam is inert unless the process was started in
// explicit fault-injection test mode. Installing a hook without the gate is
// a no-op (returns false), and an already-installed hook is dropped the
// moment the gate stops being set, so a production build can never activate
// it accidentally — not via a stray import, not via a leaked reference.
const SESSION_LOAD_FAULT_ENV = 'MIXDOG_SESSION_LOAD_FAULT_HOOKS';
let _sessionLoadFaultHook = null;

function _faultHooksEnabled() {
  return process.env[SESSION_LOAD_FAULT_ENV] === '1';
}

function _fault(phase, path, attempt) {
  if (!_sessionLoadFaultHook) return;
  if (!_faultHooksEnabled()) {
    _sessionLoadFaultHook = null; // gate revoked after install: stay inert
    return;
  }
  const injected = _sessionLoadFaultHook({ phase, path, attempt });
  if (injected instanceof Error) throw injected;
}

// Only these mean "nothing is at this path right now". Everything else
// (EACCES, EPERM, EIO, EBUSY, EMFILE, ELOOP, unknown) means a file is very
// likely THERE and we simply cannot look at it: that must never be reported
// as absence, because absence lets loadSession() fall back to in-memory
// state and thereby mask an unreadable file that owns the identity.
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

// Observation states: 'present' (signature valid), 'absent' (ENOENT-class),
// 'unreadable' (persistent/transient failure — fail closed).
function _observe(path, attempt) {
  try {
    _fault('stat', path, attempt);
    const info = statSync(path, { bigint: true });
    return {
      state: 'present',
      // The full stamp: a rename brings a new inode and change time, and an
      // in-place rewrite moves the change time even when mtime is restored.
      signature: _signatureOf(info),
      stamp: sessionStampOf(info),
      code: null,
    };
  } catch (err) {
    const code = err?.code || 'EUNKNOWN';
    if (ABSENT_CODES.has(code)) return { state: 'absent', signature: null, stamp: null, code };
    return { state: 'unreadable', signature: null, stamp: null, code };
  }
}

// A decision is always derived from ONE observation that was actually made —
// never from a second, independent existence probe (the old
// `stat → null → existsSync(path)` pair was a TOCTOU window that could turn a
// live file into {exists:false}).
function _decide(observation) {
  if (observation.state === 'absent') return { exists: false, session: null };
  return { exists: true, session: null };
}

// Content is only this session's when it parses UNAMBIGUOUSLY and claims this
// id. readTopLevelLifecycleRecord is the strict parse (no separate JSON.parse
// authority to diverge from): a duplicate top-level `id` is last-wins under
// JSON.parse, which would hand the runtime a foreign/ambiguous transcript to
// serve, re-save and tombstone from. Ambiguity reads as corruption here —
// `null` keeps the file owning the identity and fails closed.
function _ownedRecord(id, text) {
  const record = readTopLevelLifecycleRecord(text);
  if (isLifecycleUnreadable(record)) return null;
  return record.id === id ? record : null;
}

function _ownedSession(id, text) {
  return _ownedRecord(id, text)?.doc ?? null;
}

// `entry` is a cached (in-map) entry.
function _selectCachedSession(entry, preferInMemory) {
  const preferred = preferInMemory?.(entry.header);
  if (preferred) {
    _releaseDocument(entry);
    return preferred;
  }
  // A document released for budget while something else (a live runtime)
  // still holds it is still the parse of exactly this file: the stamp is
  // unchanged, so hand out that same object again instead of re-reading.
  return entry.session ?? entry.released?.deref() ?? null;
}

function _cacheStable(path, signature, session, preferInMemory, chars) {
  const header = { id: session.id, generation: typeof session.generation === 'number' ? session.generation : 0 };
  const preferred = preferInMemory?.(header);
  const retained = !preferred && chars <= SESSION_LOAD_CACHE_MAX_CHARS ? session : null;
  if (Array.isArray(retained?.messages)) shareJsonStrings(retained.messages);
  _putCached(path, { signature, header, session: retained, chars: retained ? chars : 0 });
  return preferred || session;
}

function _trimSessionLoadCache() {
  // Over the document or byte budget, the oldest documents are released
  // first; their validation headers stay (a live/pending copy is then still
  // served without re-reading the file).
  for (const entry of _sessionLoadCache.values()) {
    if (
      _sessionLoadCacheDocs <= SESSION_LOAD_CACHE_LIMIT &&
      _sessionLoadCacheChars <= SESSION_LOAD_CACHE_MAX_CHARS
    ) {
      break;
    }
    _releaseDocument(entry);
  }
  for (const [path, entry] of _sessionLoadCache) {
    if (_sessionLoadCache.size - _sessionLoadCacheDocs <= SESSION_LOAD_HEADER_LIMIT) break;
    if (!entry.session) _dropCached(path);
  }
}

// Keep only the validation header of a cached (in-map) entry, plus a WEAK
// reference to the released document: never a reason to keep a transcript
// resident, but while its owner (the runtime that loaded it) still holds it,
// the next load of the unchanged file gets it back without a whole-file read.
// forgetSessionLoadCache (close, unload, eviction) drops the entry and the
// reference with it.
function _releaseDocument(entry) {
  if (!entry.session) return;
  _sessionLoadCacheChars -= entry.chars;
  _sessionLoadCacheDocs -= 1;
  entry.released = new WeakRef(entry.session);
  entry.chars = 0;
  entry.session = null;
}

// The inode we stat'ed vanished under the read on the LAST attempt: no retry
// is left, but a replacement may already own the path. Take ONE decisive
// snapshot (observe, then read what is actually there) instead of classifying
// from the observation alone — reporting {exists:true, session:null} for a
// perfectly readable replacement is the same false corruption the retry loop
// exists to avoid. Uncached: no identity was verified around this read.
function _decisiveReplacementSnapshot(id, path, attempt) {
  const observed = _observe(path, attempt);
  if (observed.state === 'absent') return { exists: false, session: null };
  if (observed.state !== 'present') return { exists: true, session: null };
  let text = null;
  try {
    _fault('read', path, attempt);
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    const code = err?.code || 'EUNKNOWN';
    return ABSENT_CODES.has(code) ? { exists: false, session: null } : { exists: true, session: null };
  }
  return { exists: true, session: _ownedSession(id, text) };
}

export function _readStoredSessionCached(id, path, { preferInMemory = null } = {}) {
  _syncCacheDataDir();
  let last = { state: 'absent', signature: null, code: 'ENOENT' };
  for (let attempt = 0; attempt < SESSION_LOAD_STABLE_ATTEMPTS; attempt++) {
    // The final attempt must DECIDE — it may not defer to yet another
    // observation, so a replacement landing on that last boundary is
    // parsed (if its bytes are readable and ours) or reported as
    // present-but-invalid, never as absence.
    const isFinal = attempt === SESSION_LOAD_STABLE_ATTEMPTS - 1;
    const before = _observe(path, attempt);
    last = before;
    if (before.state !== 'present') {
      // Absent: possibly the unlink → rename hole, retry.
      // Unreadable: EACCES/EIO/EBUSY — retry in case it is transient,
      // but this observation already means "present, fail closed".
      _dropCached(path);
      continue;
    }
    const cached = _sessionLoadCache.get(path);
    if (cached?.signature === before.signature) {
      // The cached object was stored under a verified-stable signature,
      // and dev/ino/size/mtimeNs/ctimeNs still describe that same file.
      const selected = _selectCachedSession(cached, preferInMemory);
      if (selected) {
        _sessionLoadCache.delete(path);
        _sessionLoadCache.set(path, cached);
        return { exists: true, session: selected };
      }
      // The live owner went away or disk now outranks it. A validation header
      // is not a transcript: re-read the complete record before returning it.
    }
    // A strict parse another reader handed over for exactly this file: claim
    // it instead of reading. Any other stamp (changed, replaced by another
    // writer) drops it and reads strictly below.
    const handoff = _dropHandoff(path);
    if (handoff && handoff.signature === before.signature) {
      return { exists: true, session: _cacheStable(path, before.signature, handoff.session, preferInMemory, handoff.chars) };
    }
    // This realm's OWN last commit is still on disk: its bytes are our strict,
    // valid serialization, so its header validates without re-reading. When
    // the live/pending copy is served, no second transcript is read, parsed
    // or retained.
    const own = ownCommittedLifecycle(path, before.stamp);
    if (own && own.id === id) {
      const header = { id, generation: typeof own.generation === 'number' ? own.generation : 0 };
      const preferred = preferInMemory?.(header);
      if (preferred) {
        _putCached(path, { signature: before.signature, header, session: null, chars: 0 });
        return { exists: true, session: preferred };
      }
    }
    let text = null;
    let readCode = null;
    try {
      _fault('read', path, attempt);
      text = readFileSync(path, 'utf-8');
    } catch (err) {
      readCode = err?.code || 'EUNKNOWN';
    }
    if (readCode !== null) {
      _dropCached(path);
      if (!ABSENT_CODES.has(readCode)) {
        // EACCES/EIO/EBUSY on the read: the file is there and we
        // cannot have it. Fail closed, now or after the retries.
        last = { state: 'unreadable', signature: null, code: readCode };
        if (isFinal) return { exists: true, session: null };
        continue;
      }
      // The inode we stat'ed vanished under us: replacement window, not
      // corruption. Retry and let the new file answer.
      last = { state: 'absent', signature: null, code: readCode };
      // On the last boundary there is no retry left: read the
      // replacement rather than classify it from a bare stat.
      if (isFinal) return _decisiveReplacementSnapshot(id, path, attempt);
      continue;
    }
    const after = _observe(path, attempt);
    if (after.state !== 'present' || after.signature !== before.signature) {
      // A rename landed around the read — these bytes may belong to a
      // different inode than `before`, so they must never be cached
      // under it.
      _dropCached(path);
      last = after;
      if (!isFinal) continue;
      // Last boundary: the bytes still came from a real file at this
      // path. If they are a valid session for this id, answer with them
      // (uncached, since no identity was verified) rather than invent an
      // absence/null for a perfectly readable replacement; otherwise
      // stay conservatively present-but-invalid.
      return { exists: true, session: _ownedSession(id, text) };
    }
    // Stable snapshot: `text` provably belongs to the file identified by
    // `before`. Whatever it says is now authoritative, including "this is
    // not valid session JSON" / "this is a foreign id" — fail closed.
    const record = _ownedRecord(id, text);
    if (record === null) {
      _dropCached(path);
      return { exists: true, session: null };
    }
    // The same strict verdict the write-authority check would reach for
    // these exact bytes: handed to the canonical reader under the full
    // stamp, which reuses it only while that stamp is unchanged and settled.
    readCanonicalSessionRecord.rememberStrictVerdict(path, before.stamp, record);
    return { exists: true, session: _cacheStable(path, before.signature, record.doc, preferInMemory, text.length) };
  }
  // Bounded retries exhausted. `last` is the most recent observation we
  // actually made, so the answer needs no further syscall: ENOENT-class ⇒
  // genuinely absent, anything else ⇒ present-but-unreadable, which keeps
  // owning the identity and fails closed like real external corruption.
  _dropCached(path);
  return _decide(last);
}
