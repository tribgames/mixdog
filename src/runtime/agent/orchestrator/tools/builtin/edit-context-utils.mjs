import { hashText } from './hash-utils.mjs';
import { renderReadLine } from './read-formatting.mjs';
import {
    snapshotCoversFullFile,
    snapshotRangesCoverAllLines,
} from './snapshot-helpers.mjs';

export function countLfInString(value) {
    let n = 0;
    const s = String(value ?? '');
    for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) === 10) n++;
    }
    return n;
}

function normaliseSnapshotRange(r) {
    if (!r) return null;
    const startLine = Math.max(1, Number(r.startLine) || 1);
    const endLine = r.endLine === Infinity ? Infinity : Number(r.endLine);
    if (!Number.isFinite(startLine)) return null;
    if (endLine !== Infinity && (!Number.isFinite(endLine) || endLine < startLine)) return null;
    return { startLine, endLine };
}

function isFullFileSentinelRange(r) {
    return r && r.startLine <= 1 && r.endLine === Infinity;
}

export function lineRangeForSubstring(content, needle, { replaceAll = false } = {}) {
    if (typeof content !== 'string' || typeof needle !== 'string' || needle.length === 0) return null;
    let oldLineCount = 1;
    for (let i = 0; i < needle.length; i++) {
        if (needle.charCodeAt(i) === 10) oldLineCount++;
    }
    // A needle ending in "\n" terminates its last content line rather than
    // starting a new one. Without this, endLine over-counts by 1 and the edit
    // marks the FOLLOWING line as part of its (inclusive) range, mis-shifting
    // snapshot/context ranges. Reviewer-verified: ranges are inclusive
    // end-to-end with no downstream compensation. No effect for needles that
    // do not end in "\n".
    if (needle.endsWith('\n')) oldLineCount--;
    let idx = 0;
    let scanned = 0;
    let lineNo = 1;
    let minStart = Infinity;
    let maxEnd = 0;
    let found = false;
    while ((idx = content.indexOf(needle, idx)) !== -1) {
        for (let i = scanned; i < idx; i++) {
            if (content.charCodeAt(i) === 10) lineNo++;
        }
        scanned = idx;
        const startLine = lineNo;
        const endLine = startLine + oldLineCount - 1;
        minStart = Math.min(minStart, startLine);
        maxEnd = Math.max(maxEnd, endLine);
        found = true;
        idx += needle.length;
        if (!replaceAll) break;
    }
    if (!found) return null;
    return { startLine: minStart, endLine: maxEnd };
}

export function shiftSnapshotRangesForEdit(snapshot, opts = {}) {
    if (!snapshot || !Array.isArray(snapshot.ranges)) return snapshot;
    const lineDelta = Number(opts.lineDelta);
    const delta = Number.isFinite(lineDelta) ? lineDelta : 0;
    const editStart = Number(opts.editStartLine);
    const editEnd = Number(opts.editEndLine);
    const hasSpan = Number.isFinite(editStart) && Number.isFinite(editEnd) && editStart >= 1 && editEnd >= editStart;

    const out = [];
    for (const raw of snapshot.ranges) {
        const r = normaliseSnapshotRange(raw);
        if (!r) continue;
        if (isFullFileSentinelRange(r)) {
            out.push({ startLine: 1, endLine: Infinity });
            continue;
        }
        let { startLine, endLine } = r;
        if (!hasSpan) {
            if (delta !== 0) {
                startLine = Math.max(1, startLine + delta);
                if (endLine !== Infinity) endLine = endLine + delta;
            }
        } else if (endLine !== Infinity && endLine < editStart) {
            // entirely before the edited span
        } else if (startLine > editEnd) {
            startLine = Math.max(1, startLine + delta);
            if (endLine !== Infinity) endLine = endLine + delta;
        } else {
            // overlaps the edited span — keep start, extend/shrink end safely
            if (endLine !== Infinity) {
                endLine = Math.max(startLine, endLine + delta);
            }
        }
        if (endLine !== Infinity && endLine < startLine) continue;
        out.push({ startLine, endLine });
    }
    return { ...snapshot, ranges: out };
}

export function shiftSnapshotRangesByLineDelta(snapshot, lineDelta) {
    return shiftSnapshotRangesForEdit(snapshot, { lineDelta });
}

export function isStrongExactEditTarget(oldStr, stage) {
    const s = String(oldStr ?? '').trim();
    const fuzzy = stage && stage !== 'exact';
    const singleLineMin = fuzzy ? 16 : 32;
    const multiLineMin = fuzzy ? 10 : 20;
    if (s.length >= singleLineMin) return true;
    if (s.includes('\n') && s.length >= multiLineMin) return true;
    return false;
}

function snapshotMetaHasFullCoverage(meta, content) {
    if (!meta || !Array.isArray(meta.ranges)) return false;
    if (snapshotCoversFullFile(meta)) return true;
    const lineCount = String(content ?? '').split(/\r?\n/).length;
    return snapshotRangesCoverAllLines(meta, lineCount);
}

export function postEditSnapshotMeta(prevSnapshot, source, content, opts = {}) {
    const text = Buffer.isBuffer(content) ? content.toString('utf-8') : String(content ?? '');
    let lineDelta = Number(opts.lineDelta);
    if (!Number.isFinite(lineDelta) && opts.contentBeforeEdit != null) {
        const before = Buffer.isBuffer(opts.contentBeforeEdit)
            ? opts.contentBeforeEdit.toString('utf-8')
            : String(opts.contentBeforeEdit ?? '');
        const after = text;
        lineDelta = countLfInString(after) - countLfInString(before);
    }
    if (!Number.isFinite(lineDelta) && opts.oldStr != null && opts.newStr != null) {
        const per = countLfInString(opts.newStr) - countLfInString(opts.oldStr);
        const beforeText = Buffer.isBuffer(opts.contentBeforeEdit)
            ? opts.contentBeforeEdit.toString('utf-8')
            : String(opts.contentBeforeEdit ?? '');
        const occ = opts.replaceAll === true
            ? Math.max(1, countOccurrences(beforeText, opts.oldStr))
            : 1;
        lineDelta = per * occ;
    }
    if (!Number.isFinite(lineDelta)) lineDelta = 0;

    let editStartLine = Number(opts.editStartLine);
    let editEndLine = Number(opts.editEndLine);
    if (!(Number.isFinite(editStartLine) && Number.isFinite(editEndLine)) && typeof opts.oldStr === 'string' && opts.contentBeforeEdit != null) {
        const beforeText = Buffer.isBuffer(opts.contentBeforeEdit)
            ? opts.contentBeforeEdit.toString('utf-8')
            : String(opts.contentBeforeEdit ?? '');
        const span = lineRangeForSubstring(beforeText, opts.oldStr, { replaceAll: opts.replaceAll === true });
        if (span) {
            editStartLine = span.startLine;
            editEndLine = span.endLine;
        }
    }

    const meta = { source };
    if (prevSnapshot && Array.isArray(prevSnapshot.ranges)) {
        if (opts.shiftRanges === false) {
            meta.ranges = prevSnapshot.ranges.map((r) => ({ ...r }));
        } else {
            const shifted = shiftSnapshotRangesForEdit(prevSnapshot, {
                lineDelta,
                editStartLine,
                editEndLine,
            });
            if (shifted && Array.isArray(shifted.ranges)) meta.ranges = shifted.ranges;
        }
    }
    if (snapshotMetaHasFullCoverage(meta, text)) {
        meta.contentHash = hashText(text);
    }
    return meta;
}

export function maybeAutoStripLineNumberPrefixes(oldStr) {
    if (typeof oldStr !== 'string' || oldStr.length === 0) return null;
    if (!/^\s*\d+[\t│→]/.test(oldStr)) return null;
    const lines = oldStr.split('\n');
    const stripped = [];
    for (const ln of lines) {
        const m = ln.match(/^\s*\d+[\t│→](.*)$/);
        if (!m) return null;
        stripped.push(m[1]);
    }
    return stripped.join('\n');
}

export function countOccurrences(haystack, needle) {
    if (typeof needle !== 'string' || needle.length === 0) return 0;
    let count = 0;
    let idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        count++;
        idx += needle.length;
    }
    return count;
}

export function lineContextAround(content, startLine, endLine, radius = 3, maxChars = 1600) {
    const lines = String(content ?? '').split('\n');
    const total = lines.length;
    const start = Math.max(1, Math.min(total, startLine) - radius);
    const end = Math.min(total, Math.max(startLine, endLine) + radius);
    let out = lines
        .slice(start - 1, end)
        .map((line, i) => renderReadLine(start + i, line, { truncateLongLine: false }))
        .join('\n');
    if (out.length > maxChars) {
        const head = out.slice(0, Math.floor(maxChars * 0.6));
        const tail = out.slice(Math.max(0, out.length - Math.floor(maxChars * 0.4)));
        out = `${head}\n... [context middle omitted] ...\n${tail}`;
    }
    return out;
}

export function compactEditContext(content, startLine, endLine, opts = {}) {
    const lines = String(content ?? '').split('\n');
    const total = Math.max(1, lines.length);
    const maxLines = Math.max(1, Math.min(20, Number(opts.maxLines) || 20));
    const targetStart = Math.max(1, Math.min(total, Number(startLine) || 1));
    const targetEnd = Math.max(targetStart, Math.min(total, Number(endLine) || targetStart));
    const targetLines = Math.max(1, targetEnd - targetStart + 1);
    const extra = Math.max(0, maxLines - targetLines);
    let start = Math.max(1, targetStart - Math.floor(extra / 2));
    let end = Math.min(total, start + maxLines - 1);
    start = Math.max(1, Math.min(start, Math.max(1, end - maxLines + 1)));
    const range = { startLine: start, endLine: end };
    const maxLineChars = Math.max(80, Math.min(240, Number(opts.maxLineChars) || 180));
    let text = lines.slice(start - 1, end).map((line, i) => {
        let s = String(line ?? '');
        if (s.length > maxLineChars) s = `${s.slice(0, Math.max(20, maxLineChars - 24))} ... [line truncated]`;
        return renderReadLine(start + i, s, { truncateLongLine: false });
    }).join('\n');
    const maxChars = Math.max(300, Math.min(1800, Number(opts.maxChars) || 1400));
    if (text.length > maxChars) text = `${text.slice(0, maxChars - 28)}\n... [context truncated]`;
    return { range, text };
}