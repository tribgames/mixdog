// Session listing and summary projection (the stale-session sweep is
// sweep/stale-sweep.mjs); store.mjs owns the persistence half
// (save/load/close/delete). Both read the in-flight save maps so an
// unpersisted session still shows up in listings.
import { readFileSync, readdirSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { getPluginData } from '../../config.mjs';
import { getStoreDir } from './session-paths.mjs';
import { probePath, PROBE_PRESENT, PROBE_ABSENT } from './fs-probe.mjs';
import { isCancelledWrite as _isCancelledWrite } from './write-guards.mjs';
import {
  SESSION_SUMMARY_INDEX_VERSION,
  summaryIndexPath,
  _sessionSummary,
  _normalizeSummaryIndex,
  _writeSummaryIndex,
  _hasUnsettledSummaryOps,
  settleSummaryIndexWrites,
} from '../store-summary-index.mjs';
import { applySummaryLogText, readSummaryLogText, summaryIndexStampMs } from '../store-summary-log.mjs';
import {
  _ensureSummaryCacheDataDir,
  _cachedSummaryRows,
  _setSummaryRowsCache,
  _scanStoredSessionSummaryRows,
  _summaryCacheRemovals,
  _summaryRowsCache,
} from './summary-cache.mjs';
import { _saveAsyncQueued, _saveWorkerPending } from './save-worker.mjs';
import { STORED_SESSION_UNREADABLE, _ensureLifecycleFields, _storedSessionFromFile } from './serialize.mjs';
import { _savePending } from './pending-saves.mjs';
import { closeSessionCatalogDb } from '../catalog-db/index.mjs';

// Disk mtime of the summary index when the in-memory cache was last refreshed
// from it — the cross-process staleness detector.
let _summaryIndexMtimeSeen = 0;
let _summaryRebuildWorker = null;
let _summaryRebuildDataDir = '';

export function listStoredSessions(options = {}) {
  const dir = getStoreDir();
  // Only ENOENT/ENOTDIR is absence. An unreadable directory (EACCES/EIO) is
  // NOT "no sessions": listing yields nothing, but nothing may be treated as
  // deleted/absent on that basis either.
  if (probePath(dir).state !== PROBE_PRESENT) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const sessionsById = new Map();
  const invalidStorageIds = options._invalidStorageIds instanceof Set ? options._invalidStorageIds : new Set();
  for (const f of files) {
    const session = _storedSessionFromFile(dir, f);
    if (session && session !== STORED_SESSION_UNREADABLE) {
      sessionsById.set(session.id, session);
      continue;
    }
    // Present-but-unreadable owns its identity too: it may never be
    // replaced by a live/pending overlay, so it is marked invalid.
    const storageId = f.slice(0, -5);
    if (/^[A-Za-z0-9_-]+$/.test(storageId)) invalidStorageIds.add(storageId);
  }
  const stored = [...sessionsById.values()];
  const listed =
    options.includeLive === true
      ? _withUnpersistedSessions(stored, invalidStorageIds)
      : stored.sort((a, b) => b.updatedAt - a.updatedAt);
  return listed;
}

function _withUnpersistedSessions(stored, invalidStorageIds = new Set()) {
  const sessionsById = new Map(stored.map((session) => [session.id, session]));
  const addIfUnpersisted = (id, session, opts) => {
    // A valid on-disk record is authoritative for refresh/resume. In
    // particular, a long-lived runtime object must never replace a
    // tombstone or changed desktop authorization metadata. Only active
    // local writes with no disk record get read-your-writes visibility.
    if (sessionsById.has(id) || invalidStorageIds.has(id) || _isCancelledWrite(opts)) return;
    if (session?.id === id) sessionsById.set(id, _ensureLifecycleFields(session));
  };
  _forEachUnpersistedWrite(addIfUnpersisted);
  return [...sessionsById.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// Every save that may not be on disk yet: debounced (queued or in-flight
// payload), the worker's in-flight writes and its latest-wins queue.
function _forEachUnpersistedWrite(visit) {
  for (const [id, pending] of _savePending) {
    const payload = pending.queued || pending.payload;
    visit(id, payload?.session, payload?.opts);
  }
  for (const [, pending] of _saveWorkerPending) visit(pending.id, pending.session, pending.opts);
  for (const [id, pending] of _saveAsyncQueued) visit(id, pending.session, pending.opts);
}

// Summary-level twin of _withUnpersistedSessions: overlay queued/in-flight
// saves that have no disk record yet (read-your-writes for brand-new sessions).
function _overlayUnpersistedSummaryRows(rows, invalidStorageIds = new Set()) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const addIfUnpersisted = (id, session, opts) => {
    if (!id || byId.has(id) || invalidStorageIds.has(id) || _isCancelledWrite(opts)) return;
    if (session?.id !== id) return;
    const row = _sessionSummary(_ensureLifecycleFields(session));
    if (row) byId.set(id, row);
  };
  _forEachUnpersistedWrite(addIfUnpersisted);
  return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function scheduleSessionSummaryIndexRebuild() {
  const dataDir = getPluginData();
  if (_summaryRebuildWorker && _summaryRebuildDataDir === dataDir) return;
  if (_summaryRebuildWorker) {
    try {
      void _summaryRebuildWorker.terminate();
    } catch {
      /* stale worker exits independently */
    }
  }
  let worker;
  try {
    worker = new Worker(new URL('./summary-rebuild-worker.mjs', import.meta.url), {
      execArgv: [],
      workerData: { dataDir },
    });
  } catch {
    return;
  }
  _summaryRebuildWorker = worker;
  _summaryRebuildDataDir = dataDir;
  const clear = () => {
    if (_summaryRebuildWorker !== worker) return;
    _summaryRebuildWorker = null;
    _summaryRebuildDataDir = '';
  };
  worker.on('message', (message) => {
    if (message?.ok !== true || message.dataDir !== getPluginData() || !Array.isArray(message.rows)) return;
    _summaryIndexMtimeSeen = summaryIndexStampMs(summaryIndexPath());
    _setSummaryRowsCache(message.rows);
  });
  worker.on('error', clear);
  worker.on('exit', clear);
  worker.unref();
}

/**
 * Resolves once no summary-index writer of this process is running: the
 * background rebuild worker a cold listing (or sweep) spawned has exited,
 * every queued index mutation has landed and the session catalog DB is
 * closed. Both write the index, its lock and
 * temp files into the data dir after the listing/sweep/save that caused them
 * has returned, so an owner that removes or switches the data dir awaits this
 * first.
 */
export async function settleSessionSummaryIndex() {
  const worker = _summaryRebuildWorker;
  if (worker) {
    // The rebuild worker is unref'd; an awaited exit must keep the process up.
    worker.ref();
    await new Promise((resolve) => worker.once('exit', resolve));
  }
  await settleSummaryIndexWrites();
  // The daemon's session catalog DB holds its file, WAL and lock open.
  await closeSessionCatalogDb();
}

export function listStoredSessionSummaries(options = {}) {
  _ensureSummaryCacheDataDir();
  // This is intentionally the only path that rescans every session JSON:
  // callers use it as an on-demand authoritative refresh (including resume
  // authorization), so it must not trust either the cache or sidecar.
  if (options.refreshFromStorage === true) return _refreshSummariesFromStorage();
  if (_summaryRowsCache !== null) return _warmSummaryRows();
  return _coldSummaryRows();
}

function _refreshSummariesFromStorage() {
  try {
    const { rows: persistedRows, invalidStorageIds, changed } = _scanStoredSessionSummaryRows();
    const rows = _overlayUnpersistedSummaryRows(persistedRows, invalidStorageIds);
    // Unchanged scans skip the sidecar rewrite — refresh is called on
    // every sidebar poll/push and must not grind a multi-MB atomic
    // write when no session actually changed.
    if (changed) {
      try {
        _writeSummaryIndex(persistedRows);
      } catch {
        /* sidecar remains best-effort */
      }
    }
    // A direct scan settles deletion state too; retain only active
    // optimistic write overlays, never a stale local removal.
    _summaryCacheRemovals.clear();
    _setSummaryRowsCache(persistedRows);
    return rows;
  } catch {
    // A refresh is an authorization boundary for desktop resume. If
    // authoritative storage cannot be enumerated, stale cached/sidecar
    // rows must not be treated as proof that a session is available.
    return [];
  }
}

function _warmSummaryRows() {
  // A local session save has already updated the in-memory cache but its
  // non-blocking sidecar merge may still be queued/in flight. Re-reading
  // the older sidecar in that window would temporarily erase the new row.
  if (_hasUnsettledSummaryOps()) return _cachedSummaryRows().slice();
  // Cross-process freshness: another live process (terminal CLI owning a
  // session this surface only views) advances messageCount/updatedAt by
  // rewriting the summary index FILE — an in-memory cache that never
  // looks back at disk serves frozen rows forever (user: the unread dot
  // never fired for terminal-owned growth). One stat per call; when the
  // index advanced, re-read the cheap index JSON as the new cache base
  // (local optimistic overlays stay applied on top).
  // Stamp = newest mtime of base + delta log, taken BEFORE the reads so a
  // change landing mid-read is seen again on the next call.
  const diskMtime = summaryIndexStampMs(summaryIndexPath());
  if (diskMtime <= _summaryIndexMtimeSeen) return _cachedSummaryRows().slice();
  try {
    const logText = readSummaryLogText(summaryIndexPath());
    const raw = applySummaryLogText(JSON.parse(readFileSync(summaryIndexPath(), 'utf-8')), logText);
    if (Number(raw?.version) === SESSION_SUMMARY_INDEX_VERSION) {
      _summaryIndexMtimeSeen = diskMtime;
      return _setSummaryRowsCache(_normalizeSummaryIndex(raw).rows).slice();
    }
  } catch {
    /* torn concurrent write — keep serving the cache; retry next call */
  }
  return _cachedSummaryRows().slice();
}

function _coldSummaryRows() {
  let indexedRows = [];
  let p;
  let hasIndex = false;
  let indexUnreadable = false;
  try {
    p = summaryIndexPath();
    const probe = probePath(p);
    hasIndex = probe.state === PROBE_PRESENT;
    if (probe.state !== PROBE_PRESENT && probe.state !== PROBE_ABSENT) indexUnreadable = true;
    if (hasIndex) {
      const stampBeforeRead = summaryIndexStampMs(p);
      const logText = readSummaryLogText(p);
      let text;
      try {
        text = readFileSync(p, 'utf-8');
      } catch (err) {
        // Stat said PRESENT and the read failed: the sidecar is there
        // and we cannot have it. FAIL CLOSED — keep serving the cache,
        // never emit empty rows and never schedule a rebuild that
        // would overwrite a sidecar we could not read.
        const code = err?.code || 'EUNKNOWN';
        if (code !== 'ENOENT' && code !== 'ENOTDIR') indexUnreadable = true;
        throw err;
      }
      const raw = applySummaryLogText(JSON.parse(text), logText);
      hasIndex = Number(raw?.version) === SESSION_SUMMARY_INDEX_VERSION;
      if (hasIndex) {
        indexedRows = _normalizeSummaryIndex(raw).rows;
        _summaryIndexMtimeSeen = stampBeforeRead;
      }
    }
  } catch {
    /* unreadable/malformed sidecar falls through to rebuild */
  }

  if (indexUnreadable) {
    // Present-but-unreadable sidecar: retain authority. A COLD cache has
    // no rows yet (null) — return an empty result rather than crashing on
    // `.slice()`, and never rebuild/replace the sidecar we could not read.
    const cached = _cachedSummaryRows();
    return Array.isArray(cached) ? cached.slice() : [];
  }
  if (!p || !hasIndex) {
    scheduleSessionSummaryIndexRebuild();
    return _setSummaryRowsCache(indexedRows);
  }
  try {
    if (indexedRows.length > 0) return _setSummaryRowsCache(indexedRows);
    const dir = getStoreDir();
    const hasSessionFiles = probePath(dir).state === PROBE_PRESENT && readdirSync(dir).some((f) => f.endsWith('.json'));
    if (hasSessionFiles) scheduleSessionSummaryIndexRebuild();
    return _setSummaryRowsCache(indexedRows);
  } catch {
    scheduleSessionSummaryIndexRebuild();
    return _setSummaryRowsCache(indexedRows);
  }
}

/**
 * Raw directory scan — returns every parseable session file without any
 * TTL-based inline deletion. Callers (e.g. sweepTombstones) need to own the
 * unlink decision and log it themselves.
 */
export function getStoredSessionsRaw() {
  const dir = getStoreDir();
  if (probePath(dir).state !== PROBE_PRESENT) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const sessions = [];
  for (const f of files) {
    const session = _storedSessionFromFile(dir, f, false);
    if (session && session !== STORED_SESSION_UNREADABLE) sessions.push(session);
  }
  return sessions;
}
