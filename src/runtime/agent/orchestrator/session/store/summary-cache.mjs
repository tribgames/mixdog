import { readdirSync } from 'fs';
import { join } from 'path';
import { getPluginData } from '../../config.mjs';
import { getStoreDir } from './paths-heartbeat.mjs';
import { probePath, PROBE_PRESENT, PROBE_ABSENT } from './fs-probe.mjs';
import { STORED_SESSION_UNREADABLE, _storedSessionFromFile } from './serialize.mjs';
import { _sessionSummary, _normalizeSummaryIndex, _upsertSessionSummaryRow, _removeSessionSummary, _pruneSummaryIndexIds } from '../store-summary-index.mjs';

// Listing is much hotter than writing, especially while the desktop session
// browser is open. Keep the compact sidecar in memory after the first read;
// local durability mutations update this cache synchronously, while an
// explicit refresh remains the authoritative cross-process/disk reconciliation
// path. Pending overlays cover a write that lands before the first listing.
export let _summaryRowsCache = null;
const _summaryCacheUpserts = new Map();
const _summaryCacheLatestRows = new Map();
export const _summaryCacheRemovals = new Set();
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
    _summaryScanCache.clear();
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
    if (!row || _summaryRowsCache === null) return;
    const byId = new Map(_summaryRowsCache.map((existing) => [existing.id, existing]));
    byId.set(row.id, row);
    _summaryRowsCache = [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    _invalidateSummaryRowsView();
}

function _removeCachedBaseSummary(id) {
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
export function _queueSessionSummaryUpsertRow(row, version = null) {
    if (!row) return;
    const fileProbe = probePath(join(getStoreDir(), `${row.id}.json`));
    const durableRow = fileProbe.state === PROBE_PRESENT
        ? { ...row, storageMtimeMs: fileProbe.mtimeMs, storageSize: fileProbe.size }
        : row;
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
}

export function _queueSessionSummaryRemoval(id) {
    _uncacheSessionSummary(id);
    _removeSessionSummary(id);
}

export function _queueSummaryIndexPrune(ids) {
    for (const id of ids) _uncacheSessionSummary(id);
    _pruneSummaryIndexIds(ids);
}

// ── Incremental storage scan ────────────────────────────────────────────────
// refreshFromStorage used to re-parse EVERY session JSON (full transcripts,
// multi-MB files) on each desktop sidebar refresh. A summary only changes when
// its file changes, so key a per-file row cache on (mtimeMs, size): unchanged
// files reuse the cached row, changed/new files re-parse, vanished files drop
// out. Storage stays the truth source — the sidecar index is never trusted.
const _summaryScanCache = new Map(); // filename → { mtimeMs, size, row|null }

export function _scanStoredSessionSummaryRows() {
    const dir = getStoreDir();
    const dirProbe = probePath(dir);
    if (dirProbe.state === PROBE_ABSENT) {
        const changed = _summaryScanCache.size > 0;
        _summaryScanCache.clear();
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
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const present = new Set(files);
    let changed = false;
    for (const key of [..._summaryScanCache.keys()]) {
        if (!present.has(key)) {
            _summaryScanCache.delete(key);
            changed = true;
        }
    }
    const rows = [];
    const invalidStorageIds = new Set();
    const markInvalid = (filename) => {
        const storageId = filename.slice(0, -5);
        if (/^[A-Za-z0-9_-]+$/.test(storageId)) invalidStorageIds.add(storageId);
    };
    for (const f of files) {
        const fileProbe = probePath(join(dir, f));
        // Proven absence only: the file was deleted mid-scan, so its cached
        // row legitimately retires.
        if (fileProbe.state === PROBE_ABSENT) {
            if (_summaryScanCache.delete(f)) changed = true;
            continue;
        }
        if (fileProbe.state !== PROBE_PRESENT) {
            // Unreadable probe (EACCES/EIO/EBUSY): NOT a deletion. Keep the
            // cache entry exactly as it is — `changed` stays untouched so no
            // sidecar rewrite can drop this row — and keep serving the last
            // known row. With no cached row the id is marked invalid instead,
            // so no pending/live overlay may stand in for the unreadable file.
            const stale = _summaryScanCache.get(f);
            if (stale?.row) rows.push(stale.row);
            else markInvalid(f);
            continue;
        }
        const cached = _summaryScanCache.get(f);
        if (cached && cached.mtimeMs === fileProbe.mtimeMs && cached.size === fileProbe.size) {
            if (cached.row) rows.push(cached.row);
            else markInvalid(f);
            continue;
        }
        const session = _storedSessionFromFile(dir, f);
        if (session === STORED_SESSION_UNREADABLE) {
            // Stat said PRESENT, the READ failed: identical contract to an
            // unreadable probe. Retain the last known row, leave `changed`
            // untouched (no sidecar rewrite may drop it) and never cache a
            // null row for a file we could not read.
            const stale = _summaryScanCache.get(f);
            if (stale?.row) rows.push(stale.row);
            else markInvalid(f);
            continue;
        }
        const summary = session ? _sessionSummary(session) : null;
        const row = summary
            ? { ...summary, storageMtimeMs: fileProbe.mtimeMs, storageSize: fileProbe.size }
            : null;
        _summaryScanCache.set(f, { mtimeMs: fileProbe.mtimeMs, size: fileProbe.size, row });
        changed = true;
        if (row) rows.push(row);
        else markInvalid(f);
    }
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { rows, invalidStorageIds, changed };
}
