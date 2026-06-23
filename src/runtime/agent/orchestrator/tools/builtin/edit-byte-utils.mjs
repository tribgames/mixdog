import { createHash } from 'crypto';
import { statSync } from 'fs';
import { hashText } from './hash-utils.mjs';
import { statMatchesSnapshot } from './snapshot-helpers.mjs';

export function lineRangesForByteSpans(rawBuf, spans) {
    if (!Buffer.isBuffer(rawBuf) || !Array.isArray(spans) || spans.length === 0) return [];
    const sorted = spans
        .filter((span) => span && Number.isFinite(span.start) && Number.isFinite(span.end) && span.start >= 0 && span.end >= span.start)
        .sort((a, b) => a.start - b.start);
    const out = [];
    let lineNo = 1;
    let scanned = 0;
    for (const span of sorted) {
        const start = Math.min(rawBuf.length, span.start);
        const end = Math.min(rawBuf.length, span.end);
        for (let i = scanned; i < start; i++) {
            if (rawBuf[i] === 10) lineNo++;
        }
        const startLine = lineNo;
        let lineCount = 1;
        for (let i = start; i < end; i++) {
            if (rawBuf[i] === 10) lineCount++;
        }
        for (let i = start; i < end; i++) {
            if (rawBuf[i] === 10) lineNo++;
        }
        scanned = end;
        out.push({ startLine, endLine: startLine + lineCount - 1 });
    }
    return out;
}

export function bufferWithTrailingLf(buf) {
    const out = Buffer.allocUnsafe(buf.length + 1);
    buf.copy(out, 0);
    out[buf.length] = 10;
    return out;
}

export function concatByteReplacements(rawBuf, replacements) {
    const parts = [];
    let cursor = 0;
    let totalLength = 0;
    for (const span of replacements) {
        if (span.start < cursor) return null;
        const before = rawBuf.subarray(cursor, span.start);
        parts.push(before, span.newBytes);
        totalLength += before.length + span.newBytes.length;
        cursor = span.end;
    }
    const tail = rawBuf.subarray(cursor);
    parts.push(tail);
    totalLength += tail.length;
    return Buffer.concat(parts, totalLength);
}

export function hashBytesWithReplacements(rawBuf, replacements) {
    const hasher = createHash('sha256');
    let cursor = 0;
    const sorted = Array.isArray(replacements)
        ? replacements.slice().sort((a, b) => a.start - b.start || a.end - b.end)
        : [];
    for (const span of sorted) {
        if (!span || span.start < cursor || span.end < span.start || !Buffer.isBuffer(span.newBytes)) return hashText(rawBuf);
        hasher.update(rawBuf.subarray(cursor, span.start));
        hasher.update(span.newBytes);
        cursor = span.end;
    }
    hasher.update(rawBuf.subarray(cursor));
    return hasher.digest('hex');
}

export function materialiseByteReplacements(rawBuf, replacements) {
    return concatByteReplacements(rawBuf, replacements);
}

export function partialByteWriteEnabled() {
    return !/^(0|false|no|off|atomic)$/i.test(String(process.env.MIXDOG_EDIT_PARTIAL_WRITE || process.env.MIXDOG_PARTIAL_WRITE || ''));
}

export function captureStableBaseStatSnapshot(fullPath, statHint, rawBuf) {
    if (!fullPath || !statHint || !Buffer.isBuffer(rawBuf)) return null;
    try {
        const postReadStat = statSync(fullPath);
        if (statMatchesSnapshot(postReadStat, statHint) && postReadStat.size === rawBuf.length) {
            return {
                mtimeMs: postReadStat.mtimeMs,
                ctimeMs: postReadStat.ctimeMs,
                size: postReadStat.size,
                ino: Number(postReadStat.ino),
            };
        }
    } catch {}
    return null;
}

/** TOCTOU guard for atomicWrite — same shape as write-tool captureTargetSnapshot. */
export function captureExpectedTargetSnapshot(fullPath, statHint = null) {
    try {
        const st = statHint || statSync(fullPath);
        return {
            exists: true,
            size: st.size,
            mtimeMs: Number(st.mtimeMs),
            ctimeMs: Number(st.ctimeMs),
            ino: Number(st.ino),
        };
    } catch (err) {
        if (err && err.code === 'ENOENT') return { exists: false };
        throw err;
    }
}
