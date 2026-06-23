// Render the first `n` chars of a string as `"<glyph>" U+XXXX` units so
// invisible / look-alike chars surface in a single glance from a
// match-failure hint, without needing a separate hex dumper.
export function renderCodepointPreview(str, n) {
    const arr = Array.from(String(str || '').slice(0, n * 2)).slice(0, n);
    return arr.map((ch) => {
        const cp = ch.codePointAt(0);
        const hex = cp.toString(16).toUpperCase().padStart(4, '0');
        const glyph = (cp >= 0x20 && cp !== 0x7f) ? ch : ' ';
        return `"${glyph}" U+${hex}`;
    }).join(' | ');
}

// Compare two strings char-by-char (codepoint-aware) and return the
// first divergence, or null if oldStr is a prefix of sliceStr.
export function firstDivergence(oldStr, sliceStr) {
    const a = Array.from(String(oldStr || ''));
    const b = Array.from(String(sliceStr || ''));
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        if (a[i] !== b[i]) {
            return { index: i, expected: a[i], found: b[i] };
        }
    }
    if (a.length > b.length) return { index: b.length, expected: a[b.length], found: '<eol>' };
    return null;
}

// 1-based {line, col} for a UTF-16 code-unit `index` into `content`. Used by
// failure diagnostics so misses report a file coordinate, not a raw offset.
export function indexToLineCol(content, index) {
    const s = String(content || '');
    const clamped = Math.max(0, Math.min(Number(index) | 0, s.length));
    let line = 1;
    let col = 1;
    for (let i = 0; i < clamped; i++) {
        if (s.charCodeAt(i) === 10) { line++; col = 1; }
        else col++;
    }
    return { line, col };
}

// Invariant-based "closest candidate region" finder: scans every position
// in `content` and returns the one whose common prefix with `oldStr` is
// longest. Ties resolve to the lowest index (earliest in file). Worst case
// O(n*m) but exits at the first divergence per position, so most positions
// cost O(1) when no shared prefix exists. Returns null on empty inputs.
export function bestPrefixWindow(content, oldStr) {
    const s = String(content || '');
    const needle = String(oldStr || '');
    if (!needle || !s) return null;
    const nlen = needle.length;
    const slen = s.length;
    let bestIdx = 0;
    let bestPrefix = -1;
    for (let i = 0; i <= slen; i++) {
        const cap = Math.min(nlen, slen - i);
        let k = 0;
        while (k < cap && s.charCodeAt(i + k) === needle.charCodeAt(k)) k++;
        if (k > bestPrefix) {
            bestPrefix = k;
            bestIdx = i;
            if (k === nlen) break;
        }
    }
    return { index: bestIdx, prefixLen: Math.max(0, bestPrefix) };
}

// Pair `bestPrefixWindow` with `firstDivergence` semantics so callers get
// a complete first-divergence record (window start line/col, divergence
// line/col, expected vs found char, common-prefix length). Returns null
// when there is nothing to compare against.
export function describeFirstDivergence(content, oldStr) {
    const win = bestPrefixWindow(content, oldStr);
    if (!win) return null;
    const s = String(content);
    const needle = String(oldStr);
    const divIndex = win.index + win.prefixLen;
    const expectedCh = win.prefixLen < needle.length ? needle.charAt(win.prefixLen) : '<eol>';
    const foundCh = divIndex < s.length ? s.charAt(divIndex) : '<eol>';
    const start = indexToLineCol(s, win.index);
    const div = indexToLineCol(s, divIndex);
    return {
        windowIndex: win.index,
        startLine: start.line,
        startCol: start.col,
        prefixLen: win.prefixLen,
        line: div.line,
        col: div.col,
        expected: expectedCh,
        found: foundCh,
    };
}

// Per-index batch-peer diagnoser. The multi-edit loop applies edits
// sequentially to an in-memory transaction buffer and aborts atomically
// at `failedIndex`, so labels key off that boundary instead of re-matching
// every edit against the already-mutated content:
//   j <  failedIndex  -> `applied` (matched + applied earlier this txn)
//   j === failedIndex -> `*` + live diagnosis (miss/ambig + diverge point)
//   j >  failedIndex  -> `blocked` (never evaluated; txn aborted first)
// This stops already-applied edits from being mislabeled `miss` once their
// old_string bytes are consumed (the "1 error reads as N failures" fix).
// `findCrlf` is injected to avoid pulling edit-match-utils.mjs (shared
// matcher, off-limits) into this module's import graph.
export function diagnoseBatchPeers(content, edits, failedIndex, findCrlf) {
    if (!Array.isArray(edits) || edits.length === 0) return '';
    const labels = [];
    for (let j = 0; j < edits.length; j++) {
        const tag = j === failedIndex ? `${j}*` : `${j}`;
        const e = edits[j];
        if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') {
            labels.push(`[${tag}]=invalid`); continue;
        }
        // Edits before the failure were already matched + applied to the
        // in-memory transaction content; their old_string bytes are now
        // consumed, so re-matching against the mutated content would
        // mislabel them `miss`. They PASSED — report `applied`, skip re-check.
        if (j < failedIndex) { labels.push(`[${tag}]=applied`); continue; }
        // Edits after the failure were never evaluated: the atomic batch
        // aborts at failedIndex, so their real-turn content differs from this
        // intermediate snapshot and any match here is not authoritative.
        if (j > failedIndex) { labels.push(`[${tag}]=blocked`); continue; }
        const oldStr = e.old_string;
        if (oldStr.length === 0) { labels.push(`[${tag}]=empty`); continue; }
        // Literal occurrence count.
        let cnt = 0;
        let firstIdx = -1;
        {
            let idx = 0;
            while ((idx = content.indexOf(oldStr, idx)) !== -1) {
                if (firstIdx === -1) firstIdx = idx;
                cnt++;
                if (cnt >= 2) break;
                idx += oldStr.length || 1;
            }
        }
        if (cnt === 1) { labels.push(`[${tag}]=ok`); continue; }
        if (cnt > 1) {
            labels.push(e.replace_all === true ? `[${tag}]=ok(replace_all)` : `[${tag}]=ambig(${cnt}+)`);
            continue;
        }
        // CRLF-fold fallback when a matcher is supplied. Keeps the label
        // honest when the only divergence is line endings.
        if (typeof findCrlf === 'function') {
            try {
                const crlf = findCrlf(content, oldStr);
                const crlfCnt = crlf && Array.isArray(crlf.ranges) ? crlf.ranges.length : 0;
                if (crlfCnt === 1) { labels.push(`[${tag}]=ok(crlf-fold)`); continue; }
                if (crlfCnt > 1) {
                    labels.push(e.replace_all === true ? `[${tag}]=ok(crlf-fold,replace_all)` : `[${tag}]=ambig(${crlfCnt},crlf-fold)`);
                    continue;
                }
            } catch {}
        }
        // True miss — report the first divergence point against the closest
        // candidate region so the caller knows which line+col to inspect.
        const div = describeFirstDivergence(content, oldStr);
        if (!div) { labels.push(`[${tag}]=miss`); continue; }
        labels.push(
            `[${tag}]=miss(line ${div.line} col ${div.col}: expected ${renderCharForDiff(div.expected)} got ${renderCharForDiff(div.found)}; common prefix ${div.prefixLen} chars from line ${div.startLine} col ${div.startCol})`
        );
    }
    if (labels.length === 0) return '';
    return `\n  Edits: ${labels.join(' ')}`;
}

function unicodeEscape(ch) {
    const cp = String(ch).codePointAt(0);
    if (!Number.isFinite(cp)) return '';
    return cp <= 0xffff
        ? `\\u${cp.toString(16).padStart(4, '0')}`
        : `\\u{${cp.toString(16)}}`;
}

function shortUtf8Hex(str) {
    const bytes = Buffer.from(String(str), 'utf8');
    const shown = [...bytes.subarray(0, 24)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
    return bytes.length > 24 ? `${shown} ...` : shown;
}

export function editNeedleEncodingNote(content, oldStr) {
    const old = String(oldStr || '');
    if (!old) return '';
    const interesting = Array.from(old).find((ch) => {
        const cp = ch.codePointAt(0);
        return cp > 0x7e || (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d);
    });
    if (!interesting) return '';
    const esc = unicodeEscape(interesting);
    const lower = esc.toLowerCase();
    const upper = esc.toUpperCase().replace('\\U', '\\u');
    const fileHasLiteralEscape = String(content || '').includes(lower) || String(content || '').includes(upper);
    const suffix = fileHasLiteralEscape ? `; file contains literal escape ${lower}` : '';
    return `\n  old_string decoded char ${renderCharForDiff(interesting)} utf8=[${shortUtf8Hex(interesting)}] escape=${lower}${suffix}`;
}

// Render a single divergence char (or the '<eol>' sentinel) as a compact
// `"<glyph>" U+XXXX` token. Used by both the per-edit miss labels and the
// nearest-match diverge line so output stays consistent.
export function renderCharForDiff(ch) {
    if (ch === undefined || ch === null || ch === '<eol>') return '"⏎" U+000A';
    const s = String(ch);
    if (s.length === 0) return '"⏎" U+000A';
    const cp = s.codePointAt(0);
    const hex = cp.toString(16).toUpperCase().padStart(4, '0');
    const visible = (cp >= 0x20 && cp !== 0x7f) ? s : ' ';
    return `"${visible}" U+${hex}`;
}
