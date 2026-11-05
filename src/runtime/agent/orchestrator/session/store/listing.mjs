// Session listing and summary projection (the stale-session sweep is
// sweep/stale-sweep.mjs); store.mjs owns the persistence half
// (save/load/close/delete). Both read the in-flight save maps so an
// unpersisted session still shows up in listings.
import { readdirSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { getPluginData } from '../../config.mjs';
import { getStoreDir, storeRecordDir } from './session-paths.mjs';
import { probePath, probePathStep, PROBE_PRESENT, PROBE_ABSENT } from './fs-probe.mjs';
import { runFsStepsAsync, runFsStepsSync } from './fs-steps.mjs';
import {
  SESSION_SUMMARY_INDEX_VERSION,
  summaryIndexPath,
  _sessionSummary,
  _normalizeSummaryIndex,
  _writeSummaryIndex,
  _hasUnsettledSummaryOps,
  _holdSummaryAppends,
  settleSummaryIndexWrites,
} from '../store-summary-index.mjs';
import {
  applySummaryLogText,
  readSummaryIndexPairSteps,
  readSummaryLogTextStep,
  summaryIndexStampMs,
  summaryIndexStampMsStep,
} from '../store-summary-log.mjs';
import {
  _ensureSummaryCacheDataDir,
  _cachedSummaryRows,
  _openSummaryScanWindow,
  _setSummaryRowsCache,
  _scanStoredSessionSummaryRowsAsync,
  _summaryRowsCache,
} from './summary-cache.mjs';
import { STORED_SESSION_UNREADABLE, _ensureLifecycleFields } from './serialize.mjs';
import { sessionIdOfRecordName, sessionIdsOfNames } from './session-record.mjs';
import { storedSessionSync } from './stored-session.mjs';
import { forEachUnpersistedSession } from './pending-writes.mjs';
import { isSessionWriteFenced } from './live-state.mjs';
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
  const sessionsById = new Map();
  const invalidStorageIds = options._invalidStorageIds instanceof Set ? options._invalidStorageIds : new Set();
  for (const storageId of sessionIdsOfNames(readdirSync(dir))) {
    const session = storedSessionSync(dir, storageId);
    if (session && session !== STORED_SESSION_UNREADABLE) {
      sessionsById.set(session.id, session);
      continue;
    }
    // Present-but-unreadable owns its identity too: it may never be
    // replaced by a live/pending overlay, so it is marked invalid.
    invalidStorageIds.add(storageId);
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
  const addIfUnpersisted = (id, session) => {
    // A valid on-disk record is authoritative for refresh/resume. In
    // particular, a long-lived runtime object must never replace a
    // tombstone or changed desktop authorization metadata. Only active
    // local writes with no disk record get read-your-writes visibility.
    if (sessionsById.has(id) || invalidStorageIds.has(id)) return;
    if (session?.id === id) sessionsById.set(id, _ensureLifecycleFields(session));
  };
  _forEachUnpersistedWrite(addIfUnpersisted);
  return [...sessionsById.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// Every save that may not be on disk yet: the debounced copies (a recorded
// one has its log from its first write on). A fenced (deleted) id is none.
function _forEachUnpersistedWrite(visit) {
  forEachUnpersistedSession((id, session) => {
    if (!isSessionWriteFenced(id)) visit(id, session);
  });
}

// Summary-level twin of _withUnpersistedSessions: overlay queued/in-flight
// saves that have no disk record yet (read-your-writes for brand-new sessions).
function _overlayUnpersistedSummaryRows(rows, invalidStorageIds = new Set()) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const addIfUnpersisted = (id, session) => {
    if (!id || byId.has(id) || invalidStorageIds.has(id)) return;
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

/** The cached/sidecar listing. The authoritative storage rescan is
 *  listStoredSessionSummariesAsync({ refreshFromStorage: true }). */
export function listStoredSessionSummaries() {
  return runFsStepsSync(_cachedListingSteps());
}

function* _cachedListingSteps() {
  _ensureSummaryCacheDataDir();
  if (_summaryRowsCache !== null) return yield* _warmSummaryRowsSteps();
  return yield* _coldSummaryRowsSteps();
}

/**
 * listStoredSessionSummaries for async callers. `refreshFromStorage: true` is
 * the only path that rescans every session JSON: callers use it as an
 * on-demand authoritative refresh (including resume authorization), so it
 * trusts neither the cache nor the sidecar. Every stat and read (the index
 * read of the cached listing too) and the index rewrite are awaited.
 */
export async function listStoredSessionSummariesAsync(options = {}) {
  _ensureSummaryCacheDataDir();
  if (options.refreshFromStorage !== true) return runFsStepsAsync(_cachedListingSteps());
  const scanned = await _storageRefresh();
  // A refresh is an authorization boundary for desktop resume. If
  // authoritative storage cannot be enumerated, stale cached/sidecar rows
  // must not be treated as proof that a session is available.
  if (!scanned) return [];
  return _overlayUnpersistedSummaryRows(scanned.rows, scanned.invalidStorageIds);
}

// One storage refresh runs at a time (they share the per-file scan cache). A
// caller arriving while one runs may have written something that scan already
// passed, so it never joins it: it waits for the one refresh queued behind it,
// shared by every caller arriving meanwhile.
let _refreshRunning = null;
let _refreshQueued = null;

function _storageRefresh() {
  if (_refreshQueued) return _refreshQueued;
  if (!_refreshRunning) return _startStorageRefresh();
  _refreshQueued = _refreshRunning.then(() => {
    _refreshQueued = null;
    return _startStorageRefresh();
  });
  return _refreshQueued;
}

function _startStorageRefresh() {
  const run = _refreshSummariesFromStorage().finally(() => {
    if (_refreshRunning === run) _refreshRunning = null;
  });
  _refreshRunning = run;
  return run;
}

/** `{ rows, invalidStorageIds }` of one awaited rescan, or null when storage
 *  cannot be enumerated. Never rejects. */
async function _refreshSummariesFromStorage() {
  const dataDir = getPluginData();
  const releaseAppends = _holdSummaryAppends();
  const scanWindow = _openSummaryScanWindow();
  try {
    const { rows, invalidStorageIds, changed } = await _scanStoredSessionSummaryRowsAsync();
    // A data dir switched mid-scan: these rows describe the old one, so they
    // may neither become the new dir's cache nor be written into its index.
    if (getPluginData() !== dataDir) return { rows, invalidStorageIds };
    // Unchanged scans skip the sidecar rewrite — refresh is called on
    // every sidebar poll/push and must not grind a multi-MB atomic
    // write when no session actually changed.
    if (changed) {
      try {
        await _writeSummaryIndex(rows);
      } catch {
        /* sidecar remains best-effort */
      }
    }
    // The rewrite is awaited too: a switch during it leaves the new dir's
    // cache alone as well.
    if (getPluginData() !== dataDir) return { rows, invalidStorageIds };
    // A direct scan settles deletion state too; retain only active
    // optimistic write overlays, never a stale local removal.
    // The answer is storage as it is when the refresh returns: a session a
    // local write deleted or updated while the scan awaited I/O is answered
    // as that write left it.
    return { rows: scanWindow.adopt(rows, { invalidStorageIds, settlesRemovals: true }), invalidStorageIds };
  } catch {
    return null;
  } finally {
    scanWindow.close();
    releaseAppends();
  }
}

// The cached listing reads the index as store-read steps (store/fs-steps.mjs):
// blocking for the sync listing, awaited for the async one. An awaited read
// lets local writes land meanwhile, so it reads inside a window (see
// _openSummaryScanWindow) whose adoption keeps what those writes left, and a
// data dir switched mid-read never receives the old dir's rows.
function _adoptIndexRows(window, dataDir, rows) {
  if (getPluginData() !== dataDir) return rows;
  window.adopt(rows);
  return _cachedSummaryRows();
}

function* _warmSummaryRowsSteps() {
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
  const dataDir = getPluginData();
  const path = summaryIndexPath();
  const diskMtime = yield* summaryIndexStampMsStep(path);
  if (diskMtime <= _summaryIndexMtimeSeen) return _cachedSummaryRows().slice();
  const window = _openSummaryScanWindow();
  try {
    const pair = yield* readSummaryIndexPairSteps(
      path,
      () => readSummaryLogTextStep(path),
      function* readBase() {
        return yield ['readFile', path, 'utf-8'];
      }
    );
    if (!pair) throw new Error('summary index replaced during the read');
    const raw = applySummaryLogText(JSON.parse(pair.base), pair.log);
    if (Number(raw?.version) === SESSION_SUMMARY_INDEX_VERSION) {
      const rows = _normalizeSummaryIndex(raw).rows;
      if (getPluginData() !== dataDir) return rows;
      _summaryIndexMtimeSeen = diskMtime;
      return _adoptIndexRows(window, dataDir, rows).slice();
    }
  } catch {
    /* torn concurrent write — keep serving the cache; retry next call */
  } finally {
    window.close();
  }
  return getPluginData() === dataDir ? _cachedSummaryRows().slice() : [];
}

function* _coldSummaryRowsSteps() {
  const dataDir = getPluginData();
  const window = _openSummaryScanWindow();
  try {
    return yield* _coldSummaryRowsInWindow(window, dataDir);
  } finally {
    window.close();
  }
}

function* _coldSummaryRowsInWindow(window, dataDir) {
  let indexedRows = [];
  let p;
  let hasIndex = false;
  let indexUnreadable = false;
  let stampBeforeRead = 0;
  try {
    p = summaryIndexPath();
    const probe = yield* probePathStep(p);
    hasIndex = probe.state === PROBE_PRESENT;
    if (probe.state !== PROBE_PRESENT && probe.state !== PROBE_ABSENT) indexUnreadable = true;
    if (hasIndex) {
      stampBeforeRead = yield* summaryIndexStampMsStep(p);
      let pair;
      try {
        pair = yield* readSummaryIndexPairSteps(
          p,
          () => readSummaryLogTextStep(p),
          function* readBase() {
            return yield ['readFile', p, 'utf-8'];
          }
        );
      } catch (err) {
        // Stat said PRESENT and the read failed: the sidecar is there
        // and we cannot have it. FAIL CLOSED — keep serving the cache,
        // never emit empty rows and never schedule a rebuild that
        // would overwrite a sidecar we could not read.
        const code = err?.code || 'EUNKNOWN';
        if (code !== 'ENOENT' && code !== 'ENOTDIR') indexUnreadable = true;
        throw err;
      }
      // Replaced across both attempts: no whole read, so the rebuild below
      // (from the session files) answers, as for a sidecar that does not parse.
      if (!pair) throw new Error('summary index replaced during the read');
      const raw = applySummaryLogText(JSON.parse(pair.base), pair.log);
      hasIndex = Number(raw?.version) === SESSION_SUMMARY_INDEX_VERSION;
      if (hasIndex) indexedRows = _normalizeSummaryIndex(raw).rows;
    }
  } catch {
    /* unreadable/malformed sidecar falls through to rebuild */
  }
  // The rows of a data dir switched away from mid-read: answered, never
  // cached, and no rebuild scheduled for the new dir on their account.
  if (getPluginData() !== dataDir) return indexedRows;
  if (hasIndex) _summaryIndexMtimeSeen = stampBeforeRead;

  if (indexUnreadable) {
    // Present-but-unreadable sidecar: retain authority. A COLD cache has
    // no rows yet (null) — return an empty result rather than crashing on
    // `.slice()`, and never rebuild/replace the sidecar we could not read.
    const cached = _cachedSummaryRows();
    return Array.isArray(cached) ? cached.slice() : [];
  }
  if (!p || !hasIndex) {
    scheduleSessionSummaryIndexRebuild();
    return _adoptIndexRows(window, dataDir, indexedRows);
  }
  try {
    if (indexedRows.length > 0) return _adoptIndexRows(window, dataDir, indexedRows);
    // Only listed, never created: an absent store simply has no files.
    const dir = storeRecordDir();
    const hasSessionFiles =
      (yield* probePathStep(dir)).state === PROBE_PRESENT && (yield ['readdir', dir]).some(sessionIdOfRecordName);
    // The rebuild targets the current dir: only on this dir's evidence.
    if (hasSessionFiles && getPluginData() === dataDir) scheduleSessionSummaryIndexRebuild();
    return _adoptIndexRows(window, dataDir, indexedRows);
  } catch {
    if (getPluginData() === dataDir) scheduleSessionSummaryIndexRebuild();
    return _adoptIndexRows(window, dataDir, indexedRows);
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
  const sessions = [];
  for (const storageId of sessionIdsOfNames(readdirSync(dir))) {
    const session = storedSessionSync(dir, storageId, false);
    if (session && session !== STORED_SESSION_UNREADABLE) sessions.push(session);
  }
  return sessions;
}
