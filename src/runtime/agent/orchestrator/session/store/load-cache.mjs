/**
 * Recent whole-session reads, through the legacy seam (resolveSessionRecord):
 * the log, or the legacy `<id>.json` of a session that has no log yet. A read
 * is reused while the record's stamp (both files' inode, size, mtime and
 * ctime) is unchanged; a log only grows within one file and a rewrite is a new
 * file, and this build never writes a json in place, so any change to what
 * the read returns changes the stamp. When the caller already owns a
 * preferred live snapshot, only the record's header ({ id, generation }) is
 * retained, not a second transcript. Retained documents are bounded by count
 * and by their record's bytes on disk.
 */
import { getPluginData } from '../../config.mjs';
import { shareJsonStrings } from '../../../../shared/json-snapshot.mjs';
import { noteMemoryRelease } from '../../../../shared/idle-gc.mjs';
import { parseSessionRecordStamp, resolveSessionRecordSync, sessionRecordStampSync } from './session-log-reader.mjs';
import { sessionLogRecordPath, sessionRecordPath } from './session-paths.mjs';
import { loadLegacySession } from './legacy-session.mjs';
import { bindLoadedSession } from './session-writers.mjs';
import { ABSENT_RECORD_STAMP } from './session-record.mjs';

// Retained transcripts are bounded by count; headers are tiny and get their
// own, much larger bound so more than eight active sessions do not evict each
// other's.
const SESSION_LOAD_CACHE_LIMIT = 8;
// Bytes of the retained documents' records on disk; a document larger than
// the whole budget keeps only its validation header.
const SESSION_LOAD_CACHE_MAX_CHARS = 8 * 1024 * 1024;
const SESSION_LOAD_HEADER_LIMIT = 512;
const _cache = new Map(); // id → { stamp, header, session|null, chars, released: WeakRef|null }
let _documents = 0;
let _chars = 0;
let _cacheDataDir = null;

function _drop(id) {
  const entry = _cache.get(id);
  if (!entry) return;
  _release(entry);
  _cache.delete(id);
}

function _release(entry) {
  if (!entry.session) return;
  _documents -= 1;
  _chars -= entry.chars;
  entry.released = new WeakRef(entry.session);
  entry.session = null;
  entry.chars = 0;
}

function _put(id, entry) {
  _drop(id);
  if (entry.session && entry.chars > SESSION_LOAD_CACHE_MAX_CHARS) {
    entry.released = new WeakRef(entry.session);
    entry.session = null;
    entry.chars = 0;
  }
  _cache.set(id, entry);
  if (entry.session) {
    _documents += 1;
    _chars += entry.chars;
  }
  for (const old of _cache.values()) {
    if (_documents <= SESSION_LOAD_CACHE_LIMIT && _chars <= SESSION_LOAD_CACHE_MAX_CHARS) break;
    if (old !== entry) _release(old);
  }
  for (const [key, old] of _cache) {
    if (_cache.size - _documents <= SESSION_LOAD_HEADER_LIMIT) break;
    if (!old.session) _drop(key);
  }
}

/** Drop everything cached for `id` (its runtime was closed, unloaded or evicted). */
export function forgetSessionLoadCache(id) {
  if (!id) return;
  _drop(id);
  // A whole session just became unreachable: tell the idle collector a
  // large release is waiting (it sweeps once the host is idle again).
  noteMemoryRelease();
}

// A data-dir switch (tests, profile change) invalidates every cached record.
function _syncCacheDataDir() {
  const dataDir = getPluginData();
  if (_cacheDataDir === dataDir) return;
  _cacheDataDir = dataDir;
  _cache.clear();
  _documents = 0;
  _chars = 0;
}

/** Test/diagnostic seam: entries, retained documents and their record bytes. */
export function sessionLoadCacheStats() {
  return { entries: _cache.size, documents: _documents, chars: _chars };
}

// Bytes on disk of the file a stamp's record is read from (the log, else the json).
function recordBytes(stamp) {
  const { log, json } = parseSessionRecordStamp(stamp);
  return Number((log ?? json)?.size ?? 0n);
}

const headerOf = (session) => ({
  id: session.id,
  generation: typeof session.generation === 'number' ? session.generation : 0,
});

function _filesOf(id) {
  return { jsonPath: sessionRecordPath(id), logPath: sessionLogRecordPath(id) };
}

/**
 * `{ exists, session }` for `id`: `exists` false only when neither file is
 * there; `session` null for a record that is there and holds no session of
 * this id (unreadable, an invalid log, a foreign or corrupt json).
 * `preferInMemory(header)` returns the in-memory copy that outranks the
 * record, if any.
 */
export function _readStoredSessionCached(id, { preferInMemory = null } = {}) {
  _syncCacheDataDir();
  const files = _filesOf(id);
  let stamp;
  try {
    stamp = sessionRecordStampSync(files);
  } catch {
    _drop(id);
    return { exists: true, session: null };
  }
  if (stamp === ABSENT_RECORD_STAMP) {
    _drop(id);
    return { exists: false, session: null };
  }
  const cached = _cache.get(id);
  if (cached?.stamp === stamp) {
    const preferred = preferInMemory?.(cached.header);
    if (preferred) {
      _release(cached);
      return { exists: true, session: preferred };
    }
    const doc = cached.session ?? cached.released?.deref() ?? null;
    if (doc) return { exists: true, session: doc };
  }
  let outcome;
  try {
    outcome = resolveSessionRecordSync({ ...files, loadLegacy: loadLegacySession, stamp });
  } catch {
    _drop(id);
    return { exists: true, session: null };
  }
  if (outcome.kind === 'absent') {
    _drop(id);
    return { exists: false, session: null };
  }
  const session = outcome.session?.id === id ? outcome.session : null;
  if (!session) {
    _drop(id);
    return { exists: true, session: null };
  }
  bindLoadedSession(session, outcome);
  if (Array.isArray(session.messages)) shareJsonStrings(session.messages);
  const header = headerOf(session);
  const preferred = preferInMemory?.(header);
  // Cached only for bytes provably read under `stamp` (unchanged around the read).
  let after = null;
  try {
    after = sessionRecordStampSync(files);
  } catch {
    after = null;
  }
  if (after === stamp) {
    const retained = preferred ? null : session;
    _put(id, { stamp, header, session: retained, chars: retained ? recordBytes(stamp) : 0, released: null });
  } else {
    _drop(id);
  }
  return { exists: true, session: preferred || session };
}
