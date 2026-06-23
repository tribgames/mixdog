import { mergeReadRanges } from './read-ranges.mjs';

export const SMART_READ_MAX_BYTES = 30 * 1024;
export const SMART_READ_MAX_LINES = 600;
export const SMART_READ_HEAD_LINES = 200;
export const SMART_READ_TAIL_LINES = 100;
// Only the genuinely large full reads warrant the anti-re-read advisory; below
// this the smart-truncate path (30 KB) already caps normal reads, so a 16 KB
// floor mostly fired on full:true mid-size reads where the advisory was pure
// tail bloat. Raised to 40 KB to keep the guidance only where re-reading a big
// file actually hurts.
export const READ_CONTEXT_ADVISORY_BYTES = 40 * 1024;
export const READ_MAX_RENDERED_LINE_CHARS = 2_000;
// Claude-Code parity: the read line-prefix separator is `→` (the `→`
// arrow), matching Claude Code's default cat -n format `<n>→<content>`. It
// MUST be a NON-WHITESPACE glyph: a tab/space separator collides with the
// content's own leading indentation, so a model hand-reconstructing an edit
// old_string cannot tell the separator from the indent and produces
// byte-mismatched anchors (grep finds the substring, edit cannot). All
// read/edit parsers accept `[\t│→]`, so any in-flight tab/pipe-rendered
// output stays backward-compatible.
export const LINE_NO_SEP = '→';

export function buildSmartReadTruncationMarker(totalLines, fileBytes, _filePath = '') {
    const kb = Math.max(1, Math.round((Number(fileBytes) || 0) / 1024));
    return `... [TRUNCATED - ${totalLines} lines / ${kb} KB] ...`;
}

function rangeFromRenderedReadRows(rows, fallbackStartLine = 1) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const nums = [];
    for (const row of rows) {
        const m = /^(\d+)[\t│→]/.exec(String(row));
        if (m) nums.push(Number(m[1]));
    }
    if (nums.length > 0) {
        return { startLine: Math.min(...nums), endLine: Math.max(...nums) };
    }
    return {
        startLine: Math.max(1, Number(fallbackStartLine) || 1),
        endLine: Math.max(1, (Number(fallbackStartLine) || 1) + rows.length - 1),
    };
}

// Optional `budget` { maxLines, headLines, tailLines } lets a caller request a
// TIGHTER head+tail elision than the 600-line / 200+100 default (e.g. read
// budget:'compact' or max_lines:N) to bound lead-context cost. Omitted -> the
// standard caps, so existing 4-arg callers are byte-for-byte unchanged.
export function smartReadTruncate(renderedWithLineNos, totalLines, fileBytes, filePath = '', budget = null) {
    const maxLines = budget?.maxLines ?? SMART_READ_MAX_LINES;
    const headLines = budget?.headLines ?? SMART_READ_HEAD_LINES;
    const tailLines = budget?.tailLines ?? SMART_READ_TAIL_LINES;
    const overByBytes = fileBytes > SMART_READ_MAX_BYTES;
    const overByLines = totalLines > maxLines;
    if (!overByBytes && !overByLines) {
        return { text: renderedWithLineNos, truncated: false, totalLines, ranges: null };
    }
    const rows = renderedWithLineNos.split('\n');
    const headCount = Math.min(headLines, rows.length);
    const tailStart = Math.max(headCount, rows.length - tailLines);
    const elidedRows = tailStart - headCount;
    if (elidedRows <= 0) {
        return { text: renderedWithLineNos, truncated: false, totalLines, ranges: null };
    }
    const headRows = rows.slice(0, headCount);
    const tailRows = rows.slice(tailStart);
    const head = headRows.join('\n');
    const tail = tailRows.join('\n');
    const marker = buildSmartReadTruncationMarker(totalLines, fileBytes, filePath);
    return {
        text: `${head}\n${marker}\n${tail}`,
        truncated: true,
        totalLines,
        ranges: mergeReadRanges([
            rangeFromRenderedReadRows(headRows, 1),
            rangeFromRenderedReadRows(tailRows, tailStart + 1),
        ].filter(Boolean)),
    };
}

export function appendReadContextAdvisory(out, { filePath: _filePath, lineCount: _lineCount, bytes: _bytes }) {
    return out;
}

export function formatPaginationHint(remaining, nextOffset) {
    const n = Number(remaining);
    const label = Number.isFinite(n) && n > 0 ? `${n} more entries` : 'more entries';
    return `... [${label}; next offset: ${nextOffset}]`;
}

export function parseOffsetArg(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export function parseLineLimitArg(value, defaultValue) {
    const n = Number(value);
    if (!Number.isFinite(n)) return defaultValue;
    if (n === 0) return Infinity;
    return Math.max(1, Math.trunc(n));
}

export function truncateReadLineText(line, { truncateLongLine = true } = {}) {
    let text = String(line ?? '');
    const originalLength = text.length;
    if (truncateLongLine && text.length > READ_MAX_RENDERED_LINE_CHARS) {
        const cps = [...text];
        const head = cps.slice(0, 1_500).join('');
        const tail = cps.slice(-300).join('');
        text = `${head} ... [line truncated: ${originalLength} chars total] ... ${tail}`;
    }
    return text;
}

export function renderReadLine(lineNo, line, { truncateLongLine = true } = {}) {
    const text = truncateReadLineText(line, { truncateLongLine });
    return `${lineNo}${LINE_NO_SEP}${text}`;
}
