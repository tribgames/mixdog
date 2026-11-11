// job-views/session-record.mjs
// The status pulse's answer to getSession(id) without touching a file.
//
// A manager with `loadSessionStatus` (the session store's stamp-validated
// record read) keeps sessions in files. Every session is answered with
// loadSession's own precedence (resolveSessionCopy, load-session.mjs) between
// this process's in-memory copies and its record: a live copy yields to a
// record of a higher generation, an unreadable record owns the id. That holds
// for a session this process holds live too: nothing stops another process
// over the same data dir (a `mixdog --plain` REPL beside the daemon) from
// taking the same session — no per-session lock exists across processes —
// so its record is watched like any other.
//
// The record metadata is kept in memory by a watched-file cache
// (watched-file-cache.mjs) and maintained off the pulse: read asynchronously
// when first asked for (this process's copy answering until then, else
// unknown, as a missing session reads) and again on every watch event for
// its file, whoever wrote it, at most RECORD_RELOADS_AT_ONCE at a time,
// never on the pulse. A sessions
// folder not created yet is watched through its nearest existing ancestor,
// and its records are read when it appears. A read validates the whole
// document but decodes only what recordView keeps (RECORD_VIEW_READ). A
// record whose view changed tells the holders (`onChange`) so their surfaces
// republish.
//
// A manager without `loadSessionStatus` answers getSession from memory and is
// asked directly.
import {
  inMemorySessionCopy,
  resolveSessionCopy,
  sessionMemoryCopies,
} from '../../../../runtime/agent/orchestrator/session/store/load-session.mjs';
import {
  sessionRecordPath,
  sessionScanCheckpointDir,
} from '../../../../runtime/agent/orchestrator/session/store/session-paths.mjs';
import {
  isLogRecord,
  recordSession,
  sessionRecordFilesOf,
} from '../../../../runtime/agent/orchestrator/session/store/session-record.mjs';
import { resolveSessionRecord } from '../../../../runtime/agent/orchestrator/session/store/session-log-reader.mjs';
import { isLifecycleUnreadable } from '../../../../runtime/agent/orchestrator/session/lifecycle-scan.mjs';
import { readStrictRecordFields } from '../../../../runtime/agent/orchestrator/session/store-record-strict-scan.mjs';
import { holdsNoData } from '../../../../runtime/shared/atomic-file.mjs';
import { createWatchedFileCache } from '../../../../runtime/shared/watched-file-cache.mjs';

export const RECORD_RELOADS_AT_ONCE = 2;

const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);
const ABSENT = Object.freeze({ exists: false, session: null });
const UNREADABLE = Object.freeze({ exists: true, session: null });
// A record asked for and not read yet.
const UNLOADED = Object.freeze({ unloaded: true });

// What a record read decodes (store-record-strict-scan.mjs): every message
// only as `{ role }` (recordView counts them) and none of the catalogs and
// contexts below (recordView drops object fields). The rest of the document
// is validated, never decoded.
const RECORD_VIEW_READ = {
  skip: new Set([
    'deferredToolCatalog',
    'deferredLateToolCatalog',
    'bp3CoreContext',
    'bp3EnvironmentContext',
    'compaction',
    'pendingDeferredToolDelta',
  ]),
};

const isFileBacked = (mgr) => typeof mgr?.loadSessionStatus === 'function';

/** What the agent views read off a session, without its transcript: scalar
 *  fields, route parameters, and message/tool counts in place of the arrays. */
function recordView(session) {
  if (!session || typeof session !== 'object') return null;
  const view = {};
  for (const [key, value] of Object.entries(session)) {
    if (key === 'messages' || key === 'tools') continue;
    if (value === null || typeof value !== 'object') view[key] = value;
    else if (key === 'modelParameters') view[key] = { ...value };
  }
  if (Array.isArray(session.messages)) view.messageCount = session.messages.length;
  if (Array.isArray(session.tools)) view.toolCount = session.tools.length;
  return view;
}

// A legacy json holding no data (a crash before its bytes landed) reads as no record.
const NO_DATA = Object.freeze({});

// The legacy json's view document under the store's strict verdict
// (load-cache.mjs _ownedRecord): only an unambiguous document claiming this
// id is the session's record.
function loadLegacyView(text, id) {
  if (holdsNoData(text)) return NO_DATA;
  const parsed = readStrictRecordFields(Buffer.from(text, 'utf8'), RECORD_VIEW_READ);
  return isLifecycleUnreadable(parsed) || parsed.id !== id ? null : parsed.doc;
}

/** One read of `id`'s record (`files`: its log and legacy json), through the
 *  record seam's header scan, as resolveSessionCopy takes it. A failed read
 *  (not an absent file) rejects: the cache keeps what it had, and the next
 *  watch event reads again. */
async function readRecord(id, files) {
  let outcome;
  try {
    outcome = await resolveSessionRecord({
      ...files,
      loadLegacy: loadLegacyView,
      messages: false,
      // The first scan of a log in this process goes on from where the last
      // process left off instead of reading all of it.
      checkpoints: sessionScanCheckpointDir(),
    });
  } catch (error) {
    if (ABSENT_CODES.has(error?.code)) return { value: ABSENT };
    throw error;
  }
  if (outcome.kind === 'absent') return { value: ABSENT };
  const session = recordSession(outcome, id);
  if (session === NO_DATA) return { value: ABSENT };
  if (!session) return { value: UNREADABLE };
  const view = recordView(session);
  if (isLogRecord(outcome)) view.messageCount = outcome.log.messageCount;
  return { value: { exists: true, session: view } };
}

function recordFilesOf(id) {
  try {
    return sessionRecordFilesOf(sessionRecordPath(id));
  } catch {
    return null;
  }
}

// A session's record is cached at its log (`path`). Its legacy json is
// watched too — a json an older build writes beside the log, or the only
// file of a session never migrated, decides the record — under an entry that
// holds no value of its own: only its watch event re-reads the record's
// entry. It is attached by a (file-free) load, never `set`: a set's read-back
// would re-read the record with no event.
const JSON_WATCH = Object.freeze({ jsonWatch: true });

function createSessionRecords() {
  // sessionId -> { path (its log), files, last, holders }
  const entries = new Map();
  const idsByPath = new Map();
  const logPathByJsonPath = new Map();
  const listeners = new Set();
  let closed = false;

  function emit() {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* observers never affect the cache */
      }
    }
  }

  // Reads in flight, and those waiting for a slot.
  let reading = 0;
  const waiting = [];
  async function readLimited(path) {
    const logPath = logPathByJsonPath.get(path);
    if (logPath) {
      // Write-through of what the record's entry holds: it is read back.
      cache.set(logPath, cache.peek(logPath) ?? UNLOADED);
      return { value: JSON_WATCH };
    }
    if (reading >= RECORD_RELOADS_AT_ONCE) await new Promise((resolve) => waiting.push(resolve));
    reading += 1;
    try {
      const entry = entries.get(idsByPath.get(path));
      if (!entry) return { value: ABSENT };
      return await readRecord(idsByPath.get(path), entry.files);
    } finally {
      reading -= 1;
      waiting.shift()?.();
    }
  }

  const cache = createWatchedFileCache(
    {
      load(path) {
        if (logPathByJsonPath.has(path)) return { value: JSON_WATCH };
        throw new Error('session records are only read asynchronously');
      },
      loadAsync: readLimited,
    },
    {
      onChange(path) {
        // A record no longer needed tells nobody; a json watch holds no record.
        if (logPathByJsonPath.has(path) || !entries.has(idsByPath.get(path)) || closed) return;
        emit();
      },
    }
  );

  function forget(id, entry) {
    entries.delete(id);
    if (!entry.path) return;
    idsByPath.delete(entry.path);
    logPathByJsonPath.delete(entry.files.jsonPath);
    cache.delete(entry.files.jsonPath);
    cache.delete(entry.path);
  }

  return {
    listeners,
    /** getSession's answer for `id` from memory, for `holder`; never reads a file. */
    session(id, holder) {
      if (closed) return null;
      const memory = sessionMemoryCopies(id);
      let entry = entries.get(id);
      if (!entry) {
        const files = recordFilesOf(id);
        const path = files?.logPath ?? null;
        entry = { path, files, last: null, holders: new Set() };
        entries.set(id, entry);
        if (path) {
          idsByPath.set(path, id);
          logPathByJsonPath.set(files.jsonPath, path);
          // The cache reads it off the pulse once its folder is watched.
          cache.set(path, UNLOADED);
          cache.get(files.jsonPath);
        }
      }
      entry.holders.add(holder);
      const record = entry.path ? cache.peek(entry.path) : ABSENT;
      if (record === undefined || record === UNLOADED) {
        // Not read yet: this process's copy stands meanwhile (the last one
        // it held, once released), else unknown, as a missing session reads.
        entry.last = inMemorySessionCopy(id, memory, null) ?? entry.last;
        return entry.last;
      }
      entry.last = null;
      return resolveSessionCopy(id, memory, record).session;
    },
    /** `holder` now needs exactly the records `keep` names: a record no holder
     *  needs is forgotten, and its watch goes with it. */
    retain(holder, keep) {
      for (const [id, entry] of entries) {
        if (keep.has(id) || !entry.holders.delete(holder) || entry.holders.size > 0) continue;
        forget(id, entry);
      }
    },
    close() {
      closed = true;
      cache.close();
      entries.clear();
      idsByPath.clear();
      listeners.clear();
      for (const resolve of waiting.splice(0)) resolve();
    },
    refs: 0,
  };
}

// mgr -> its records, shared by every holder (acquireSessionRecords).
const shared = new Map();

/**
 * A holder's handle on `mgr`'s session records: `session(id)` (getSession's
 * answer from memory), `retainRead(run)` (after `run()`, the holder needs
 * exactly the records it read), `onChange(listener)` (a record changed) and
 * `release()`; a record lives while a holder needs it, and the records, their
 * reads and their folder watch end with the last holder.
 */
export function acquireSessionRecords(mgr) {
  if (!isFileBacked(mgr)) {
    return {
      session: (id) => (id && mgr?.getSession?.(id)) || null,
      retainRead: (run) => run(),
      onChange: () => () => {},
      release() {},
    };
  }
  let records = shared.get(mgr);
  if (!records) {
    records = createSessionRecords();
    shared.set(mgr, records);
  }
  records.refs += 1;
  const own = new Set();
  const holder = {};
  let read = null; // ids read during retainRead
  let released = false;
  return {
    session(id) {
      if (!id || released) return null;
      read?.add(id);
      return records.session(id, holder);
    },
    retainRead(run) {
      const outer = read;
      read = new Set();
      try {
        return run();
      } finally {
        const keep = read;
        read = outer;
        if (!released) records.retain(holder, keep);
      }
    },
    onChange(listener) {
      if (released || typeof listener !== 'function') return () => {};
      records.listeners.add(listener);
      own.add(listener);
      return () => {
        records.listeners.delete(listener);
        own.delete(listener);
      };
    },
    release() {
      if (released) return;
      released = true;
      for (const listener of own) records.listeners.delete(listener);
      records.retain(holder, new Set());
      records.refs -= 1;
      if (records.refs > 0 || shared.get(mgr) !== records) return;
      shared.delete(mgr);
      records.close();
    },
  };
}
