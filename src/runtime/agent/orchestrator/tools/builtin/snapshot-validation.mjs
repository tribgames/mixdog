import { hashText } from './hash-utils.mjs';
import {
    normaliseRangeHashEntry,
    statMatchesSnapshot,
} from './snapshot-helpers.mjs';

function snapshotRangeHashRows(snapshot) {
    return Array.isArray(snapshot?.rangeHashes)
        ? snapshot.rangeHashes
        : (snapshot?.rangeHash && Array.isArray(snapshot.ranges) && snapshot.ranges.length > 0
            ? [{ ...snapshot.ranges[0], hash: snapshot.rangeHash }]
            : []);
}

export function isSnapshotStale(stat, snapshot, { fullPath = '', readCache = null, readTextForSnapshotCheck } = {}) {
    // Unified structure (mirrors edit's validatePreparedEditBase):
    // stat-match FIRST → fail-closed-on-no-material → hash-verify.
    // Fast-path: a full stat match (size + mtime±1 + ctime±1) ⇒ untouched
    // → not stale, accept without reading. statMatchesSnapshot returns
    // false on a missing/incomplete snapshot, so those fall through (no
    // fail-open). Tradeoff (accepted policy): a size-preserving write that
    // ALSO restores mtime AND ctime is not caught — vanishingly rare,
    // ctime is not userland-settable on the usual platforms.
    if (statMatchesSnapshot(stat, snapshot)) return false;
    // Stat drifted (or incomplete snapshot) → content hash is the gate.
    const rangeHashRows = snapshotRangeHashRows(snapshot);
    const hasHashMaterial = !!snapshot.contentHash || rangeHashRows.length > 0;
    // Fail-closed: no integrity material AND stat already drifted ⇒ cannot
    // verify against current bytes, treat as stale (force re-read).
    if (!hasHashMaterial) return true;
    const canReadContent = fullPath && typeof readTextForSnapshotCheck === 'function';
    if (!canReadContent) return true;
    // Refresh the snapshot's stat fields to the live values once the hash
    // confirms bytes are identical — silences future false positives for
    // the same mtime-only churn.
    const refreshSnapshotStat = () => {
        if (Number.isFinite(stat.mtimeMs)) snapshot.mtimeMs = stat.mtimeMs;
        if (typeof stat.size === 'number') snapshot.size = stat.size;
        if (Number.isFinite(stat.ctimeMs)) snapshot.ctimeMs = stat.ctimeMs;
    };
    if (snapshot.contentHash) {
        try {
            const cur = readTextForSnapshotCheck(fullPath, readCache, stat);
            if (hashText(cur) !== snapshot.contentHash) return true;
            refreshSnapshotStat();
            return false;
        } catch {
            // Unreadable / stat race — cannot verify, treat as stale.
            return true;
        }
    }
    // rangeHashes-only path (paged reads).
    try {
        const raw = readTextForSnapshotCheck(fullPath, readCache, stat);
        const lines = raw.split(/\r?\n/);
        let verified = 0;
        for (const row of rangeHashRows) {
            const r = normaliseRangeHashEntry(row);
            if (!r) continue;
            const startIdx = Math.max(0, (r.startLine || 1) - 1);
            const endIdx = r.endLine === Infinity ? lines.length : Math.min(lines.length, r.endLine);
            const rangeText = lines.slice(startIdx, endIdx).join('\n');
            if (hashText(rangeText) !== r.hash) return true;
            verified++;
        }
        // Fail-closed: rangeHashes present but no row could be verified
        // (all malformed) ⇒ cannot prove identity, treat as stale.
        if (verified === 0) return true;
        refreshSnapshotStat();
        return false;
    } catch {
        return true;
    }
}

export function readContentIfSnapshotHashMatches(fullPath, snapshot, { readCache = null, st = null, readTextForSnapshotCheck } = {}) {
    if (!snapshot || typeof readTextForSnapshotCheck !== 'function') return null;
    try {
        const content = readTextForSnapshotCheck(fullPath, readCache, st);
        if (snapshot.contentHash) {
            return hashText(content) === snapshot.contentHash ? content : null;
        }
        const rangeHashRows = snapshotRangeHashRows(snapshot);
        if (rangeHashRows.length === 0) return null;
        const lines = content.split(/\r?\n/);
        for (const row of rangeHashRows) {
            const r = normaliseRangeHashEntry(row);
            if (!r) return null;
            const startIdx = Math.max(0, (r.startLine || 1) - 1);
            const endIdx = r.endLine === Infinity ? lines.length : Math.min(lines.length, r.endLine);
            const rangeText = lines.slice(startIdx, endIdx).join('\n');
            if (hashText(rangeText) !== r.hash) return null;
        }
        return content;
    } catch {
        return null;
    }
}
