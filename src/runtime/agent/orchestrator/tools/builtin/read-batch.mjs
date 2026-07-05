import { READ_BATCH_RANGE_COALESCE_GAP_LINES } from './read-constants.mjs';

// Slices a `read` body (full mode) to the line window [origOffset+1,
// origOffset+origLimit] (1-based line numbers in the body). Lines whose
// leading `^(\d+)│` prefix falls outside the window are dropped; the
// footer line is rebuilt to reflect the new range.
export function sliceReadBodyByLines(body, origOffset, origLimit) {
    if (typeof body !== 'string') return body;
    const off = typeof origOffset === 'number' ? origOffset : 0;
    // limit:0 = unlimited (matches single-form parseLineLimitArg invariant)
    const lim = typeof origLimit === 'number' && origLimit !== 0 ? origLimit : (origLimit === 0 ? Infinity : 2000);
    const firstLine = off + 1;        // 1-based inclusive
    const lastLine  = off + lim;      // 1-based inclusive
    const lines = body.split('\n');
    const kept = [];
    let footerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('[lines ') || line.startsWith('[read complete')) {
            footerIdx = i;
            continue;
        }
        const m = /^(\d+)[\t│→]/.exec(line);
        if (m) {
            const ln = parseInt(m[1], 10);
            if (ln >= firstLine && ln <= lastLine) kept.push(line);
        } else if (kept.length === 0 && footerIdx === -1) {
            kept.push(line);
        }
    }
    // Mirror the scalar read footer shape — only emit finite hints.
    // `of ?` / `pass offset:Infinity to continue` is noise that
    // confuses the caller; drop those fields when totals are unknown
    // or the slice is unbounded (limit:0/Infinity).
    const totalLine = footerIdx >= 0 ? lines[footerIdx] : '';
    const totalM = /of (\d+)/.exec(totalLine);
    const totalNum = totalM ? parseInt(totalM[1], 10) : NaN;
    const haveTotal = Number.isFinite(totalNum);
    const finiteLast = Number.isFinite(lastLine);
    const emittedLast = haveTotal && finiteLast
        ? Math.min(lastLine, totalNum)
        : (finiteLast ? lastLine : (kept.length > 0
            ? (() => {
                // Read the last kept line's number prefix.
                const lastKept = kept[kept.length - 1];
                const km = /^(\d+)[\t│→]/.exec(lastKept);
                return km ? parseInt(km[1], 10) : firstLine;
            })()
            : firstLine));
    const totalPart = haveTotal ? ` of ${totalNum}` : '';
    const moreToRead = haveTotal ? emittedLast < totalNum : finiteLast;
    // Anti-fragmentation: modest remainders get the exact one-window
    // continuation (offset+limit) instead of an open-ended "continue".
    const _remaining = haveTotal ? totalNum - emittedLast : null;
    const continuationPart = moreToRead && Number.isFinite(emittedLast)
        ? (_remaining !== null && _remaining > 0 && _remaining <= 600
            ? `; ${_remaining} lines left — take the rest in ONE window: offset:${emittedLast}, limit:${_remaining}`
            : `; pass offset:${emittedLast} to continue`)
        : '';
    const newFooter = `[lines ${firstLine}-${emittedLast}${totalPart}${continuationPart}]`;
    return kept.join('\n') + (kept.length ? '\n' : '') + newFooter;
}

export function isFullModeReadEntry(entry) {
    return !entry?.mode || entry.mode === 'full';
}

/** Caller omitted offset/limit — must use standalone read shaping, not union slice. */
function entryIsImplicitDefaultRead(entry) {
    return typeof entry?.limit !== 'number' && typeof entry?.offset !== 'number';
}

export function readEntryLineWindow(entry) {
    const offset = typeof entry.offset === 'number' && Number.isFinite(entry.offset)
        ? Math.max(0, Math.trunc(entry.offset))
        : 0;
    // full:true uncaps the read (read-single-tool wantFull), so the coalescing
    // window must extend to EOF too — otherwise the union read is capped at the
    // default 2000 lines while the entry actually reads the whole file, and the
    // per-window slice returns truncated/empty results.
    const limit = entry.full === true
        ? Infinity
        : (typeof entry.limit === 'number'
            ? (entry.limit === 0 ? Infinity : Math.max(1, Math.trunc(entry.limit)))
            : 2000);
    return {
        offset,
        end: limit === Infinity ? Infinity : offset + limit,
    };
}

export function coalesceObjectReadEntries(rawEntries) {
    const out = new Array(rawEntries.length);
    const groups = new Map();
    for (let i = 0; i < rawEntries.length; i++) {
        const entry = rawEntries[i];
        if (!isFullModeReadEntry(entry)) {
            out[i] = entry;
            continue;
        }
        const win = readEntryLineWindow(entry);
        const key = entry.path || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ index: i, entry, offset: win.offset, end: win.end });
    }
    for (const items of groups.values()) {
        items.sort((a, b) => {
            if (a.offset !== b.offset) return a.offset - b.offset;
            if (a.end === b.end) return 0;
            if (a.end === Infinity) return 1;
            if (b.end === Infinity) return -1;
            return a.end - b.end;
        });
        const clusters = [];
        let current = null;
        for (const item of items) {
            const itemImplicit = entryIsImplicitDefaultRead(item.entry);
            const itemExplicit = !itemImplicit;
            const canMerge = current
                && (current.end === Infinity || item.offset <= current.end + READ_BATCH_RANGE_COALESCE_GAP_LINES)
                && !(current.hasImplicit && itemExplicit)
                && !(itemImplicit && current.hasExplicit)
                && !(itemImplicit && current.hasImplicit);
            if (!canMerge) {
                current = {
                    offset: item.offset,
                    end: item.end,
                    items: [item],
                    hasImplicit: itemImplicit,
                    hasExplicit: itemExplicit,
                };
                clusters.push(current);
                continue;
            }
            current.items.push(item);
            current.hasImplicit = current.hasImplicit || itemImplicit;
            current.hasExplicit = current.hasExplicit || itemExplicit;
            if (current.end !== Infinity) current.end = item.end === Infinity ? Infinity : Math.max(current.end, item.end);
        }
        for (const cluster of clusters) {
            if (cluster.items.length === 1) {
                const item = cluster.items[0];
                out[item.index] = item.entry;
                continue;
            }
            const unionLimit = cluster.end === Infinity ? 0 : cluster.end - cluster.offset;
            for (const item of cluster.items) {
                const entryOffset = typeof item.entry.offset === 'number' && Number.isFinite(item.entry.offset)
                    ? Math.max(0, Math.trunc(item.entry.offset))
                    : item.offset;
                const entryLimit = typeof item.entry.limit === 'number'
                    ? item.entry.limit
                    : (item.end === Infinity ? 0 : Math.max(1, item.end - item.offset));
                out[item.index] = {
                    ...item.entry,
                    offset: entryOffset,
                    limit: entryLimit,
                    _unionOffset: cluster.offset,
                    _unionLimit: unionLimit,
                    _needsPerEntrySlice: true,
                    _origOffset: item.entry.offset,
                    _origLimit: item.entry.limit,
                };
            }
        }
    }
    return out;
}

/** Disk-read window when batch coalescing merged nearby ranges. */
export function readEntryCoalescedDiskWindow(entry) {
    if (!entry || entry._unionOffset === undefined) return null;
    return {
        offset: entry._unionOffset,
        limit: entry._unionLimit,
    };
}
