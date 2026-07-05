import { hashText } from './hash-utils.mjs';

/** Mirrors read-single-tool.mjs detectReadEncoding (BOM-only, no sniffing). */
export function detectReadEncodingFromBuffer(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 2) {
        return { encoding: 'utf8', bomLen: 0 };
    }
    if (buf[0] === 0xff && buf[1] === 0xfe) {
        return { encoding: 'utf16le', bomLen: 2 };
    }
    if (buf[0] === 0xfe && buf[1] === 0xff) {
        return { encoding: 'utf16be', bomLen: 2 };
    }
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return { encoding: 'utf8', bomLen: 3 };
    }
    return { encoding: 'utf8', bomLen: 0 };
}

/** Decode on-disk bytes the same way as a full read (for snapshot hash / stale checks). */
export function decodeRawBufferForSnapshotCheck(rawBuf) {
    const enc = detectReadEncodingFromBuffer(rawBuf);
    // Strip the BOM for BOTH encodings (bomLen is 0 when absent, so non-BOM
    // utf8 is unchanged). The read path hashes BOM-stripped content; a utf8 BOM
    // left in here produced a hash mismatch and false "modified since read".
    if (enc.encoding === 'utf16le') {
        return rawBuf.subarray(enc.bomLen).toString('utf16le');
    }
    if (enc.encoding === 'utf16be') {
        // No Node 'utf16be' encoding: swap pairs to LE (even length) then decode.
        const body = rawBuf.subarray(enc.bomLen);
        const even = body.length & ~1;
        return Buffer.from(body.subarray(0, even)).swap16().toString('utf16le');
    }
    return rawBuf.subarray(enc.bomLen).toString('utf-8');
}

export function rangeHashesForReadRanges(content, ranges) {
    const rows = Array.isArray(ranges) ? ranges : [];
    if (rows.length === 0) return [];
    // Split CRLF-insensitively: streaming reads strip a trailing \r per
    // line before hashing (read-streaming.mjs), so the regular path and
    // snapshot validation must normalise \r the same way or CRLF files
    // produce mismatched rangeHashes (false "modified since read").
    const lines = String(content ?? '').split(/\r?\n/);
    const out = [];
    for (const range of rows) {
        if (!range) continue;
        const startLine = Math.max(1, Number(range.startLine));
        const endLine = range.endLine === Infinity ? Infinity : Number(range.endLine);
        if (!Number.isFinite(startLine) || (!Number.isFinite(endLine) && endLine !== Infinity)) continue;
        if (endLine !== Infinity && endLine < startLine) continue;
        const startIdx = startLine - 1;
        const endIdx = endLine === Infinity ? lines.length : Math.min(lines.length, endLine);
        out.push({ startLine, endLine, hash: hashText(lines.slice(startIdx, endIdx).join('\n')) });
    }
    return out;
}

export function rangeHashesFromRenderedReadText(rendered, ranges) {
    const rows = Array.isArray(ranges) ? ranges : [];
    if (rows.length === 0) return [];
    const byLine = new Map();
    for (const line of String(rendered ?? '').split('\n')) {
        const m = /^(\d+)[\t│→]/.exec(line);
        if (!m) continue;
        byLine.set(Number(m[1]), line.slice(m[0].length));
    }
    const out = [];
    for (const range of rows) {
        if (!range) continue;
        const startLine = Math.max(1, Number(range.startLine));
        const endLine = range.endLine === Infinity ? Infinity : Number(range.endLine);
        if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || endLine < startLine) continue;
        const lines = [];
        let complete = true;
        for (let lineNo = startLine; lineNo <= endLine; lineNo++) {
            if (!byLine.has(lineNo)) { complete = false; break; }
            lines.push(byLine.get(lineNo));
        }
        if (complete) out.push({ startLine, endLine, hash: hashText(lines.join('\n')) });
    }
    return out;
}

export function statMatchesSnapshot(stat, snapshot) {
    if (!stat || !snapshot) return false;
    if (typeof snapshot.size !== 'number' || stat.size !== snapshot.size) return false;
    if (!Number.isFinite(snapshot.mtimeMs) || Math.abs(stat.mtimeMs - snapshot.mtimeMs) > 1) {
        return false;
    }
    if (Number.isFinite(snapshot.ctimeMs)) {
        if (!Number.isFinite(stat.ctimeMs) || Math.abs(stat.ctimeMs - snapshot.ctimeMs) > 1) {
            return false;
        }
    }
    return true;
}

export function normaliseRangeHashEntry(row) {
    if (!row || typeof row.hash !== 'string' || !row.hash) return null;
    const startLine = Math.max(1, Number(row.startLine));
    const endLine = row.endLine === Infinity ? Infinity : Number(row.endLine);
    if (!Number.isFinite(startLine) || (!Number.isFinite(endLine) && endLine !== Infinity)) return null;
    if (endLine !== Infinity && endLine < startLine) return null;
    return { startLine, endLine, hash: row.hash };
}

export function snapshotCoversFullFile(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.ranges)) return false;
    return snapshot.ranges.some((r) => r.startLine <= 1 && r.endLine === Infinity);
}

/** Logical line count captured at read-time (wc-l compatible). Undefined if absent. */
export function snapshotFileLineCount(snapshot) {
    const n = snapshot?.fileLineCount;
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;
}

// Finite full-coverage check. A single full-file read records the
// {1, Infinity} sentinel (snapshotCoversFullFile), but a large file is
// output-capped so isFullFileView never fires and only finite ranges are
// recorded. Paging through the whole file then yields contiguous finite
// ranges that still cover every line — recognise that as full coverage so
// overwrite isn't permanently blocked. Caller passes the file's current
// line count; invariant: covered iff merged ranges span [1, lineCount].
export function snapshotRangesCoverAllLines(snapshot, lineCount) {
    if (!snapshot || !Array.isArray(snapshot.ranges) || snapshot.ranges.length === 0) return false;
    if (!(lineCount > 0)) return true;
    const ranges = snapshot.ranges
        .map((r) => ({
            s: Math.max(1, Number(r.startLine) || 1),
            e: r.endLine === Infinity ? lineCount : Math.min(lineCount, Number(r.endLine) || 0),
        }))
        .filter((r) => r.e >= r.s)
        .sort((a, b) => a.s - b.s);
    let covered = 0;
    for (const r of ranges) {
        if (r.s > covered + 1) break;
        if (r.e > covered) covered = r.e;
    }
    return covered >= lineCount;
}
