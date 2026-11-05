import { readdir } from 'node:fs/promises';
import { getPluginData } from '../../config.mjs';
import { getStoreDir, storeRecordDir } from './session-paths.mjs';
import { probePathAsync, PROBE_PRESENT, PROBE_ABSENT } from './fs-probe.mjs';
import { STORED_SESSION_UNREADABLE } from './serialize.mjs';
import {
  ABSENT_RECORD_STAMP,
  logLegacyProof,
  parseSessionRecordStamp,
  recordStampFingerprint,
  sessionIdsOfNames,
  sessionRecordStampOf,
  sessionRecordStampOfSync,
} from './session-record.mjs';
import { storedSessionRecordAsync } from './stored-session.mjs';
import {
  _sessionSummary,
  _normalizeSummaryIndex,
  _upsertSessionSummaryRow,
  _removeSessionSummary,
  _pruneSummaryIndexIds,
  _moveSessionSummaryFingerprints,
} from '../store-summary-index.mjs';
// In the daemon, ids whose file a write just changed are hinted to the
// session catalog DB (a no-op in any other process).
import { hintSessionCatalogStorage, onSessionCatalogIndexMoves } from '../catalog-db/index.mjs';

// The catalog DB worker found index rows that describe a session log through
// its conversion base: re-pointed in the index, the next start stats them
// instead of reading every log again.
onSessionCatalogIndexMoves(_moveSessionSummaryFingerprints);

// Listing is much hotter than writing, especially while the desktop session
// browser is open. Keep the compact sidecar in memory after the first read;
// local durability mutations update this cache synchronously, while an
// explicit refresh remains the authoritative cross-process/disk reconciliation
// path. Pending overlays cover a write that lands before the first listing.
export let _summaryRowsCache = null;
const _summaryCacheUpserts = new Map();
const _summaryCacheLatestRows = new Map();
const _summaryCacheRemovals = new Set();
export const _summaryCacheVersions = new Map();
let _summaryCacheDataDir = null;
let _summaryRowsViewCache = null;

function _invalidateSummaryRowsView() {
  _summaryRowsViewCache = null;
}

export function _ensureSummaryCacheDataDir() {
  const dataDir = getPluginData();
  if (_summaryCacheDataDir === dataDir) return;
  _summaryCacheDataDir = dataDir;
  _summaryRowsCache = null;
  _summaryRowsViewCache = null;
  _summaryScanCache = { dataDir: null, files: new Map() };
  _summaryCacheUpserts.clear();
  _summaryCacheLatestRows.clear();
  _summaryCacheRemovals.clear();
  _summaryCacheVersions.clear();
}

function _summaryRowsWithLocalMutations(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of _summaryCacheRemovals) byId.delete(id);
  for (const [id, row] of _summaryCacheUpserts) byId.set(id, row);
  return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function _setSummaryRowsCache(rows, options) {
  if (options?.discardLocalMutations === true) {
    _summaryCacheUpserts.clear();
    _summaryCacheLatestRows.clear();
    _summaryCacheRemovals.clear();
  }
  _summaryRowsCache = _normalizeSummaryIndex({ rows }).rows;
  _invalidateSummaryRowsView();
  return _cachedSummaryRows();
}

export function _cachedSummaryRows() {
  if (_summaryRowsCache === null) return null;
  if (_summaryRowsViewCache) return _summaryRowsViewCache;
  _summaryRowsViewCache = _summaryRowsWithLocalMutations(_summaryRowsCache);
  return _summaryRowsViewCache;
}

function _setCachedBaseSummary(row) {
  if (!row) return;
  _noteScanTouched(row.id, row);
  if (_summaryRowsCache === null) return;
  const byId = new Map(_summaryRowsCache.map((existing) => [existing.id, existing]));
  byId.set(row.id, row);
  _summaryRowsCache = [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  _invalidateSummaryRowsView();
}

function _removeCachedBaseSummary(id) {
  _noteScanTouched(id, null);
  if (_summaryRowsCache === null) return;
  _summaryRowsCache = _summaryRowsCache.filter((row) => row.id !== id);
  _invalidateSummaryRowsView();
}

export function _cacheSessionSummary(session) {
  _ensureSummaryCacheDataDir();
  const row = _sessionSummary(session);
  if (!row) return;
  const version = (_summaryCacheVersions.get(row.id) || 0) + 1;
  _summaryCacheVersions.set(row.id, version);
  _summaryCacheRemovals.delete(row.id);
  _summaryCacheUpserts.set(row.id, row);
  _summaryCacheLatestRows.set(row.id, { version, row });
  _invalidateSummaryRowsView();
  return version;
}

export function _uncacheSessionSummary(id) {
  _ensureSummaryCacheDataDir();
  if (!id) return;
  _summaryCacheVersions.set(id, (_summaryCacheVersions.get(id) || 0) + 1);
  _summaryCacheUpserts.delete(id);
  _summaryCacheLatestRows.delete(id);
  _summaryCacheRemovals.add(id);
  _invalidateSummaryRowsView();
  _removeCachedBaseSummary(id);
}

export function _rollbackCachedSessionSummary(id, version) {
  if ((_summaryCacheVersions.get(id) || 0) !== version) return;
  _summaryCacheUpserts.delete(id);
  _summaryCacheLatestRows.delete(id);
  _invalidateSummaryRowsView();
}

export function _queueSessionSummaryUpsert(session, version = null) {
  const latest = version === null ? null : _summaryCacheLatestRows.get(session?.id);
  const row = latest?.version === version ? latest.row : _sessionSummary(session);
  return _queueSessionSummaryUpsertRow(row, version);
}

/**
 * Publish an ALREADY-CAPTURED row. Async writers snapshot the row at the
 * moment their payload is built and publish THAT snapshot when the write
 * lands, so an older completion can never republish metadata read from the
 * (since-mutated) live session — the row always describes the bytes that
 * actually reached disk.
 */
export function _queueSessionSummaryUpsertRow(row, version = null, { logLegacy } = {}) {
  if (!row) return;
  let stamp = null;
  try {
    stamp = sessionRecordStampOfSync(getStoreDir(), row.id);
  } catch {
    /* unreadable stat: the row carries no fingerprint, as before */
  }
  const durableRow = durableSummaryRow(row, stamp, logLegacy);
  _setCachedBaseSummary(durableRow);
  if (version === null || (_summaryCacheVersions.get(row.id) || 0) === version) {
    _summaryCacheUpserts.delete(row.id);
    if (_summaryCacheLatestRows.get(row.id)?.version === version) {
      _summaryCacheLatestRows.delete(row.id);
    }
    _summaryCacheRemovals.delete(row.id);
    _invalidateSummaryRowsView();
  }
  _upsertSessionSummaryRow(durableRow);
  hintSessionCatalogStorage([row.id]);
}

/** `row` with the fingerprint of the record file `stamp` shows and, for a
 *  log whose base `legacy` the caller knows (undefined: unknown), its log
 *  proof; without one a reader settles the json beside the log by a read. */
function durableSummaryRow(row, stamp, legacy) {
  const fingerprint = stamp ? recordStampFingerprint(stamp) : null;
  if (!fingerprint) return row;
  const { storageLegacy: _stale, ...rest } = row;
  const durable = { ...rest, storageMtimeMs: fingerprint.mtimeMs, storageSize: fingerprint.size };
  if (legacy !== undefined && parseSessionRecordStamp(stamp).log) durable.storageLegacy = logLegacyProof(legacy);
  return durable;
}

export function _queueSessionSummaryRemoval(id) {
  _uncacheSessionSummary(id);
  _removeSessionSummary(id);
  hintSessionCatalogStorage([id]);
}

export function _queueSummaryIndexPrune(ids) {
  for (const id of ids) _uncacheSessionSummary(id);
  _pruneSummaryIndexIds(ids);
  hintSessionCatalogStorage(ids);
}

// ── Incremental storage scan ────────────────────────────────────────────────
// A refreshFromStorage that re-parsed EVERY session JSON (full transcripts,
// multi-MB files) on each desktop sidebar refresh would be far too costly. A
// summary only changes when its record changes, so key a per-session row
// cache on the record stamp (session-log-reader.mjs sessionRecordStamp: log
// and json): unchanged records reuse the cached row, changed/new ones are
// read again, vanished ones drop out. Storage stays the truth source — the sidecar index is never trusted.
// Every stat, listing and read is awaited, so the scan hands the event loop
// back after each file; only one scan runs at a time (store/listing.mjs).
// The cache belongs to one data dir and is replaced, never cleared, when the
// dir switches: a scan writes only into the cache of the dir it started in,
// so rows it reads after a switch can never serve a file of another dir that
// happens to have the same name, size and mtime.
let _summaryScanCache = { dataDir: null, files: new Map() }; // files: session id → { stamp, row|null }

function _summaryScanCacheFor(dataDir) {
  if (_summaryScanCache.dataDir !== dataDir) _summaryScanCache = { dataDir, files: new Map() };
  return _summaryScanCache.files;
}

// While a scan (or an index read) awaits storage, local writes keep landing:
// per open window, id → the base row a write set meanwhile (null: it dropped
// the row). The read may predate that write, so its rows never stand in for
// them.
const _readWindows = new Set();

function _noteScanTouched(id, row) {
  for (const touched of _readWindows) touched.set(id, row);
}

/** Opens the window of one awaited read of storage or the index;
 *  `adopt(rows, { invalidStorageIds, settlesRemovals })` closes it,
 *  reconciles the rows read with the local writes that landed meanwhile,
 *  makes them the cache base and returns them (newest first).
 *  `settlesRemovals`: the rows come from a scan of the session files, which
 *  settles every removal recorded before it began. */
export function _openSummaryScanWindow() {
  const touched = new Map();
  _readWindows.add(touched);
  // Removals already recorded when a scan starts are settled by it: their
  // files were gone before it listed the directory.
  const removalsBefore = new Set(_summaryCacheRemovals);
  const close = () => {
    _readWindows.delete(touched);
  };
  return {
    close,
    adopt(rows, { invalidStorageIds = new Set(), settlesRemovals = false } = {}) {
      close();
      // A row a write landed meanwhile describes its file as it is now; a
      // removal drops the row (and stays recorded, so the overlay keeps hiding
      // it). A file the scan found unreadable is never stood in for.
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const [id, row] of touched) {
        if (!row) byId.delete(id);
        else if (!invalidStorageIds.has(id)) byId.set(id, row);
      }
      if (settlesRemovals) for (const id of removalsBefore) _summaryCacheRemovals.delete(id);
      const reconciled = [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      _setSummaryRowsCache(reconciled);
      return reconciled;
    },
  };
}

export async function _scanStoredSessionSummaryRowsAsync() {
  // The scan only reads: an absent directory is answered below.
  const dir = storeRecordDir();
  const scanCache = _summaryScanCacheFor(getPluginData());
  const dirProbe = await probePathAsync(dir);
  if (dirProbe.state === PROBE_ABSENT) {
    const changed = scanCache.size > 0;
    scanCache.clear();
    return { rows: [], invalidStorageIds: new Set(), changed };
  }
  if (dirProbe.state !== PROBE_PRESENT) {
    // The store dir exists as far as we know and simply cannot be probed
    // (EACCES/EIO). Reporting "no sessions" here would let the caller
    // rewrite the sidecar index from an empty scan — i.e. delete every
    // row because of a transient stat error. Fail loudly instead; the
    // refresh caller treats a throw as "storage not enumerable".
    const err = new Error(`[session-store] session dir not readable (${dirProbe.code})`);
    err.code = dirProbe.code;
    throw err;
  }
  const storageIds = sessionIdsOfNames(await readdir(dir));
  const present = new Set(storageIds);
  let changed = false;
  for (const key of [...scanCache.keys()]) {
    if (!present.has(key)) {
      scanCache.delete(key);
      changed = true;
    }
  }
  const rows = [];
  const invalidStorageIds = new Set();
  // A session without a usable row is marked invalid, so no pending/live
  // overlay may stand in for it.
  const keepRow = (storageId, row) => {
    if (row) rows.push(row);
    else invalidStorageIds.add(storageId);
  };
  for (const storageId of storageIds) {
    let stamp;
    try {
      stamp = await sessionRecordStampOf(dir, storageId);
    } catch {
      // Unreadable stat (EACCES/EIO/EBUSY): NOT a deletion. Keep the
      // cache entry exactly as it is — `changed` stays untouched so no
      // sidecar rewrite can drop this row — and keep serving the last
      // known row. With no cached row the id is marked invalid instead.
      keepRow(storageId, scanCache.get(storageId)?.row);
      continue;
    }
    // Proven absence only: the record was deleted mid-scan, so its cached
    // row legitimately retires.
    if (stamp === ABSENT_RECORD_STAMP) {
      if (scanCache.delete(storageId)) changed = true;
      continue;
    }
    const cached = scanCache.get(storageId);
    if (cached && cached.stamp === stamp) {
      keepRow(storageId, cached.row);
      continue;
    }
    const { session, logLegacy } = await storedSessionRecordAsync(dir, storageId);
    if (session === STORED_SESSION_UNREADABLE) {
      // Stat said PRESENT, the READ failed: identical contract to an
      // unreadable stat. Retain the last known row, leave `changed`
      // untouched (no sidecar rewrite may drop it) and never cache a
      // null row for a record we could not read.
      keepRow(storageId, scanCache.get(storageId)?.row);
      continue;
    }
    const summary = session ? _sessionSummary(session) : null;
    const row = summary ? durableSummaryRow(summary, stamp, logLegacy) : null;
    scanCache.set(storageId, { stamp, row });
    changed = true;
    keepRow(storageId, row);
  }
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { rows, invalidStorageIds, changed };
}
