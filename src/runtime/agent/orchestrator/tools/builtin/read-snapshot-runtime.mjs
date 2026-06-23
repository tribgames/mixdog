import { readFileSync, statSync } from 'fs';
import { hashText } from './hash-utils.mjs';
import { mergeReadRanges } from './read-ranges.mjs';
import {
    normaliseRangeHashEntry,
    snapshotCoversFullFile,
    statMatchesSnapshot,
    decodeRawBufferForSnapshotCheck,
} from './snapshot-helpers.mjs';
import {
    rawContentCacheGet,
    rawContentCacheSet,
} from './cache-layers.mjs';
import {
    readFilesForScope,
    readScopeKey,
    scheduleScopePersist,
} from './snapshot-store.mjs';
import {
    isSnapshotStale as isSnapshotStaleImpl,
    readContentIfSnapshotHashMatches as readContentIfSnapshotHashMatchesImpl,
} from './snapshot-validation.mjs';

export function readTextForSnapshotCheck(fullPath, cache = null, st = null) {
    let statForRawCache = st;
    const getCachedRaw = () => {
        try {
            if (!statForRawCache) statForRawCache = statSync(fullPath);
            return rawContentCacheGet(fullPath, statForRawCache);
        } catch {
            return null;
        }
    };
    if (cache && typeof cache.readTextSync === 'function') {
        const entry = typeof cache.getEntry === 'function' ? cache.getEntry(fullPath) : null;
        if (typeof entry?.content === 'string') return entry.content;
        if (!Buffer.isBuffer(entry?.rawBuf) && typeof cache.seedBuffer === 'function') {
            const cachedRaw = getCachedRaw();
            if (cachedRaw) cache.seedBuffer(fullPath, cachedRaw);
        }
        return cache.readTextSync(fullPath);
    }
    if (cache && typeof cache.content === 'string' && Buffer.isBuffer(cache.rawBuf)) {
        return cache.content;
    }
    const cachedRaw = getCachedRaw();
    const rawBuf = cachedRaw || readFileSync(fullPath);
    const content = decodeRawBufferForSnapshotCheck(rawBuf);
    if (cache) {
        cache.rawBuf = rawBuf;
        cache.content = content;
    }
    if (!cachedRaw && statForRawCache) rawContentCacheSet(fullPath, statForRawCache, rawBuf);
    return content;
}

export function recordReadSnapshot(fullPath, st, scope = null, meta = {}) {
    const readFiles = readFilesForScope(scope);
    let mtimeMs;
    let ctimeMs;
    let size;
    try {
        if (st && typeof st.mtimeMs === 'number') {
            mtimeMs = st.mtimeMs;
            ctimeMs = st.ctimeMs;
            size = st.size;
        } else {
            const fresh = statSync(fullPath);
            mtimeMs = fresh.mtimeMs;
            ctimeMs = fresh.ctimeMs;
            size = fresh.size;
        }
    } catch {
        mtimeMs = Date.now();
        ctimeMs = mtimeMs;
        size = 0;
    }
    const incomingRanges = Array.isArray(meta.ranges)
        ? meta.ranges
        : [{ startLine: 1, endLine: Infinity }];
    const replaceExisting = meta.replaceExisting === true;
    const existing = replaceExisting ? null : readFiles.get(fullPath);
    const sameFile = existing
        && statMatchesSnapshot({ mtimeMs, ctimeMs, size }, existing)
        && Array.isArray(existing.ranges);
    const merged = sameFile
        ? mergeReadRanges([...existing.ranges, ...incomingRanges])
        : mergeReadRanges(incomingRanges);
    // fileLineCount is omitted here so it can ONLY be set via the explicit
    // guard below (which excludes source==='read_batch_sliced'); otherwise a
    // caller passing fileLineCount with a batch source would leak it through
    // restMeta and bypass the fail-closed batch path.
    const { ranges: _omitRanges, rangeHash: _omitRangeHash, rangeHashes: _omitRangeHashes, replaceExisting: _omitReplaceExisting, fileLineCount: _omitFileLineCount, ...restMeta } = meta;
    const next = { ...restMeta, mtimeMs, ctimeMs, size, ranges: merged };
    if (!next.contentHash && sameFile && existing.contentHash) {
        next.contentHash = existing.contentHash;
    }
    // Provenance: a snapshot is "grep-only" while EVERY contributing read was a
    // single-file grep (match lines only, never the whole file). Any real
    // read/edit/write clears it permanently. NOTE: grepOnly does not itself gate
    // edits or overwrites — the write-overwrite gate keys on full-file PROOF
    // (contentHash + full coverage), which a single-file grep snapshot acquires
    // via the auto-hash below, so grep satisfies BOTH the edit gate and the
    // write-overwrite gate; grepOnly only tailors the code-10 message when proof
    // is absent. Sticky across merges in both orders: read→grep keeps it false
    // (existing.grepOnly === false wins), and grep→read rebuilds it false
    // because a read uses replaceExisting.
    const incomingIsGrep = meta.source === 'grep';
    next.grepOnly = incomingIsGrep && (sameFile ? existing.grepOnly === true : true);
    const rangeHashRows = [];
    if (sameFile && Array.isArray(existing.rangeHashes)) {
        for (const row of existing.rangeHashes) {
            const nextRow = normaliseRangeHashEntry(row);
            if (nextRow) rangeHashRows.push(nextRow);
        }
    } else if (sameFile && existing.rangeHash && Array.isArray(existing.ranges) && existing.ranges.length === 1) {
        const nextRow = normaliseRangeHashEntry({ ...existing.ranges[0], hash: existing.rangeHash });
        if (nextRow) rangeHashRows.push(nextRow);
    }
    if (meta.rangeHash && Array.isArray(meta.ranges) && meta.ranges.length === 1) {
        const nextRow = normaliseRangeHashEntry({ ...meta.ranges[0], hash: meta.rangeHash });
        if (nextRow) rangeHashRows.push(nextRow);
    }
    if (Array.isArray(meta.rangeHashes)) {
        for (const row of meta.rangeHashes) {
            const nextRow = normaliseRangeHashEntry(row);
            if (nextRow) rangeHashRows.push(nextRow);
        }
    }
    if (!next.contentHash && snapshotCoversFullFile(next)) {
        try {
            const content = decodeRawBufferForSnapshotCheck(readFileSync(fullPath));
            next.contentHash = hashText(content);
        } catch {}
    }
    if (!next.contentHash && !snapshotCoversFullFile(next) && rangeHashRows.length > 0) {
        const seen = new Set();
        next.rangeHashes = rangeHashRows.filter((row) => {
            const key = `${row.startLine}:${row.endLine}:${row.hash}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
    const batchSliced = meta.source === 'read_batch_sliced';
    if (!batchSliced && Number.isFinite(meta.fileLineCount) && meta.fileLineCount >= 0) {
        next.fileLineCount = Math.trunc(meta.fileLineCount);
    } else if (!batchSliced && sameFile && Number.isFinite(existing?.fileLineCount) && existing.fileLineCount >= 0) {
        next.fileLineCount = Math.trunc(existing.fileLineCount);
    }
    readFiles.set(fullPath, next);
    scheduleScopePersist(readScopeKey(scope));
}

export function getReadSnapshot(fullPath, scope = null) {
    return readFilesForScope(scope).get(fullPath);
}

export function isSnapshotStale(stat, snapshot, fullPath = '', readCache = null) {
    return isSnapshotStaleImpl(stat, snapshot, {
        fullPath,
        readCache,
        readTextForSnapshotCheck,
    });
}

export function readContentIfSnapshotHashMatches(fullPath, snapshot, readCache = null, st = null) {
    return readContentIfSnapshotHashMatchesImpl(fullPath, snapshot, {
        readCache,
        st,
        readTextForSnapshotCheck,
    });
}
