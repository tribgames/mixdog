import { createReadStream } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import {
    normalizeOutputPath,
} from '../path-utils.mjs';
import {
    splitGrepLineNumberOnlyPrefix,
    splitGrepLinePrefix,
} from '../grep-formatting.mjs';
import {
    relativePathPrefix,
} from '../search-path-diagnostics.mjs';
import {
    relativeGrepLine,
} from './search-input-helpers.mjs';

export const GREP_CONTEXT_CHAR_BUDGET_DEFAULT = 10_000;
const GREP_CONTEXT_READ_CONCURRENCY = 4;
const GREP_FOCUSED_CONTEXT_RADIUS = 12;
const GREP_FOCUSED_RAW_BLOCKS = 3;
// Anchors must stay usable as evidence without a follow-up read: keep the
// complete match line and only cut pathological long lines (minified files).
// Mid-line ellipsis below ~100 chars measurably pushed models into re-read
// verification loops (tool-budget bench, 20260805).
const GREP_COMPACT_ANCHOR_CONTENT_MAX = 400;

function parseAnchor(line, {
    workDir,
    rgSpawnCwd,
    grepResolvedPath,
    searchPath,
    outputMode,
    filenameOmitted,
}) {
    if (filenameOmitted) {
        const split = splitGrepLineNumberOnlyPrefix(line);
        if (!split || split.delimiter !== ':') return null;
        return {
            path: relativePathPrefix(normalizeOutputPath(searchPath), workDir),
            absolutePath: grepResolvedPath,
            lineNo: split.lineNo,
            content: String(line).slice(split.markerEnd),
        };
    }
    const raw = splitGrepLinePrefix(line);
    if (!raw || raw.delimiter !== ':') return null;
    const normalized = relativeGrepLine(line, workDir, false, outputMode, false);
    const display = splitGrepLinePrefix(normalized);
    if (!display || display.delimiter !== ':') return null;
    return {
        path: display.path,
        absolutePath: isAbsolute(raw.path) ? raw.path : resolve(rgSpawnCwd, raw.path),
        lineNo: raw.lineNo,
        content: String(line).slice(raw.markerEnd),
    };
}

function parseAnchors(allLines, options) {
    const anchors = [];
    const seen = new Set();
    for (const line of allLines) {
        const anchor = parseAnchor(line, options);
        if (!anchor) continue;
        const key = `${anchor.absolutePath}\0${anchor.lineNo}`;
        if (seen.has(key)) continue;
        seen.add(key);
        anchors.push({ ...anchor, order: anchors.length });
    }
    return anchors;
}

function splitTopLevelAlternatives(pattern) {
    const source = String(pattern || '');
    const parts = [];
    let start = 0;
    let depth = 0;
    let inClass = false;
    let escaped = false;
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (inClass) {
            if (char === ']') inClass = false;
            continue;
        }
        if (char === '[') {
            inClass = true;
            continue;
        }
        if (char === '(') {
            depth++;
            continue;
        }
        if (char === ')' && depth > 0) {
            depth--;
            continue;
        }
        if (char === '|' && depth === 0) {
            parts.push(source.slice(start, index));
            start = index + 1;
        }
    }
    if (parts.length === 0) return [source];
    parts.push(source.slice(start));
    return parts;
}

function rankAnchors(anchors, patterns, caseInsensitive) {
    const branches = [];
    for (const pattern of Array.isArray(patterns) ? patterns : [patterns]) {
        for (const branch of splitTopLevelAlternatives(pattern)) {
            if (!branch) continue;
            try {
                branches.push(new RegExp(branch, caseInsensitive ? 'i' : ''));
            } catch {
                // PCRE2/ripgrep syntax is not always valid JavaScript regex.
                // Keep source order when a branch cannot be ranked safely.
                branches.push(null);
            }
        }
    }
    if (branches.length <= 1) return anchors;
    return anchors.map((anchor) => ({
        ...anchor,
        priority: branches.findIndex((branch) => branch?.test(anchor.content)),
    })).map((anchor) => ({
        ...anchor,
        priority: anchor.priority < 0 ? Number.MAX_SAFE_INTEGER : anchor.priority,
    }));
}

function selectAnchors(anchors, headLimit, offset) {
    const afterOffset = offset > 0 ? anchors.slice(offset) : anchors;
    if (afterOffset.length === 0) {
        return { selected: [], shown: 0, omitted: 0, nextOffset: offset };
    }
    const shown = headLimit === Infinity ? afterOffset.length : Math.min(headLimit, afterOffset.length);
    const omitted = afterOffset.length - shown;
    if (omitted <= 0 || shown <= 0) {
        return {
            selected: afterOffset.slice(0, shown),
            shown,
            omitted,
            nextOffset: offset + shown,
        };
    }
    const headCount = Math.max(1, Math.ceil(shown / 2));
    const tailCount = shown - headCount;
    return {
        selected: [
            ...afterOffset.slice(0, headCount),
            ...(tailCount > 0 ? afterOffset.slice(afterOffset.length - tailCount) : []),
        ],
        shown,
        omitted,
        nextOffset: offset + headCount,
    };
}

function mergeIntervals(intervals) {
    const sorted = [...intervals].sort((left, right) => left.start - right.start || left.end - right.end);
    const merged = [];
    for (const interval of sorted) {
        const previous = merged.at(-1);
        if (previous && interval.start <= previous.end + 1) {
            previous.end = Math.max(previous.end, interval.end);
        } else {
            merged.push({ ...interval });
        }
    }
    return merged;
}

async function readFileWindows(entry, radius, signal) {
    const intervals = mergeIntervals(entry.anchors.map((anchor) => ({
        start: Math.max(1, anchor.lineNo - radius),
        end: anchor.lineNo + radius,
    })));
    const lines = new Map();
    if (intervals.length === 0) return lines;
    const input = createReadStream(entry.absolutePath, { encoding: 'utf8' });
    const reader = createInterface({ input, crlfDelay: Infinity });
    let lineNo = 0;
    let intervalIndex = 0;
    const abort = () => input.destroy(Object.assign(new Error('grep context expansion aborted'), { code: 'ABORT_ERR' }));
    if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
    }
    try {
        for await (const line of reader) {
            lineNo++;
            while (intervalIndex < intervals.length && lineNo > intervals[intervalIndex].end) intervalIndex++;
            if (intervalIndex >= intervals.length) {
                input.destroy();
                break;
            }
            const interval = intervals[intervalIndex];
            if (lineNo >= interval.start && lineNo <= interval.end) lines.set(lineNo, line);
        }
        return lines;
    } finally {
        if (signal) signal.removeEventListener('abort', abort);
        reader.close();
        input.destroy();
    }
}

async function readAnchorSources(anchors, radius, signal) {
    const groups = new Map();
    for (const anchor of anchors) {
        if (!groups.has(anchor.absolutePath)) {
            groups.set(anchor.absolutePath, {
                absolutePath: anchor.absolutePath,
                anchors: [],
                lines: new Map(),
                error: null,
            });
        }
        groups.get(anchor.absolutePath).anchors.push(anchor);
    }
    const entries = [...groups.values()];
    let next = 0;
    const worker = async () => {
        while (next < entries.length) {
            const entry = entries[next++];
            try {
                entry.lines = await readFileWindows(entry, radius, signal);
            } catch (err) {
                entry.error = err;
            }
        }
    };
    await Promise.all(Array.from(
        { length: Math.min(GREP_CONTEXT_READ_CONCURRENCY, entries.length) },
        () => worker(),
    ));
    return groups;
}

function sourceBlock(anchor, source, radius) {
    if (!source || source.error || !source.lines.has(anchor.lineNo)) {
        return {
            path: anchor.path,
            matchLine: anchor.lineNo,
            startLine: anchor.lineNo,
            endLine: anchor.lineNo,
            contents: [anchor.content],
            sourceComplete: false,
            priority: anchor.priority ?? Number.MAX_SAFE_INTEGER,
            order: anchor.order ?? Number.MAX_SAFE_INTEGER,
        };
    }
    let startLine = Math.max(1, anchor.lineNo - radius);
    let endLine = anchor.lineNo + radius;
    while (startLine < anchor.lineNo && !source.lines.has(startLine)) startLine++;
    while (endLine > anchor.lineNo && !source.lines.has(endLine)) endLine--;
    const contents = [];
    for (let lineNo = startLine; lineNo <= endLine; lineNo++) {
        if (!source.lines.has(lineNo)) break;
        contents.push(source.lines.get(lineNo));
    }
    return {
        path: anchor.path,
        matchLine: anchor.lineNo,
        startLine,
        endLine: startLine + contents.length - 1,
        contents,
        sourceComplete: true,
        priority: anchor.priority ?? Number.MAX_SAFE_INTEGER,
        order: anchor.order ?? Number.MAX_SAFE_INTEGER,
    };
}

function mergeBlocks(blocks) {
    const sorted = [...blocks].sort((left, right) => (
        left.path.localeCompare(right.path)
        || left.startLine - right.startLine
        || left.endLine - right.endLine
    ));
    const merged = [];
    for (const block of sorted) {
        const previous = merged.at(-1);
        if (previous
            && previous.path === block.path
            && block.startLine <= previous.endLine + 1) {
            const overlap = Math.max(0, previous.endLine - block.startLine + 1);
            previous.contents.push(...block.contents.slice(overlap));
            previous.endLine = Math.max(previous.endLine, block.endLine);
            previous.sourceComplete = previous.sourceComplete && block.sourceComplete;
            if (block.priority < previous.priority
                || (block.priority === previous.priority && block.order < previous.order)) {
                previous.matchLine = block.matchLine;
                previous.priority = block.priority;
                previous.order = block.order;
            }
        } else {
            merged.push({ ...block, contents: [...block.contents] });
        }
    }
    return merged.sort((left, right) => (
        left.priority - right.priority
        || left.order - right.order
    ));
}

function pagingNotice({ shown, total, totalKnown, omitted, offset, nextOffset }) {
    const totalStr = totalKnown ? `${total}` : `>=${total}`;
    if (shown === 0) {
        return totalKnown
            ? `[Showing 0 of ${totalStr} matches; offset ${offset} past end]`
            : `[Showing 0 of ${totalStr} matches (results partial); offset ${offset} is beyond the streamed window — matches past it may exist. Narrow path/glob/pattern instead of paging deeper.]`;
    }
    return (omitted > 0 || !totalKnown)
        ? `\n[Showing ${shown} of ${totalStr} matches${totalKnown ? '' : ' (results partial)'}; pass offset:${nextOffset} for more]`
        : '';
}

function renderAtRadius(selected, sources, radius, _budget, notice) {
    const blocks = mergeBlocks(selected.map((anchor) => (
        sourceBlock(anchor, sources.get(anchor.absolutePath), radius)
    )));
    const body = blocks.map((block) => (
        `# ${block.path}:${block.matchLine} [lines ${block.startLine}-${block.endLine}]\n${block.contents.join('\n')}`
    )).join('\n');
    const sourceComplete = blocks.every((block) => block.sourceComplete);
    // Header is a format cue only — internal radius/char-budget numbers are
    // harness noise (neither Claude Code nor Codex surface theirs).
    const text = `[Raw source spans; apply_patch context may be copied verbatim]\n${body}${notice}`;
    return { text, sourceComplete, blockCount: blocks.length };
}

function anchorPriority(left, right) {
    return (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER)
        || (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER);
}

function compactAnchorContent(content) {
    const normalized = String(content || '').trim().replace(/\s+/g, ' ');
    return normalized.length <= GREP_COMPACT_ANCHOR_CONTENT_MAX
        ? normalized
        : `${normalized.slice(0, GREP_COMPACT_ANCHOR_CONTENT_MAX - 1)}…`;
}

function anchorRangeHint(anchor, radius) {
    const startLine = Math.max(1, anchor.lineNo - radius);
    const endLine = anchor.lineNo + radius;
    return `lines ${startLine}-${endLine}`;
}

function renderFocusedContext(selected, sources, radius, _budget, notice) {
    const ordered = [...selected].sort(anchorPriority);
    const rankedBlocks = mergeBlocks(ordered.map((anchor) => (
        sourceBlock(anchor, sources.get(anchor.absolutePath), radius)
    )));
    const rawBlocks = rankedBlocks.slice(0, GREP_FOCUSED_RAW_BLOCKS);
    const covered = (anchor) => rawBlocks.some((block) => (
        anchor.path === block.path
        && anchor.lineNo >= block.startLine
        && anchor.lineNo <= block.endLine
    ));
    const compact = ordered.filter((anchor) => !covered(anchor));
    const raw = rawBlocks.map((block) => (
        `# ${block.path}:${block.matchLine} [lines ${block.startLine}-${block.endLine}]\n${block.contents.join('\n')}`
    )).join('\n');
    const anchors = compact.length
        ? `\n# Additional matches\n${compact.map((anchor) => (
            `${anchor.path}:${anchor.lineNo}:${compactAnchorContent(anchor.content)} [${anchorRangeHint(anchor, radius)}]`
        )).join('\n')}`
        : '';
    const header = compact.length
        ? `[Top ${rawBlocks.length} of ${ordered.length}; remaining as path:line anchors]`
        : null;
    const text = `${header ? `${header}\n` : ''}${raw}${anchors}${notice}`;
    return {
        text,
        sourceComplete: rawBlocks.every((block) => block.sourceComplete),
        blockCount: rawBlocks.length,
    };
}

export async function expandGrepAnchorContextOutput({
    allLines,
    workDir,
    rgSpawnCwd,
    grepResolvedPath,
    searchPath,
    outputMode,
    filenameOmitted,
    headLimit,
    offset,
    totalKnown = true,
    requestedContext,
    maxContext,
    patterns = [],
    caseInsensitive = false,
    charBudget = GREP_CONTEXT_CHAR_BUDGET_DEFAULT,
    signal,
}) {
    const anchors = rankAnchors(parseAnchors(allLines, {
        workDir,
        rgSpawnCwd,
        grepResolvedPath,
        searchPath,
        outputMode,
        filenameOmitted,
    }), patterns, caseInsensitive);
    const total = anchors.length;
    if (total === 0) return { text: '', total: 0, shown: 0, omitted: 0, sourceComplete: true };
    const window = selectAnchors(anchors, headLimit, offset);
    let notice = pagingNotice({
        ...window,
        total,
        totalKnown,
        offset,
    });
    if (window.selected.length === 0) {
        return {
            text: notice,
            total,
            shown: 0,
            omitted: 0,
            sourceComplete: true,
        };
    }
    const requested = Math.max(0, Math.floor(Number(requestedContext) || 0));
    const target = Math.max(requested, Math.max(0, Math.floor(Number(maxContext) || 0)));
    const budget = Math.max(512, Math.floor(Number(charBudget) || GREP_CONTEXT_CHAR_BUDGET_DEFAULT));
    const sources = await readAnchorSources(window.selected, target, signal);
    let selected = window.selected;
    let shown = window.shown;
    let omitted = window.omitted;
    let radius = target;
    let rendered = renderAtRadius(selected, sources, radius, budget, notice);
    // Progressive disclosure: one or two source clusters that fit are most
    // useful as patch-ready raw text. Broad searches instead expand up to three
    // high-priority source clusters and retain the rest as compact path:line
    // anchors with neutral range metadata. This avoids paying 25 lines for
    // every match without nudging the model into unnecessary follow-up reads.
    const sparseRaw = rendered.blockCount <= 2 && rendered.text.length <= budget;
    if (!sparseRaw) {
        radius = Math.min(target, GREP_FOCUSED_CONTEXT_RADIUS);
        rendered = renderFocusedContext(selected, sources, radius, budget, notice);
        while (rendered.text.length > budget && radius > 0) {
            radius--;
            rendered = renderFocusedContext(selected, sources, radius, budget, notice);
        }
    } else {
        return {
            ...rendered,
            total,
            shown,
            omitted,
        };
    }
    while (rendered.text.length > budget && selected.length > 1) {
        selected = [...selected].sort(anchorPriority).slice(0, -1);
        shown = selected.length;
        omitted = Math.max(0, total - offset - shown);
        notice = pagingNotice({
            shown,
            total,
            totalKnown,
            omitted,
            offset,
            nextOffset: offset + shown,
        });
        rendered = renderFocusedContext(
            selected,
            sources,
            radius,
            budget,
            notice,
        );
    }
    return {
        ...rendered,
        total,
        shown,
        omitted,
    };
}
