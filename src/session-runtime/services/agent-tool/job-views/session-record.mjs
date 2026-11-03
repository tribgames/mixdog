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
import fsp from 'node:fs/promises';

import {
  inMemorySessionCopy,
  resolveSessionCopy,
  sessionMemoryCopies,
} from '../../../../runtime/agent/orchestrator/session/store/load-session.mjs';
import { sessionRecordPath } from '../../../../runtime/agent/orchestrator/session/store/session-paths.mjs';
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

/** One read of `id`'s record at `path`, as resolveSessionCopy takes it. A
 *  failed read (not an absent file) rejects: the cache keeps what it had,
 *  and the next watch event reads again. */
async function readRecord(id, path) {
  let bytes;
  try {
    bytes = await fsp.readFile(path);
  } catch (error) {
    if (ABSENT_CODES.has(error?.code)) return { value: ABSENT };
    throw error;
  }
  if (holdsNoData(bytes)) return { value: ABSENT };
  // The store's strict verdict (load-cache.mjs _ownedRecord): only an
  // unambiguous document claiming this id is the session's record.
  const parsed = readStrictRecordFields(bytes, RECORD_VIEW_READ);
  if (isLifecycleUnreadable(parsed) || parsed.id !== id) return { value: UNREADABLE };
  return { value: { exists: true, session: recordView(parsed.doc) } };
}

function recordPathOf(id) {
  try {
    return sessionRecordPath(id);
  } catch {
    return null;
  }
}

function createSessionRecords() {
  // sessionId -> { path, live (the copy this process holds, else null), holders }
  const entries = new Map();
  const idsByPath = new Map();
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
    if (reading >= RECORD_RELOADS_AT_ONCE) await new Promise((resolve) => waiting.push(resolve));
    reading += 1;
    try {
      const id = idsByPath.get(path);
      if (!id) return { value: ABSENT };
      return await readRecord(id, path);
    } finally {
      reading -= 1;
      waiting.shift()?.();
    }
  }

  const cache = createWatchedFileCache(
    {
      load() {
        throw new Error('session records are only read asynchronously');
      },
      loadAsync: readLimited,
    },
    {
      onChange(path) {
        // A record no longer needed tells nobody.
        if (!entries.has(idsByPath.get(path)) || closed) return;
        emit();
      },
    }
  );

  function forget(id, entry) {
    entries.delete(id);
    if (!entry.path) return;
    idsByPath.delete(entry.path);
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
        const path = recordPathOf(id);
        entry = { path, last: null, holders: new Set() };
        entries.set(id, entry);
        if (path) idsByPath.set(path, id);
        // The cache reads it off the pulse once its folder is watched.
        if (path) cache.set(path, UNLOADED);
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
