import { splitGrepLinePrefix } from '../grep-formatting.mjs';

const GREP_RESULT_LINE_SKIP = /^\[(?:Showing|total|pattern set|capped|warning|redirected|regex parse)/;
const GREP_CHUNK_AGGREGATE_FLOOR = 200;
const GREP_CHUNK_AGGREGATE_DEFAULT = 800;
const GREP_CHUNK_AGGREGATE_MAX = 4000;

export function chunkPatternList(patterns, cap) {
    const out = [];
    for (let i = 0; i < patterns.length; i += cap) out.push(patterns.slice(i, i + cap));
    return out;
}

export function computeGrepChunkAggregateBudget(offset, headLimit, headLimitCoerced) {
    if (headLimitCoerced === 0 && headLimit === Infinity) return GREP_CHUNK_AGGREGATE_MAX;
    if (headLimit === Infinity) return GREP_CHUNK_AGGREGATE_DEFAULT;
    const need = offset + headLimit;
    return Math.min(GREP_CHUNK_AGGREGATE_MAX, Math.max(GREP_CHUNK_AGGREGATE_FLOOR, need * 2));
}

function compareGrepLinesByPathLine(a, b) {
    const pa = splitGrepLinePrefix(a);
    const pb = splitGrepLinePrefix(b);
    if (!pa && !pb) return String(a).localeCompare(String(b));
    if (!pa) return 1;
    if (!pb) return -1;
    const byPath = pa.path.localeCompare(pb.path);
    if (byPath !== 0) return byPath;
    return pa.lineNo - pb.lineNo;
}

function deriveGrepCountLinesFromMatchContent(lines) {
    const byPath = new Map();
    for (const line of lines) {
        const split = splitGrepLinePrefix(line);
        if (!split || split.delimiter !== ':') continue;
        if (!byPath.has(split.path)) byPath.set(split.path, new Set());
        byPath.get(split.path).add(split.lineNo);
    }
    return [...byPath.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([path, lineNos]) => `${path}:${lineNos.size}`);
}

function isGrepMatchLine(line) {
    const split = splitGrepLinePrefix(line);
    return !!(split && split.delimiter === ':');
}

function grepMatchAnchorKey(line) {
    const split = splitGrepLinePrefix(line);
    if (!split || split.delimiter !== ':') return '';
    return `${split.path}\0${split.lineNo}`;
}

function parseGrepContextBlocksInSegment(segmentLines) {
    const blocks = [];
    let pending = [];
    let i = 0;
    while (i < segmentLines.length) {
        const line = segmentLines[i];
        if (isGrepMatchLine(line)) {
            const blockLines = pending.concat([line]);
            pending = [];
            i += 1;
            while (i < segmentLines.length) {
                const next = segmentLines[i];
                if (next === '--' || isGrepMatchLine(next)) break;
                blockLines.push(next);
                i += 1;
            }
            const anchor = grepMatchAnchorKey(line);
            if (anchor) blocks.push({ anchor, lines: blockLines });
            continue;
        }
        pending.push(line);
        i += 1;
    }
    return blocks;
}

function compareGrepAnchorKeys(a, b) {
    const [pa, la] = String(a || '').split('\0');
    const [pb, lb] = String(b || '').split('\0');
    const byPath = pa.localeCompare(pb);
    if (byPath !== 0) return byPath;
    return Number(la) - Number(lb);
}

function mergeGrepContextChunkLines(lines) {
    const segments = [];
    let current = [];
    for (const line of lines) {
        if (line === '--') {
            segments.push(current);
            current = [];
        } else {
            current.push(line);
        }
    }
    segments.push(current);
    const seen = new Set();
    const blocks = [];
    for (const segment of segments) {
        if (!segment.length) continue;
        for (const block of parseGrepContextBlocksInSegment(segment)) {
            if (!block.anchor || seen.has(block.anchor)) continue;
            seen.add(block.anchor);
            blocks.push(block);
        }
    }
    blocks.sort((a, b) => compareGrepAnchorKeys(a.anchor, b.anchor));
    const out = [];
    for (const block of blocks) {
        if (out.length) out.push('--');
        out.push(...block.lines);
    }
    return out;
}

export function mergeGrepChunkLines(lines, { outputMode, beforeN, afterN, contextN }) {
    const hasContext = (beforeN > 0 || afterN > 0 || contextN > 0);
    if (outputMode === 'count') {
        return deriveGrepCountLinesFromMatchContent(lines);
    }
    if (outputMode === 'files_with_matches') {
        const seen = new Set();
        const out = [];
        for (const line of lines) {
            const path = String(line || '').trim();
            if (!path || seen.has(path)) continue;
            seen.add(path);
            out.push(path);
        }
        out.sort((a, b) => a.localeCompare(b));
        return out;
    }
    if (outputMode === 'content' && hasContext) {
        return mergeGrepContextChunkLines(lines);
    }
    const matches = new Map();
    for (const line of lines) {
        const split = splitGrepLinePrefix(line);
        if (split && split.delimiter === ':') {
            const key = `${split.path}\0${split.lineNo}`;
            if (!matches.has(key)) matches.set(key, line);
        }
    }
    return [...matches.values()].sort(compareGrepLinesByPathLine);
}

export function extractGrepChunkResultLines(body, room = Infinity) {
    const text = String(body || '').trim();
    if (!text || /^Error:/i.test(text)) return { error: text || 'Error: empty grep chunk result' };
    if (/^\(no matches\)/i.test(text)) return { lines: [], truncated: false };
    const rawLines = text.split('\n');
    const childShowingTruncated = rawLines.some((line) => /^\[Showing /i.test(String(line || '').trim()));
    const lines = rawLines.filter((line) => line && !GREP_RESULT_LINE_SKIP.test(line));
    const truncated = childShowingTruncated
        || (Number.isFinite(room) && room >= 0 && lines.length >= room);
    return { lines, truncated };
}

export function buildGrepChunkMergePrefix(patternChunkCount, truncated, aggregateBudget, outputMode = 'content') {
    if (patternChunkCount <= 1 && !truncated) return '';
    const parts = [];
    if (patternChunkCount > 1) parts.push(`pattern set split into ${patternChunkCount} chunks`);
    if (truncated) {
        parts.push(`chunk results truncated at aggregate budget ${aggregateBudget} lines; results are partial`);
        if (outputMode === 'count') parts.push('counts are lower bounds (>=)');
    }
    return `[${parts.join('; ')}]\n`;
}
