import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { getPluginData } from '../../config.mjs';
import { getStoreDir } from './paths-heartbeat.mjs';
import { _storedSessionFromFile } from './serialize.mjs';
import { _sessionSummary, _normalizeSummaryIndex, _upsertSessionSummary, _removeSessionSummary, _pruneSummaryIndexIds } from '../store-summary-index.mjs';

// Listing is much hotter than writing, especially while the desktop session
// browser is open. Keep the compact sidecar in memory after the first read;
// local durability mutations update this cache synchronously, while an
// explicit refresh remains the authoritative cross-process/disk reconciliation
// path. Pending overlays cover a write that lands before the first listing.
export let _summaryRowsCache = null;
export const _summaryCacheUpserts = new Map();
export const _summaryCacheRemovals = new Set();
export const _summaryCacheVersions = new Map();
export let _summaryCacheDataDir = null;

export function _ensureSummaryCacheDataDir() {
    const dataDir = getPluginData();
    if (_summaryCacheDataDir === dataDir) return;
    _summaryCacheDataDir = dataDir;
    _summaryRowsCache = null;
    _summaryScanCache.clear();
    _summaryCacheUpserts.clear();
    _summaryCacheRemovals.clear();
    _summaryCacheVersions.clear();
}

export function _summaryRowsWithLocalMutations(rows, { discardLocalMutations = false } = {}) {
    if (discardLocalMutations) {
        _summaryCacheUpserts.clear();
        _summaryCacheRemovals.clear();
    }
    const byId = new Map(_normalizeSummaryIndex({ rows }).rows.map((row) => [row.id, row]));
    for (const id of _summaryCacheRemovals) byId.delete(id);
    for (const [id, row] of _summaryCacheUpserts) byId.set(id, row);
    return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function _setSummaryRowsCache(rows, options) {
    if (options?.discardLocalMutations === true) {
        _summaryCacheUpserts.clear();
        _summaryCacheRemovals.clear();
    }
    _summaryRowsCache = _normalizeSummaryIndex({ rows }).rows;
    return _summaryRowsWithLocalMutations(_summaryRowsCache);
}

export function _cachedSummaryRows() {
    return _summaryRowsCache === null ? null : _summaryRowsWithLocalMutations(_summaryRowsCache);
}

export function _setCachedBaseSummary(row) {
    if (!row || _summaryRowsCache === null) return;
    const byId = new Map(_summaryRowsCache.map((existing) => [existing.id, existing]));
    byId.set(row.id, row);
    _summaryRowsCache = [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function _removeCachedBaseSummary(id) {
    if (_summaryRowsCache === null) return;
    _summaryRowsCache = _summaryRowsCache.filter((row) => row.id !== id);
}

export function _cacheSessionSummary(session) {
    _ensureSummaryCacheDataDir();
    const row = _sessionSummary(session);
    if (!row) return;
    _summaryCacheVersions.set(row.id, (_summaryCacheVersions.get(row.id) || 0) + 1);
    _summaryCacheRemovals.delete(row.id);
    _summaryCacheUpserts.set(row.id, row);
    return _summaryCacheVersions.get(row.id);
}

export function _uncacheSessionSummary(id) {
    _ensureSummaryCacheDataDir();
    if (!id) return;
    _summaryCacheVersions.set(id, (_summaryCacheVersions.get(id) || 0) + 1);
    _summaryCacheUpserts.delete(id);
    _summaryCacheRemovals.add(id);
    _removeCachedBaseSummary(id);
}

export function _rollbackCachedSessionSummary(id, version) {
    if ((_summaryCacheVersions.get(id) || 0) !== version) return;
    _summaryCacheUpserts.delete(id);
}

export function _queueSessionSummaryUpsert(session, version = null) {
    const row = _sessionSummary(session);
    if (!row) return;
    _setCachedBaseSummary(row);
    if (version === null || (_summaryCacheVersions.get(row.id) || 0) === version) {
        _summaryCacheUpserts.delete(row.id);
        _summaryCacheRemovals.delete(row.id);
    }
    _upsertSessionSummary(session);
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
export const _summaryScanCache = new Map(); // filename → { mtimeMs, size, row|null }

export function _scanStoredSessionSummaryRows() {
    const dir = getStoreDir();
    if (!existsSync(dir)) {
        const changed = _summaryScanCache.size > 0;
        _summaryScanCache.clear();
        return { rows: [], invalidStorageIds: new Set(), changed };
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
        let fileStat = null;
        try { fileStat = statSync(join(dir, f)); } catch { /* deleted mid-scan */ }
        if (!fileStat) {
            if (_summaryScanCache.delete(f)) changed = true;
            continue;
        }
        const cached = _summaryScanCache.get(f);
        if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
            if (cached.row) rows.push(cached.row);
            else markInvalid(f);
            continue;
        }
        const session = _storedSessionFromFile(dir, f);
        const row = session ? _sessionSummary(session) : null;
        _summaryScanCache.set(f, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, row });
        changed = true;
        if (row) rows.push(row);
        else markInvalid(f);
    }
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { rows, invalidStorageIds, changed };
}
