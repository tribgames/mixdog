import { mergeReadRanges } from './read-ranges.mjs';
import { TOOL_OUTPUT_MAX_BYTES } from './tool-output-limit.mjs';

// Smart-truncate cap: a no-window read returns the file until this cap, past
// which head+tail are shown and the model pages the rest with offset (footer
// says how). Byte budget is the shared TOOL_OUTPUT_MAX_BYTES; line/head/tail
// stay read-specific. Env-overridable for bench: MIXDOG_READ_MAX_LINES/_HEAD/_TAIL.
function _readEnvInt(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}
export const SMART_READ_MAX_BYTES = TOOL_OUTPUT_MAX_BYTES;
export const SMART_READ_MAX_LINES = _readEnvInt('MIXDOG_READ_MAX_LINES', 2000);
export const SMART_READ_HEAD_LINES = _readEnvInt('MIXDOG_READ_HEAD_LINES', 1200);
export const SMART_READ_TAIL_LINES = _readEnvInt('MIXDOG_READ_TAIL_LINES', 400);
// Only the genuinely large full reads warrant the anti-re-read advisory; below
// this the smart-truncate path (30 KB) already caps normal reads, so a 16 KB
// floor mostly fired on full:true mid-size reads where the advisory was pure
// tail bloat. Raised to 40 KB to keep the guidance only where re-reading a big
// file actually hurts.
const READ_MAX_RENDERED_LINE_CHARS = 2_000;
// The read line-prefix separator is `→` (the `→`
// arrow), matching default cat -n format `<n>→<content>`. It
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

export function smartReadTruncate(renderedWithLineNos, totalLines, fileBytes, filePath = '') {
    const overByBytes = fileBytes > SMART_READ_MAX_BYTES;
    const overByLines = totalLines > SMART_READ_MAX_LINES;
    if (!overByBytes && !overByLines) {
        return { text: renderedWithLineNos, truncated: false, totalLines, ranges: null };
    }
    const rows = renderedWithLineNos.split('\n');
    const headCount = Math.min(SMART_READ_HEAD_LINES, rows.length);
    const tailStart = Math.max(headCount, rows.length - SMART_READ_TAIL_LINES);
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

function formatPaginationHint(remaining, nextOffset) {
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
