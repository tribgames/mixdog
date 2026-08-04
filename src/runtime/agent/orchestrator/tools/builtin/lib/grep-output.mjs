// Grep output formatting: line/block normalization, context-block windowing
// (head_limit + offset count MATCH BLOCKS, truncation keeps head+tail), the
// pattern[] fan-out dedupe and the plain windowed renderer. Extracted from
// search-tool.mjs, which keeps argument handling and rg execution.
import { normalizeOutputPath } from '../path-utils.mjs';
import {
    groupGrepContentByFile,
    splitGrepLineNumberOnlyPrefix,
    splitGrepLinePrefix,
} from '../grep-formatting.mjs';
import { relativeGrepLine } from './search-input-helpers.mjs';

export function grepMissingPatternMessage() {
    return 'Error: grep requires pattern.';
}

export function globMissingPatternMessage() {
    return 'Error: glob requires pattern.';
}

// --- context-mode match-block windowing (Parts 2 & 3) ---------------------
// In context mode (explicit -A/-B/-C or content_with_context auto), head_limit
// and offset count MATCH BLOCKS, not raw output lines, and truncation keeps a
// head+tail slice with a middle marker instead of dropping the tail.
function grepBlockMatchAnchor(line, filenameOmitted) {
    if (filenameOmitted) {
        const p = splitGrepLineNumberOnlyPrefix(line);
        return p && p.delimiter === ':' ? `#${p.lineNo}` : '';
    }
    const s = splitGrepLinePrefix(line);
    return s && s.delimiter === ':' ? `${s.path}\0${s.lineNo}` : '';
}

function parseGrepContextBlocks(lines, filenameOmitted) {
    const blocks = [];
    let pending = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line === '--') { pending = []; i++; continue; }
        const anchor = grepBlockMatchAnchor(line, filenameOmitted);
        if (anchor) {
            const blockLines = pending.concat([line]);
            pending = [];
            i++;
            while (i < lines.length) {
                const next = lines[i];
                if (next === '--' || grepBlockMatchAnchor(next, filenameOmitted)) break;
                blockLines.push(next);
                i++;
            }
            blocks.push({ anchor, lines: blockLines });
            continue;
        }
        pending.push(line);
        i++;
    }
    return blocks;
}

export function formatGrepContextOutput({ allLines, workDir, outputMode, filenameOmitted, headLimit, offset, totalKnown = true }) {
    const norm = allLines.map((l) => (l === '--' ? '--' : relativeGrepLine(l, workDir, false, outputMode, filenameOmitted)));
    const blocks = parseGrepContextBlocks(norm, filenameOmitted);
    const total = blocks.length;
    if (total === 0) return { text: '', total: 0, shown: 0, omitted: 0 };
    // Finding 2/3: denominator is the PRE-offset grand total; on a partial rg
    // read (stdout cap / stream cap) it is a lower bound, so print ">=T".
    const totalStr = totalKnown ? `${total}` : `>=${total}`;
    const afterOffset = offset > 0 ? blocks.slice(offset) : blocks;
    if (afterOffset.length === 0) {
        // On a partial stream (line cap / timeout) the parsed blocks are a
        // lower bound — an offset beyond them is NOT proven past the last
        // match, so steer toward narrowing instead of claiming "past end".
        const text = totalKnown
            ? `[Showing 0 of ${totalStr} matches; offset ${offset} past end]`
            : `[Showing 0 of ${totalStr} matches (results partial); offset ${offset} is beyond the streamed window — matches past it may exist. Narrow path/glob/pattern instead of paging deeper.]`;
        return { text, total, shown: 0, omitted: 0 };
    }
    const shown = headLimit === Infinity ? afterOffset.length : Math.min(headLimit, afterOffset.length);
    const omitted = afterOffset.length - shown;
    const render = (arr) => arr.map((b) => b.lines.join('\n'));
    let segments;
    let nextOffset = offset + shown;
    if (omitted > 0 && shown > 0) {
        // Keep head + tail so both ends of the match range stay visible.
        const headCount = Math.max(1, Math.ceil(shown / 2));
        const tailCount = shown - headCount;
        const head = render(afterOffset.slice(0, headCount));
        const tail = tailCount > 0 ? render(afterOffset.slice(afterOffset.length - tailCount)) : [];
        segments = [...head, `…${omitted} matches omitted…`, ...tail];
        // Paging must resume at the first OMITTED block (right after the head
        // slice): offset+shown would permanently skip the middle blocks that
        // the tail slice displaced. Tail blocks re-appear on later pages —
        // duplication is acceptable, silent loss is not.
        nextOffset = offset + headCount;
    } else {
        segments = render(afterOffset.slice(0, shown));
    }
    const notice = (omitted > 0 || !totalKnown)
        ? `\n[Showing ${shown} of ${totalStr} matches${totalKnown ? '' : ' (results partial)'}; pass offset:${nextOffset} for more]`
        : '';
    return { text: segments.join('\n--\n') + notice, total, shown, omitted };
}

// Part 1: drop path:line match lines already emitted by an earlier pattern in
// a pattern[] fan-out. Context ('-') lines and non-match lines pass through.
export function dedupeFanoutMatchLines(body, seen) {
    const text = String(body);
    if (/^Error:/.test(text)) return text;
    const out = [];
    for (const line of text.split('\n')) {
        const s = splitGrepLinePrefix(line);
        if (s && s.delimiter === ':') {
            const key = `${s.path}\0${s.lineNo}`;
            if (seen.has(key)) continue;
            seen.add(key);
        }
        out.push(line);
    }
    return out.join('\n');
}

export function formatGrepOutput({ windowed, totalWindowed, totalKnown, headLimit, offset, outputMode, patterns: _patterns, beforeN, afterN, contextN, searchPath, grepResolvedPath: _grepResolvedPath, workDir, globPatterns: _globPatterns, fileType: _fileType, filenameOmitted = false, prefix = '', broadAdvisory: _broadAdvisory = true, disableContentGrouping = false }) {
    const lines = headLimit === Infinity ? windowed : windowed.slice(0, headLimit);
    const normalized = lines.map((line) => relativeGrepLine(line, workDir, outputMode === 'files_with_matches', outputMode, filenameOmitted));
    const remaining = Math.max(0, totalWindowed - lines.length);
    const shown = lines.length;
    // Finding 3: PRE-offset grand total so the denominator matches the
    // context-mode notice (offset==0 leaves this unchanged).
    const total = offset + totalWindowed;
    const scopePath = JSON.stringify(normalizeOutputPath(searchPath));
    const truncated = (remaining > 0 || !totalKnown)
        ? (totalKnown
            ? `\n[Showing ${shown} of ${total} results; pass offset:${offset + shown} for more]`
            : `\n[Showing ${shown} (more matches exist — use output_mode:'count' for the exact total on ${scopePath}); pass offset:${offset + shown} for more]`)
        : '';

    let countSummary = '';
    if (outputMode === 'count') {
        let totalMatches = 0;
        let fileCount = 0;
        for (const line of normalized) {
            const m = line.match(/(?:^|:)(\d+)$/);
            if (m) { totalMatches += Number(m[1]); fileCount++; }
        }
        countSummary = `\n[total ${totalMatches} match${totalMatches === 1 ? '' : 'es'} across ${fileCount} file${fileCount === 1 ? '' : 's'}]`;
    }
    const hasContext = (beforeN > 0 || afterN > 0 || contextN > 0);
    const groupedBody = (outputMode === 'content' && !hasContext && !filenameOmitted && !disableContentGrouping)
        ? groupGrepContentByFile(normalized)
        : normalized.join('\n');
    const body = groupedBody + truncated + countSummary;
    return `${prefix}${body}`;
}
