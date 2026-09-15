import { READ_BATCH_RANGE_COALESCE_GAP_LINES } from './read-constants.mjs';

// Slices a `read` body (full mode) to the line window [origOffset+1,
// origOffset+origLimit] (1-based line numbers in the body). Lines whose
// leading `^(\d+)│` prefix falls outside the window are dropped; the
// footer line is rebuilt to reflect the new range.
export function sliceReadBodyByLines(body, origOffset, origLimit, readOffsetBase = 1) {
    if (typeof body !== 'string') return body;
    const off = typeof origOffset === 'number' ? origOffset : 0;
    // limit:0 = unlimited (matches single-form parseLineLimitArg invariant)
    const lim = typeof origLimit === 'number' && origLimit !== 0 ? origLimit : (origLimit === 0 ? Infinity : 2000);
    const firstLine = off + 1;        // 1-based inclusive
    const lastLine  = off + lim;      // 1-based inclusive
    const lines = body.split('\n');
    const kept = [];
    let footerIdx = -1;
    // Coverage of the SOURCE body. A coalesced union read can be cut short
    // (output byte cap), so a later window in the same batch may lie partly or
    // wholly past what was actually returned.
    let minSeen = Infinity;
    let maxSeen = -Infinity;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('[lines ') || line.startsWith('[read complete')) {
            footerIdx = i;
            continue;
        }
        const m = /^(\d+)[\t│→]/.exec(line);
        if (m) {
            const ln = parseInt(m[1], 10);
            if (ln < minSeen) minSeen = ln;
            if (ln > maxSeen) maxSeen = ln;
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
    const sourceCovered = Number.isFinite(maxSeen) && minSeen <= maxSeen;
    // NEVER fabricate a `[lines a-b of N]` footer for a window the body does
    // not contain: the batch parent parses that footer, records the range in
    // the read snapshot and hashes those lines from disk — claiming the
    // session received lines it never saw.
    if (kept.length === 0 && sourceCovered) {
        if (haveTotal && firstLine > totalNum) {
            return `(no lines in range; file has ${totalNum} lines)`;
        }
        const wanted = finiteLast ? `${firstLine}-${lastLine}` : `${firstLine}+`;
        const totalNote = haveTotal ? ` of ${totalNum}` : '';
        const limitNote = finiteLast ? ` limit:${lastLine - firstLine + 1}` : '';
        return `(lines ${wanted} were NOT returned — the coalesced read stopped after covering lines `
            + `${minSeen}-${maxSeen}${totalNote}; re-read this file with offset:${off + readOffsetBase}${limitNote})`;
    }
    // Line numbers actually present in this slice — the footer is derived from
    // them, never from the request alone.
    let keptFirst = null;
    let keptLast = null;
    for (const line of kept) {
        const km = /^(\d+)[\t│→]/.exec(line);
        if (!km) continue;
        const n = parseInt(km[1], 10);
        if (keptFirst === null) keptFirst = n;
        keptLast = n;
    }
    const requestedLast = haveTotal && finiteLast
        ? Math.min(lastLine, totalNum)
        : (finiteLast ? lastLine : (keptLast ?? firstLine));
    const emittedStart = keptFirst ?? firstLine;
    const emittedLast = keptLast !== null ? Math.min(requestedLast, keptLast) : requestedLast;
    const totalPart = haveTotal ? ` of ${totalNum}` : '';
    const moreToRead = haveTotal ? emittedLast < totalNum : finiteLast;
    // Report the next caller coordinate without prescribing another read.
    const continuationPart = moreToRead && Number.isFinite(emittedLast)
        ? `; pass offset:${emittedLast + readOffsetBase} to continue`
        : '';
    const newFooter = `[lines ${emittedStart}-${emittedLast}${totalPart}${continuationPart}]`;
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

export function coalesceObjectReadEntries(rawEntries, resolvePath = null) {
    const out = new Array(rawEntries.length);
    const groups = new Map();
    for (let i = 0; i < rawEntries.length; i++) {
        const entry = rawEntries[i];
        if (!isFullModeReadEntry(entry)) {
            out[i] = entry;
            continue;
        }
        const win = readEntryLineWindow(entry);
        // Group by RESOLVED path so two path strings that point at the same
        // file share one coalesced disk window instead of each opening it.
        const key = (typeof resolvePath === 'function' ? resolvePath(entry.path || '') : (entry.path || ''));
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

/**
 * Merge same-file explicit line windows that overlap into one entry so shared
 * lines render once instead of once per window. Only explicit full-mode
 * windows (numeric offset+limit, not full:true) merge; the merged entry keeps
 * the first member's slot and later members are dropped. Adjacent or gapped
 * windows stay separate — coalesceObjectReadEntries still shares their disk
 * read but slices each back to what was asked.
 */
export function mergeOverlappingReadEntries(rawEntries, resolvePath = null) {
    const isExplicitWindow = (entry) => !!entry
        && !entry._invertedRangeError
        && isFullModeReadEntry(entry)
        && entry.full !== true
        && typeof entry.offset === 'number' && Number.isFinite(entry.offset)
        && typeof entry.limit === 'number' && Number.isFinite(entry.limit) && entry.limit > 0;
    const byPath = new Map();
    for (let i = 0; i < rawEntries.length; i++) {
        const entry = rawEntries[i];
        if (!isExplicitWindow(entry)) continue;
        const key = typeof resolvePath === 'function' ? resolvePath(entry.path || '') : (entry.path || '');
        const offset = Math.max(0, Math.trunc(entry.offset));
        if (!byPath.has(key)) byPath.set(key, []);
        byPath.get(key).push({ index: i, offset, end: offset + Math.max(1, Math.trunc(entry.limit)) });
    }
    const merged = new Map(); // head index → { offset, end }
    const dropped = new Set();
    for (const items of byPath.values()) {
        if (items.length < 2) continue;
        items.sort((a, b) => (a.offset - b.offset) || (a.end - b.end) || (a.index - b.index));
        let run = null;
        const runs = [];
        for (const item of items) {
            if (run && item.offset < run.end) {
                run.end = Math.max(run.end, item.end);
                run.members.push(item.index);
            } else {
                run = { offset: item.offset, end: item.end, members: [item.index] };
                runs.push(run);
            }
        }
        for (const r of runs) {
            if (r.members.length < 2) continue;
            const head = Math.min(...r.members);
            merged.set(head, { offset: r.offset, end: r.end });
            for (const idx of r.members) if (idx !== head) dropped.add(idx);
        }
    }
    if (merged.size === 0) return rawEntries;
    const out = [];
    for (let i = 0; i < rawEntries.length; i++) {
        if (dropped.has(i)) continue;
        const m = merged.get(i);
        out.push(m ? { ...rawEntries[i], offset: m.offset, limit: m.end - m.offset } : rawEntries[i]);
    }
    return out;
}
