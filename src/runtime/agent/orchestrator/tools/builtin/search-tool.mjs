import { statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { trueCasePath } from './path-utils.mjs';
import {
    canonicalizeGlobSlashes,
    coerceReadFamilyPathArg,
    coerceShapeFlex,
    extractGlobBaseDirectory,
    hasGlobMagic,
    normalizeGlobArgs,
    normalizeGrepArgs,
    normalizeInputPath,
    normalizeOutputPath,
    normalizeSearchPattern,
    resolveAgainstCwd,
} from './path-utils.mjs';
import {
    _suggestIndexedPaths,
    basePathDiagnostic,
    buildNotFoundHint,
    finalizeReadFamilyEnoentTail,
    tryReadFamilyEnoentRedirect,
    isUncOrSmbPath,
    relativePathPrefix,
    relativeSearchResultPath,
    resolveSearchScope,
    stripEmbeddedPathQuotes,
    uncRefusalMessage,
} from './search-path-diagnostics.mjs';
// Facade re-export: path-diagnostic helpers moved to search-path-diagnostics.mjs;
// keep prior importers of search-tool.mjs unchanged.
export {
    _suggestIndexedPaths,
    basePathDiagnostic,
    buildNotFoundHint,
    isUncOrSmbPath,
    relativePathPrefix,
    relativeSearchResultPath,
    resolveSearchScope,
    stripEmbeddedPathQuotes,
    uncRefusalMessage,
} from './search-path-diagnostics.mjs';
import {
    buildGlobCacheKey,
    buildGrepCacheKey,
    buildGrepRgArgs,
    DEFAULT_IGNORE_GLOBS,
} from './search-builders.mjs';
import { runRg, runRgWindowedLines, rgSupportsPcre2 } from './rg-runner.mjs';
import { markScopedCacheIncomplete } from '../../session/cache/scoped-cache-outcome.mjs';
import {
    groupGrepContentByFile,
    normalizeGrepLine,
    splitGrepCountPrefix,
    splitGrepLinePrefix,
    splitGrepLineNumberOnlyPrefix,
} from './grep-formatting.mjs';
import {
    cacheGet,
    cacheSet,
    runResultCacheInFlight,
    statPathsForMtime,
} from './cache-layers.mjs';
import { applyGrepContextLeadPolicy, GREP_CONTEXT_MAX, hasUnsupportedRipgrepRegex } from './arg-guard.mjs';
import {
    buildGrepChunkMergePrefix,
    chunkPatternList,
    computeGrepChunkAggregateBudget,
    extractGrepChunkResultLines,
    mergeGrepChunkLines,
} from './lib/search-grep-chunks.mjs';

// Default surrounding-lines window applied by output_mode:'content_with_context'
// when the caller does not pass an explicit -A/-B/-C/context. Sized to cover a
// typical function/block so a match arrives readable without a follow-up read.
// Explicit -A/-B/-C is honored up to the generic GREP_CONTEXT_MAX (no tighter
// context-mode clamp by policy); only head_limit blocks are context-clamped.
const GREP_AUTO_CONTEXT_LINES = 25;

function expandLegacyEscapedAlternationPattern(rawPattern) {
    if (typeof rawPattern !== 'string' || !rawPattern.includes('\\|')) return null;
    const parts = rawPattern.split('\\|').map((part) => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts : null;
}

function relativeGrepLine(line, workDir, pathOnly = false, outputMode = 'content', filenameOmitted = false) {
    const normalized = normalizeGrepLine(line, pathOnly, outputMode, filenameOmitted);
    if (!workDir) return normalized;
    if (pathOnly) return relativePathPrefix(normalized, workDir);
    if (filenameOmitted) return normalized;
    const split = splitGrepLinePrefix(normalized);
    if (split) {
        return relativePathPrefix(normalized.slice(0, split.pathEnd), workDir) + normalized.slice(split.pathEnd);
    }
    if (outputMode === 'count') {
        const countSplit = splitGrepCountPrefix(normalized);
        if (countSplit) {
            return relativePathPrefix(normalized.slice(0, countSplit.pathEnd), workDir) + normalized.slice(countSplit.pathEnd);
        }
    }
    return normalized;
}

function uniqueStrings(values) {
    return Array.from(new Set(values.filter((value) => typeof value === 'string' && value)));
}

function isRgRegexParseError(err) {
    const msg = `${err?.stderr || ''}\n${err?.message || err || ''}`;
    return /regex parse error/i.test(msg);
}

function regexPatternToFixedTerms(pattern) {
    const raw = String(pattern || '');
    if (!raw) return [];
    return raw
        .split(/\\?\|/g)
        .map((part) => part.trim())
        .map((part) => part
            .replace(/\\[bB]/g, '')
            .replace(/^\^/, '')
            .replace(/\$$/, '')
            .replace(/\\([\\.^$*+?()[\]{}|/-])/g, '$1')
            .trim())
        .filter((part) => part.length > 0);
}

function coerceNonNegInt(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return NaN;
    return Math.floor(n);
}

function globMtimeTiePath(entry) {
    const p = String(entry?.path ?? entry?.full ?? '');
    return process.platform === 'win32' ? p.toLocaleLowerCase() : p;
}

// CC parity (GrepTool.ts): a single glob string may pack multiple filters
// separated by whitespace or commas, e.g. "*.ts,*.tsx" or "*.ts *.tsx". Split
// each into its own --glob. Brace patterns ("*.{ts,tsx}") are left intact so
// their internal commas are not torn apart.
function splitGlobString(value) {
    const out = [];
    const str = String(value);
    let depth = 0;
    let token = '';
    const flush = () => {
        const trimmed = token.trim();
        if (trimmed) out.push(trimmed);
        token = '';
    };
    for (const ch of str) {
        if (ch === '{') {
            depth++;
            token += ch;
        } else if (ch === '}') {
            if (depth > 0) depth--;
            token += ch;
        } else if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
            flush();
        } else {
            token += ch;
        }
    }
    flush();
    return out;
}

function isRedundantAllFilesGlob(value) {
    const g = canonicalizeGlobSlashes(String(value || '').trim())
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
    return g === '**/*' || g === '**';
}

function grepMissingPatternMessage() {
    return 'Error: grep requires pattern.';
}

function globMissingPatternMessage() {
    return 'Error: glob requires pattern.';
}

function parseGrepCountLine(line) {
    const text = String(line || '');
    const searchFrom = /^[A-Za-z]:/.test(text) ? 2 : 0;
    const idx = text.lastIndexOf(':');
    if (idx <= searchFrom) return null;
    const count = Number(text.slice(idx + 1));
    if (!Number.isFinite(count) || count <= 0) return null;
    const path = text.slice(0, idx);
    if (!path) return null;
    return { path, count };
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

function formatGrepContextOutput({ allLines, workDir, outputMode, filenameOmitted, headLimit, offset, totalKnown = true }) {
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
function dedupeFanoutMatchLines(body, seen) {
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

function formatGrepOutput({ windowed, totalWindowed, totalKnown, headLimit, offset, outputMode, patterns: _patterns, beforeN, afterN, contextN, searchPath, grepResolvedPath: _grepResolvedPath, workDir, globPatterns: _globPatterns, fileType: _fileType, filenameOmitted = false, prefix = '', broadAdvisory: _broadAdvisory = true, disableContentGrouping = false }) {
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

export async function executeGrepTool(args, workDir, executeChildBuiltinTool, readStateScope = null, options = {}) {
    args = normalizeGrepArgs(args);
    args.path = coerceReadFamilyPathArg(args.path, workDir);
    // Fan-out guard: batch multiple string paths with bounded concurrency,
    // mirroring code_graph files[] batching. Recursive calls pass a single
    // string path, so recursion bottoms out after one level. Results are
    // assembled below in input order, regardless of completion order.
    if (Array.isArray(args.path)) {
        const GREP_PATH_CAP = 10;
        const GREP_PATH_CONCURRENCY = 4;
        const seen = new Set();
        const list = args.path
            .map(p => typeof p === 'string' ? p.trim() : '')
            .filter(p => p && !seen.has(p) && seen.add(p));
        if (list.length > 1) {
            const capped = list.slice(0, GREP_PATH_CAP);
            const nestedOptions = { ...options, _grepPathFanout: true };
            const configuredOutputCap = Number(options?.toolOutputMaxBytes) > 0
                ? Math.trunc(Number(options.toolOutputMaxBytes))
                : Math.trunc(Number(process.env.MIXDOG_TOOL_OUTPUT_MAX_BYTES));
            const bodies = new Array(capped.length);
            let next = 0;
            const runWorker = async () => {
                while (next < capped.length) {
                    const index = next++;
                    const p = capped[index];
                    try {
                        bodies[index] = await executeGrepTool(
                            { ...args, path: p },
                            workDir,
                            executeChildBuiltinTool,
                            readStateScope,
                            nestedOptions,
                        );
                    } catch (err) {
                        bodies[index] = `Error: ${err && err.message ? err.message : err}`;
                    }
                }
            };
            await Promise.all(
                Array.from(
                    { length: Math.min(GREP_PATH_CONCURRENCY, capped.length) },
                    () => runWorker(),
                ),
            );
            const parts = capped.map((p, index) => `# grep ${p}\n${bodies[index]}`);
            if (list.length > GREP_PATH_CAP) {
                parts.push(`[capped at ${GREP_PATH_CAP} of ${list.length} paths]`);
                // Omitted paths mean the returned result cannot cover the whole
                // requested path set — never let it be cached as complete.
                if (options?.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
            }
            const output = parts.join('\n\n');
            if (configuredOutputCap > 0
                && Buffer.byteLength(output, 'utf8') > configuredOutputCap
                && options?.scopedCacheOutcome) {
                markScopedCacheIncomplete(options.scopedCacheOutcome);
            }
            return output;
        }
        args.path = list[0];
    }
    // Shape context immediately before deriving rg flags. This keeps the
    // Lead-direct MCP path and direct executeGrepTool callers on the same
    // policy even if they bypass or race the outer builtin arg guard.
    applyGrepContextLeadPolicy(args);
    args.path = stripEmbeddedPathQuotes(normalizeInputPath(args.path));
    args.pattern = coerceShapeFlex(args.pattern);
    args.glob = coerceShapeFlex(args.glob);
    const rawPattern = args.pattern;
    const rawPatterns = Array.isArray(rawPattern)
        ? rawPattern.filter(p => typeof p === 'string' && p)
        : (rawPattern ? (expandLegacyEscapedAlternationPattern(String(rawPattern)) || [String(rawPattern)]) : []);
    let patterns = uniqueStrings(rawPatterns.map(normalizeSearchPattern));
    const GREP_PATTERN_ARRAY_CAP = 10;
    let patternCapNote = '';
    let patternCapTotal = 0;
    if (patterns.length > GREP_PATTERN_ARRAY_CAP) {
        patternCapNote = `[capped at ${GREP_PATTERN_ARRAY_CAP} of ${patterns.length} patterns]\n`;
        patternCapTotal = patterns.length;
        patterns = patterns.slice(0, GREP_PATTERN_ARRAY_CAP);
        // Dropping input patterns means the returned result cannot cover the
        // full requested pattern set — never cache it as complete. Applies to
        // every downstream path (fan-out, chunk-merge, single combined).
        if (options?.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
    }
    if (patterns.length === 0) {
        if (args.glob || hasGlobMagic(args.path)) {
            const globArgs = {
                pattern: hasGlobMagic(args.path) ? args.path : args.glob,
                path: hasGlobMagic(args.path) ? undefined : (args.path || '.'),
            };
            if (args.head_limit !== undefined) globArgs.head_limit = args.head_limit;
            if (args.offset !== undefined) globArgs.offset = args.offset;
            return executeChildBuiltinTool('glob', globArgs, workDir);
        }
        return grepMissingPatternMessage();
    }

    const GREP_MULTILINE_PATTERN_CAP = 5;
    const GREP_ARRAY_PATTERN_CAP = 20;
    // Rescue: a pattern containing a literal two-char "\n" (backslash + n)
    // outside multiline mode makes rg hard-error with "the literal '\"\\n\"'
    // is not allowed in a regex" — rg requires -U/--multiline before a
    // pattern is allowed to match across a newline. Rather than reject-and-
    // retry, auto-enable multiline whenever any pattern carries a literal
    // \n; an explicit multiline:true from the caller still wins outright.
    const patternsWantMultiline = patterns.some((p) => /\\n/.test(p));
    const multilineMode = args.multiline === true || patternsWantMultiline;
    // Rescue: lookaround/backreference patterns are rejected by rg's default
    // Rust regex engine ("look-around ... is not supported" / "backreferences
    // ... not supported"). rg builds compiled with the optional `pcre2`
    // feature accept the same syntax via -P/--pcre2. Probe capability once
    // (cached) and route there instead of hard-erroring; when the installed
    // rg has no PCRE2 support, fall through unchanged and let the existing
    // arg-guard rejection (or rg's own runtime error) stand.
    const patternsWantPcre2 = hasUnsupportedRipgrepRegex(patterns);
    const pcre2Mode = patternsWantPcre2 && await rgSupportsPcre2();
    if (patternsWantPcre2 && !pcre2Mode) {
        return `Error: grep pattern uses regex syntax ripgrep does not support here (lookaround/backrefs), and the installed rg build has no PCRE2 support (-P unavailable). Use plain pattern arrays or simpler regex.`;
    }

    let searchPath = args.path || '.';
    const rawGlob = args.glob;
    const rawGlobs = uniqueStrings((Array.isArray(rawGlob)
        ? rawGlob.filter(g => typeof g === 'string' && g)
        : (rawGlob ? [String(rawGlob)] : []))
        .flatMap(splitGlobString)
        .map(normalizeInputPath));
    if (hasGlobMagic(searchPath)) {
        const { baseDir, relativePattern } = extractGlobBaseDirectory(searchPath);
        searchPath = baseDir || '.';
        rawGlobs.unshift(relativePattern.replace(/^\//, ''));
    }
    const grepResolvedPath = resolveSearchScope(searchPath, workDir);
    if (isUncOrSmbPath(searchPath) || isUncOrSmbPath(grepResolvedPath)) {
        return uncRefusalMessage('grep', searchPath, grepResolvedPath);
    }
    const globPatterns = [];
    const rootFwd = normalizeOutputPath(grepResolvedPath).replace(/\/+$/, '');
    for (const g of rawGlobs) {
        if (isAbsolute(g)) {
            const { baseDir, relativePattern } = extractGlobBaseDirectory(g);
            const baseFwd = baseDir ? normalizeOutputPath(baseDir).replace(/\/+$/, '') : '';
            const rel = relativePattern.replace(/^\//, '');
            // Windows is case-insensitive: compare path casing accordingly so a
            // valid in-root absolute glob is not rejected when its drive/dir
            // casing differs from the resolved root.
            const ci = process.platform === 'win32';
            const baseCmp = ci ? baseFwd.toLowerCase() : baseFwd;
            const rootCmp = ci ? rootFwd.toLowerCase() : rootFwd;
            if (!baseFwd || baseCmp === rootCmp) {
                globPatterns.push(rel);
            } else if (baseCmp.startsWith(rootCmp + '/')) {
                const prefix = baseFwd.slice(rootFwd.length + 1);
                globPatterns.push(prefix ? `${prefix}/${rel}` : rel);
            } else {
                return `Error: absolute glob ${JSON.stringify(g)} resolves outside search root ${JSON.stringify(rootFwd)}; pass a relative glob or move the search path`;
            }
        } else {
            globPatterns.push(g);
        }
    }
    // ripgrep `--glob` uses forward slashes on all platforms; canonicalize
    // `\`→`/` (win32 only) so a `**\*.ts` filter matches instead of being
    // parsed as an escape sequence.
    const normalizedGlobPatterns = uniqueStrings(globPatterns
        .map(canonicalizeGlobSlashes)
        .filter((g) => !isRedundantAllFilesGlob(g)));

    const ALLOWED_OUTPUT_MODES = new Set(['files_with_matches', 'content', 'content_with_context', 'count']);
    const rawOutputMode = typeof args.output_mode === 'string' ? args.output_mode.trim() : '';
    if (rawOutputMode && !ALLOWED_OUTPUT_MODES.has(rawOutputMode)) {
        return `Error: invalid output_mode ${JSON.stringify(args.output_mode)}; expected one of ${[...ALLOWED_OUTPUT_MODES].join(', ')}`;
    }
    // Omitted output_mode and `content_with_context` both return content with a
    // generous surrounding-lines window. Explicit `content` remains bare.
    const wantAutoContext = rawOutputMode === '' || rawOutputMode === 'content_with_context';
    // Filename-only and count searches are explicit: callers must opt into
    // `files_with_matches` or `count` when they only need existence/count data.
    const outputMode = (rawOutputMode === 'content_with_context') ? 'content' : (rawOutputMode || 'content');
    const headLimitRaw = args.head_limit;
    const headLimitCoerced = coerceNonNegInt(headLimitRaw);
    if (Number.isNaN(headLimitCoerced)) {
        return `Error: invalid head_limit ${JSON.stringify(headLimitRaw)}; expected a non-negative integer (0 = unlimited)`;
    }
    const headLimit = headLimitCoerced === null
        ? 80
        : (headLimitCoerced === 0 ? Infinity : headLimitCoerced);
    const offsetCoerced = coerceNonNegInt(args.offset);
    if (Number.isNaN(offsetCoerced)) {
        return `Error: invalid offset ${JSON.stringify(args.offset)}; expected a non-negative integer`;
    }
    const offset = offsetCoerced === null || offsetCoerced === 0 ? 0 : offsetCoerced;
    const caseInsensitive = args['-i'] === true;
    const showLineNumbers = args['-n'] !== false;
    const coerceContext = (value) => {
        if (value === undefined || value === null || value === '') return null;
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return NaN;
        return Math.min(Math.floor(n), GREP_CONTEXT_MAX);
    };
    let afterN = coerceContext(args['-A']);
    let beforeN = coerceContext(args['-B']);
    let contextN = args['-C'] !== undefined && args['-C'] !== null && args['-C'] !== ''
        ? coerceContext(args['-C'])
        : coerceContext(args.context);
    // content_with_context: if no explicit context flag was supplied, apply a
    // generous default so the match arrives with enough surrounding code to
    // understand it (function-sized) without a separate read.
    if (wantAutoContext && afterN === null && beforeN === null && contextN === null) {
        contextN = GREP_AUTO_CONTEXT_LINES;
    }
    if (contextN !== null && contextN > 0) {
        if (afterN === 0) afterN = null;
        if (beforeN === 0) beforeN = null;
    }
    for (const [name, value] of [['-A', afterN], ['-B', beforeN], ['-C', contextN]]) {
        if (Number.isNaN(value)) {
            return `Error: invalid context option ${name}; expected a non-negative finite integer`;
        }
    }
    const rawType = args.type;
    let fileType = '';
    let fileTypes = [];
    if (Array.isArray(rawType)) {
        for (const entry of rawType) {
            if (typeof entry !== 'string') {
                return `Error: invalid type entry ${JSON.stringify(entry)}; expected string`;
            }
            const t = entry.trim();
            if (t) fileTypes.push(t);
        }
    } else if (typeof rawType === 'string') {
        const t = rawType.trim();
        if (t) {
            fileTypes = [t];
            fileType = t;
        }
    } else if (rawType !== undefined && rawType !== null) {
        return `Error: invalid type ${JSON.stringify(rawType)}; expected string or string[]`;
    }
    if (fileTypes.length > 1) fileType = fileTypes;
    else if (fileTypes.length === 1) fileType = fileTypes[0];

    // Part 1: pattern[] fan-out. Two or more patterns in a content search run
    // as INDEPENDENT greps (mirroring the path[] batching above): each pattern
    // keeps its own full head_limit budget and its own truncation notice, and
    // identical path:line match lines are de-duplicated across patterns. The
    // single-pattern path and the non-content modes (files_with_matches/count)
    // keep the combined single-rg behavior. `_grepPatternFanout` guards the
    // recursive single-pattern calls from re-entering the fan-out; the internal
    // chunk-merge recursion is likewise skipped.
    if (patterns.length > 1
        && outputMode === 'content'
        && !options._grepChunkMerge
        && !options._grepPatternFanout) {
        const seen = new Set();
        const subOptions = { ...options, _grepPatternFanout: true };
        // Each pattern is an INDEPENDENT grep; run them concurrently and then
        // apply dedup/section assembly in the original pattern order so the
        // shared `seen` set and output text stay byte-identical to the
        // sequential version.
        const runPattern = async (p) => {
            try {
                return await executeGrepTool({ ...args, pattern: p }, workDir, executeChildBuiltinTool, readStateScope, subOptions);
            } catch (err) {
                return `Error: ${err && err.message ? err.message : err}`;
            }
        };
        const subs = options._grepPathFanout
            ? await patterns.reduce(async (all, p) => [...await all, await runPattern(p)], Promise.resolve([]))
            : await Promise.all(patterns.map(runPattern));
        const parts = patterns.map((p, i) => `# grep pattern:${JSON.stringify(p)}\n${dedupeFanoutMatchLines(subs[i], seen)}`);
        return patternCapNote + parts.join('\n\n');
    }

    const patternChunkCap = multilineMode ? GREP_MULTILINE_PATTERN_CAP : GREP_ARRAY_PATTERN_CAP;
    if (patterns.length > patternChunkCap) {
        const patternChunks = chunkPatternList(patterns, patternChunkCap);
        const aggregateBudget = computeGrepChunkAggregateBudget(offset, headLimit, headLimitCoerced);
        let truncatedAggregate = false;
        const chunkBaseArgs = {
            ...args,
            offset: 0,
            ...(outputMode === 'count' ? { output_mode: 'content' } : {}),
        };
        const chunkMergeOptions = { ...options, _grepChunkMerge: true };
        // Fetch every chunk concurrently with the full aggregate budget, then
        // replay the sequential room-based accumulation over the results in
        // chunk order. rg output order is deterministic, so slicing this
        // superset by the sequential `room` yields identical lines, and the
        // re-extract with `room` reproduces the same truncation flags — the
        // merged output and `truncatedAggregate` are byte-identical to the
        // old serial loop while the grep calls overlap.
        const chunkBodies = await Promise.all(patternChunks.map((chunk) => executeGrepTool(
            { ...chunkBaseArgs, pattern: chunk, head_limit: aggregateBudget },
            workDir,
            executeChildBuiltinTool,
            readStateScope,
            chunkMergeOptions,
        )));
        const mergedRaw = [];
        for (const chunkBody of chunkBodies) {
            if (mergedRaw.length >= aggregateBudget) {
                truncatedAggregate = true;
                break;
            }
            const room = aggregateBudget - mergedRaw.length;
            const extracted = extractGrepChunkResultLines(chunkBody, room);
            if (extracted.error) return extracted.error.startsWith('Error:') ? extracted.error : `Error: ${extracted.error}`;
            const slice = extracted.lines.slice(0, room);
            mergedRaw.push(...slice);
            if (extracted.truncated || extracted.lines.length > room) truncatedAggregate = true;
        }
        const chunkPrefix = buildGrepChunkMergePrefix(
            patternChunks.length,
            truncatedAggregate,
            aggregateBudget,
            outputMode,
        );
        const merged = mergeGrepChunkLines(mergedRaw, {
            outputMode,
            beforeN,
            afterN,
            contextN,
        });
        const sliced = offset > 0 ? merged.slice(offset) : merged;
        const limit = headLimit === Infinity ? sliced.length : headLimit;
        const windowed = limit === Infinity ? sliced : sliced.slice(0, limit);
        // Cache-outcome fidelity: the concurrent chunk fetches run with the full
        // aggregateBudget as head_limit, so a child may report itself complete
        // even though the replay above trimmed its lines to a smaller `room`
        // (truncatedAggregate), the final head_limit window dropped lines, or an
        // offset paged past earlier matches. Mirror the other grep return paths
        // and mark the scoped cache incomplete so a partial/paged chunk-merge
        // result is never cached as whole.
        if (options?.scopedCacheOutcome && (truncatedAggregate || offset > 0 || windowed.length < sliced.length)) {
            markScopedCacheIncomplete(options.scopedCacheOutcome);
        }
        if (!windowed.length) {
            const patternStr = patterns.length === 1 ? JSON.stringify(patterns[0]) : JSON.stringify(patterns);
            const globStr = normalizedGlobPatterns.length > 0 ? ` glob=${JSON.stringify(normalizedGlobPatterns)}` : '';
            return `${patternCapNote}${chunkPrefix}(no matches) pattern=${patternStr} path=${searchPath}${globStr}`;
        }
        return formatGrepOutput({
            windowed,
            // POST-offset total so formatGrepOutput's remaining/total math (which
            // re-adds `offset`) does not conjure phantom "more" results from the
            // offset-skipped prefix.
            totalWindowed: sliced.length,
            totalKnown: !truncatedAggregate,
            headLimit,
            offset,
            outputMode,
            patterns,
            beforeN,
            afterN,
            contextN,
            searchPath,
            grepResolvedPath,
            workDir,
            globPatterns: normalizedGlobPatterns,
            fileType,
            filenameOmitted: false,
            prefix: patternCapNote + chunkPrefix,
        });
    }

    const forceGrepFilename = !!options._grepChunkMerge || !!options._grepPatternFanout;
    const cacheKey = buildGrepCacheKey({
        patterns,
        searchPath: normalizeOutputPath(grepResolvedPath),
        globPatterns: normalizedGlobPatterns,
        outputMode,
        headLimit,
        offset,
        caseInsensitive,
        showLineNumbers,
        beforeN,
        afterN,
        contextN,
        multilineMode,
        onlyMatching: args['-o'] === true,
        fileType,
        pcre2: pcre2Mode,
        withFilename: forceGrepFilename,
        // Capped requests carry the "[capped at N of M]" notice; key on the
        // original count so they never collide with an exact N-pattern request
        // (or a differently-capped one) in the internal result cache.
        patternCapTotal,
    });
    // Read-only search: grep no longer records a whole-file read snapshot.
    // That snapshot existed only to satisfy the apply_patch read-before-edit
    // guard, and computing it turned a single-file grep into rg PLUS a full
    // whole-file read+hash (recordReadSnapshot hashes the whole file when the
    // range covers it). Edit-safety is unaffected: the read and apply_patch
    // paths still record their own snapshots.

    const cached = cacheGet(cacheKey);
    // Cache-hit returns a PRIOR grep's output; the file may have changed since
    // that result was cached. Recording a fresh whole-file snapshot here would
    // mismatch what the caller actually saw (stale cached lines) and defeat
    // drift detection. So only the fresh-compute path (below) records a read.
    if (cached !== null) return cached;

    return await runResultCacheInFlight(cacheKey, async () => {
    let grepStat;
    try { grepStat = statSync(grepResolvedPath); }
    catch (err) {
        const enoentCache = {};
        const redirected = await tryReadFamilyEnoentRedirect({
            workDir,
            resolvedPath: grepResolvedPath,
            requestedPath: searchPath,
            errCode: err?.code,
            options,
            cache: enoentCache,
            rerun: (target, opts) => executeGrepTool(
                { ...args, path: target },
                workDir,
                executeChildBuiltinTool,
                readStateScope,
                opts,
            ),
        });
        if (redirected) return redirected;
        const msg = `Error: path does not exist: ${normalizeOutputPath(grepResolvedPath)} (${err?.code || 'ENOENT'})`;
        let hint = buildNotFoundHint(workDir, grepResolvedPath, 'Search', err?.code, enoentCache);
        if (!hint) hint = await _suggestIndexedPaths(grepResolvedPath, executeChildBuiltinTool, workDir);
        return msg + finalizeReadFamilyEnoentTail(hint, searchPath, err?.code);
    }
    const filenameOmitted = forceGrepFilename ? false : grepStat.isFile();

    // rg builds --glob overrides rooted at its process cwd and relativizes each
    // candidate against it with a CASE-SENSITIVE prefix strip; workDir is
    // case-normalized (lowercased) while callers pass real-cased absolute paths,
    // so the strip fails and slash-anchored globs (src/**/*.mjs) silently match
    // nothing. Spawn rg at the TRUE-CASED search root so relativization — and
    // therefore glob anchoring — always engages. Relative searchPath keeps the
    // workDir cwd (both sides already share workDir's casing).
    let rgSpawnCwd = workDir;
    if (isAbsolute(searchPath)) {
        searchPath = trueCasePath(searchPath);
        if (grepStat.isDirectory()) rgSpawnCwd = searchPath;
    }

    const GREP_CONTENT_HARD_CAP = 300;
    try {
        const callerExplicitUnlimited = headLimitCoerced === 0;
        const effectiveHeadLimit = headLimit === Infinity
            ? (callerExplicitUnlimited ? Infinity : (outputMode === 'content' ? GREP_CONTENT_HARD_CAP : Infinity))
            : headLimit;
        const rgArgs = buildGrepRgArgs({
            patterns,
            searchPath,
            globPatterns: normalizedGlobPatterns,
            outputMode,
            caseInsensitive,
            showLineNumbers,
            beforeN,
            afterN,
            contextN,
            multilineMode,
            fileType,
            onlyMatching: args['-o'] === true,
            pcre2: pcre2Mode,
            withFilename: forceGrepFilename,
        });
        // Parts 2 & 3: context mode windows MATCH BLOCKS (not raw lines); the
        // total match count and tail blocks come from the streamed (memory-
        // bounded) collection below.
        const contextMode = outputMode === 'content' && (beforeN > 0 || afterN > 0 || contextN > 0);
        if (contextMode) {
            // Finding 1: stream only enough lines to satisfy the block window
            // (offset + head_limit + tail reserve), so rg is stopped early and a
            // broad content_with_context never retains a full 20MB stdout copy.
            // A cap hit → complete:false → partial (lower-bound) phrasing below.
            const GREP_CONTEXT_LINE_HARD_CAP = 4000;
            const perBlock = 2 + (beforeN || 0) + (afterN || 0) + 2 * (contextN || 0);
            const blockBudget = headLimit === Infinity ? Infinity : offset + headLimit + 4;
            const lineCap = blockBudget === Infinity
                ? GREP_CONTEXT_LINE_HARD_CAP
                : Math.min(GREP_CONTEXT_LINE_HARD_CAP, Math.max(200, blockBudget * Math.max(1, perBlock) + 8));
            let ctxPartialSuffix = '';
            const streamed = await runRgWindowedLines(rgArgs, { cwd: rgSpawnCwd }, { offset: 0, limit: lineCap, summaryLimit: 0 });
            const allLines = streamed.lines;
            let ctxTotalKnown = streamed.complete;
            if (streamed.partial) {
                ctxTotalKnown = false;
                ctxPartialSuffix = streamed.timeout
                    ? '\n[warning] rg timed out; partial results shown. Narrow path/glob/pattern for a complete result.'
                    : streamed.rgStderr
                    ? `\n[warning] rg exit 2 (partial results): ${String(streamed.rgStderr).trim().slice(0, 300)}`
                    : '\n[warning] rg exit 2 (partial results)';
            } else if (!streamed.complete) {
                ctxPartialSuffix = `\n[warning] context output capped at ${lineCap} lines to bound memory; results partial — narrow path/glob/pattern for the full match set.`;
            }
            const ctx = formatGrepContextOutput({
                allLines,
                workDir,
                outputMode,
                filenameOmitted,
                headLimit,
                offset,
                totalKnown: ctxTotalKnown,
            });
            let ctxBody = ctx.text;
            if (!ctxBody) {
                const patternStr = patterns.length === 1 ? JSON.stringify(patterns[0]) : JSON.stringify(patterns);
                const globStr = normalizedGlobPatterns.length > 0 ? ` glob=${JSON.stringify(normalizedGlobPatterns)}` : '';
                const pathInfo = grepStat.isDirectory() ? 'path exists (dir)' : 'path exists (file)';
                ctxBody = `(no matches) pattern=${patternStr} path=${searchPath}${globStr}; ${pathInfo}`;
            }
            const ctxOut = patternCapNote + ctxBody + ctxPartialSuffix;
            if (options?.scopedCacheOutcome && (!ctxTotalKnown || ctx.omitted > 0)) {
                markScopedCacheIncomplete(options.scopedCacheOutcome);
            }
            if (ctxTotalKnown && ctx.omitted === 0) {
                cacheSet(cacheKey, ctxOut, { scopes: [grepResolvedPath] });
            }
            if (typeof options?.onProgress === 'function') {
                try { options.onProgress(`found ${ctx.total} matches`); } catch { /* best-effort */ }
            }
            return ctxOut;
        }
        let windowed;
        let totalWindowed = 0;
        let totalKnown = true;
        let rgPartialSuffix = '';
        if (effectiveHeadLimit !== Infinity) {
            const summaryLimit = outputMode === 'content' ? 120 : 0;
            const streamed = await runRgWindowedLines(rgArgs, { cwd: rgSpawnCwd }, {
                offset,
                limit: effectiveHeadLimit,
                summaryLimit,
            });
            windowed = streamed.lines;
            totalWindowed = streamed.totalSeen;
            totalKnown = streamed.complete;
            if (streamed.partial) {
                totalKnown = false;
                rgPartialSuffix = streamed.timeout
                    ? '\n[warning] rg timed out; partial results shown. Narrow path/glob/pattern for a complete result.'
                    : streamed.rgStderr
                    ? `\n[warning] rg exit 2 (partial results): ${String(streamed.rgStderr).trim().slice(0, 300)}`
                    : '\n[warning] rg exit 2 (partial results)';
            }
        } else {
            const stdout = await runRg(rgArgs, { cwd: rgSpawnCwd });
            const allLines = String(stdout).split('\n').filter(Boolean);
            windowed = offset > 0 ? allLines.slice(offset) : allLines;
            totalWindowed = windowed.length;
            // runRg boxes stdout + sets .truncated when the 20MB stdout cap
            // tripped (rg-runner). Mark the result incomplete so formatGrepOutput
            // emits the truncation notice instead of presenting it as complete.
            if (typeof stdout === 'object' && stdout.truncated) totalKnown = false;
            if (typeof stdout === 'object' && stdout.partial) {
                totalKnown = false;
                rgPartialSuffix = stdout.timeout
                    ? '\n[warning] rg timed out; partial results shown. Narrow path/glob/pattern for a complete result.'
                    : stdout.rgStderr
                    ? `\n[warning] rg exit 2 (partial results): ${String(stdout.rgStderr).trim().slice(0, 300)}`
                    : '\n[warning] rg exit 2 (partial results)';
            }
        }
        let body = formatGrepOutput({
            windowed,
            totalWindowed,
            totalKnown,
            headLimit,
            offset,
            outputMode,
            patterns,
            beforeN,
            afterN,
            contextN,
            searchPath,
            grepResolvedPath,
            workDir,
            globPatterns: normalizedGlobPatterns,
            fileType,
            filenameOmitted,
            disableContentGrouping: !!options._grepChunkMerge || !!options._grepPatternFanout,
        });
        if (!body) {
            const pathInfo = grepStat.isDirectory() ? 'path exists (dir)' : 'path exists (file)';
            const patternStr = patterns.length === 1 ? JSON.stringify(patterns[0]) : JSON.stringify(patterns);
            const globStr = normalizedGlobPatterns.length > 0 ? ` glob=${JSON.stringify(normalizedGlobPatterns)}` : '';
            body = `(no matches) pattern=${patternStr} path=${searchPath}${globStr}; ${pathInfo}`;
            // Cased-letter hint: a no-match single-pattern search whose pattern
            // carries cased letters may have failed only on case. Run ONE
            // case-insensitive probe; if it would match, nudge toward `-i`.
            // Skipped for arrays (single-pattern support is enough) and when
            // `-i` is already set or the pattern has no cased letters. Also
            // require a true zero-match search: an empty body with offset>0 (or
            // pre-offset matches) just means the window skipped past real
            // case-sensitive hits, so the hint would be misleading.
            const trueZeroMatch = offset === 0 && totalWindowed === 0;
            if (trueZeroMatch && !caseInsensitive && patterns.length === 1 && /[A-Za-z]/.test(patterns[0])) {
                try {
                    const probeArgs = buildGrepRgArgs({
                        patterns,
                        searchPath,
                        globPatterns: normalizedGlobPatterns,
                        outputMode: 'files_with_matches',
                        caseInsensitive: true,
                        showLineNumbers: false,
                        beforeN: null,
                        afterN: null,
                        contextN: null,
                        multilineMode,
                        fileType,
                        onlyMatching: false,
                    });
                    const probeOut = await runRg(probeArgs, { cwd: rgSpawnCwd });
                    if (String(probeOut).split('\n').some(Boolean)) {
                        body += ' (case-insensitive would match — try -i)';
                    }
                } catch { /* best-effort hint */ }
            }
        }
        const out = patternCapNote + body + rgPartialSuffix;
        const shownLines = headLimit === Infinity ? windowed : windowed.slice(0, headLimit);
        const remaining = Math.max(0, totalWindowed - shownLines.length);
        // Mirrors formatGrepOutput truncation / totalKnown semantics.
        if (options?.scopedCacheOutcome && (!totalKnown || remaining > 0)) {
            markScopedCacheIncomplete(options.scopedCacheOutcome);
        }
        if (totalKnown && remaining === 0) {
            cacheSet(cacheKey, out, { scopes: [grepResolvedPath] });
        }
        // ② completion progress (claude "Found N" parity). Best-effort,
        // no-op when onProgress is absent (no progressToken).
        if (typeof options?.onProgress === 'function') {
            try {
                let _n = totalWindowed;
                let _label = 'matches';
                if (outputMode === 'files_with_matches') {
                    _label = 'files';
                } else if (outputMode === 'count') {
                    _n = 0;
                    for (const _line of windowed) { const _c = parseGrepCountLine(_line); if (_c) _n += _c.count; }
                }
                options.onProgress(`found ${_n} ${_label}`);
            } catch { /* best-effort */ }
        }
        return out;
    }
    catch (err) {
        if (isRgRegexParseError(err) && !multilineMode) {
            const fixedPatterns = uniqueStrings(patterns.flatMap(regexPatternToFixedTerms));
            if (fixedPatterns.length > 0) {
                try {
                    const fallbackArgs = buildGrepRgArgs({
                        patterns: fixedPatterns,
                        searchPath,
                        globPatterns: normalizedGlobPatterns,
                        outputMode,
                        caseInsensitive,
                        showLineNumbers,
                        beforeN,
                        afterN,
                        contextN,
                        multilineMode: false,
                        fileType,
                        onlyMatching: args['-o'] === true,
                        fixedStrings: true,
                        withFilename: forceGrepFilename,
                    });
                    const effectiveHeadLimit = headLimit === Infinity
                        ? (outputMode === 'content' ? GREP_CONTENT_HARD_CAP : Infinity)
                        : headLimit;
                    let windowed;
                    let totalWindowed = 0;
                    let totalKnown = true;
                    let rgPartialSuffix = '';
                    if (effectiveHeadLimit !== Infinity) {
                        const streamed = await runRgWindowedLines(fallbackArgs, { cwd: rgSpawnCwd }, {
                            offset,
                            limit: effectiveHeadLimit,
                            summaryLimit: outputMode === 'content' ? 120 : 0,
                        });
                        windowed = streamed.lines;
                        totalWindowed = streamed.totalSeen;
                        totalKnown = streamed.complete;
                        if (streamed.partial) {
                            totalKnown = false;
                            rgPartialSuffix = streamed.timeout
                                ? '\n[warning] rg timed out; partial fixed-string fallback results shown.'
                                : streamed.rgStderr
                                ? `\n[warning] rg exit 2 (partial fixed-string fallback results): ${String(streamed.rgStderr).trim().slice(0, 300)}`
                                : '\n[warning] rg exit 2 (partial fixed-string fallback results)';
                        }
                    } else {
                        const stdout = await runRg(fallbackArgs, { cwd: rgSpawnCwd });
                        const allLines = String(stdout).split('\n').filter(Boolean);
                        windowed = offset > 0 ? allLines.slice(offset) : allLines;
                        totalWindowed = windowed.length;
                        if (typeof stdout === 'object' && stdout.truncated) totalKnown = false;
                        if (typeof stdout === 'object' && stdout.partial) {
                            totalKnown = false;
                            rgPartialSuffix = stdout.timeout
                                ? '\n[warning] rg timed out; partial fixed-string fallback results shown.'
                                : stdout.rgStderr
                                ? `\n[warning] rg exit 2 (partial fixed-string fallback results): ${String(stdout.rgStderr).trim().slice(0, 300)}`
                                : '\n[warning] rg exit 2 (partial fixed-string fallback results)';
                        }
                    }
                    const body = formatGrepOutput({
                        windowed,
                        totalWindowed,
                        totalKnown,
                        headLimit,
                        offset,
                        outputMode,
                        patterns: fixedPatterns,
                        beforeN,
                        afterN,
                        contextN,
                        searchPath,
                        grepResolvedPath,
                        workDir,
                        globPatterns: normalizedGlobPatterns,
                        fileType,
                        filenameOmitted,
                        prefix: patternCapNote + '[regex parse fallback: fixed-string terms]\n',
                    }) || `(no matches) fixed_terms=${JSON.stringify(fixedPatterns)} path=${searchPath}`;
                    return body + rgPartialSuffix;
                } catch { /* fall through to the original rg error */ }
            }
        }
        const stderr = err?.stderr ? String(err.stderr).trim() : '';
        const msg = stderr || err?.message || String(err);
        return `Error: ${msg.slice(0, 500)}`;
    }
    });
}

export async function executeGlobTool(args, workDir, options = {}) {
    args = normalizeGlobArgs(args);
    args.path = coerceReadFamilyPathArg(args.path, workDir);
    if (Array.isArray(args.path)) {
        const GLOB_PATH_CAP = 10;
        const seen = new Set();
        const list = args.path
            .map((p) => (typeof p === 'string' ? stripEmbeddedPathQuotes(normalizeInputPath(p)).trim() : ''))
            .filter((p) => p && !seen.has(p) && seen.add(p));
        if (list.length > 1) {
            const capped = list.slice(0, GLOB_PATH_CAP);
            // Independent per-path globs run concurrently; assemble sections in
            // the original (capped) order so output stays identical.
            const bodies = await Promise.all(capped.map(async (p) => {
                try {
                    return await executeGlobTool({ ...args, path: p }, workDir, options);
                } catch (err) {
                    return `Error: ${err && err.message ? err.message : err}`;
                }
            }));
            const parts = capped.map((p, i) => `# glob ${p}\n${bodies[i]}`);
            if (list.length > GLOB_PATH_CAP) {
                parts.push(`[capped at ${GLOB_PATH_CAP} of ${list.length} paths]`);
                // Omitted paths mean the returned listing is not the whole
                // requested set — never cache it as complete.
                if (options?.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
            }
            return parts.join('\n\n');
        }
        args.path = list[0] ?? '.';
    } else {
        args.path = stripEmbeddedPathQuotes(normalizeInputPath(args.path));
    }
    if (Array.isArray(args.path) && args.path.length === 0) {
        args.path = '.';
    }
    args.pattern = coerceShapeFlex(args.pattern);
    const rawPattern = args.pattern;
    // ripgrep `--glob` matchers use forward slashes on all platforms;
    // canonicalize `\`→`/` (win32 only) so a `**\*.ts` pattern matches
    // instead of being parsed as an escape sequence.
    let patterns = uniqueStrings((Array.isArray(rawPattern)
        ? rawPattern.filter(p => typeof p === 'string' && p)
        : (rawPattern ? [String(rawPattern)] : [])).map(normalizeInputPath).map(canonicalizeGlobSlashes));
    if (patterns.length === 0) {
        if (Array.isArray(args.path)) {
            const pathGlobs = args.path.filter((p) => hasGlobMagic(p));
            if (pathGlobs.length > 0 && pathGlobs.length === args.path.length) {
                patterns = uniqueStrings(pathGlobs.map(normalizeInputPath).map(canonicalizeGlobSlashes));
                args.path = undefined;
            }
        } else if (hasGlobMagic(args.path)) {
            patterns = [canonicalizeGlobSlashes(normalizeInputPath(args.path))];
            args.path = undefined;
        }
    }
    if (patterns.length === 0) {
        patterns = ['*'];
    }
    const GLOB_PATTERN_ARRAY_CAP = 10;
    let globPatternCapNote = '';
    let globPatternCapTotal = 0;
    if (patterns.length > GLOB_PATTERN_ARRAY_CAP) {
        globPatternCapNote = `[capped at ${GLOB_PATTERN_ARRAY_CAP} of ${patterns.length} patterns]\n`;
        globPatternCapTotal = patterns.length;
        patterns = patterns.slice(0, GLOB_PATTERN_ARRAY_CAP);
        // Omitted patterns: mark the scoped cache incomplete and (below) key the
        // internal cache on the original count so a capped glob never collides
        // with an exact N-pattern request or is served as the whole set.
        if (options?.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
    }

    const basePaths = (Array.isArray(args.path) && args.path.length > 0)
        ? args.path
        : [args.path || '.'];
    // Call-scoped stat cache: the preflight below stats each root, the per-group
    // rg runs re-stat the same resolved cwd, and the empty-result diagnostic
    // stats it a third time. Memoize by resolved path so each root is stat'd once.
    const statCache = new Map();
    const statCached = (resolvedPath) => {
        if (statCache.has(resolvedPath)) return statCache.get(resolvedPath);
        let entry;
        try { entry = { st: statSync(resolvedPath), err: null }; }
        catch (err) { entry = { st: null, err }; }
        statCache.set(resolvedPath, entry);
        return entry;
    };
    if (!options._enoentRedirectFrom) {
        for (const only of basePaths) {
            const resolvedOnly = resolveSearchScope(only, workDir);
            const pre = statCached(resolvedOnly);
            if (pre.err) {
                const redirected = await tryReadFamilyEnoentRedirect({
                    workDir,
                    resolvedPath: resolvedOnly,
                    requestedPath: only,
                    errCode: pre.err?.code,
                    options,
                    rerun: (target, opts) => executeGlobTool({ ...args, path: target }, workDir, opts),
                });
                if (redirected) return redirected;
            }
        }
    }
    // A base path carrying glob magic (path:'src/**/cache/*') names a SET of
    // directories, not a literal one — resolving it literally ENOENTs. Split
    // it the way grep's path handling does: walk from the static baseDir and
    // fold the magic suffix into each pattern under that root.
    const baseEntries = basePaths.map((basePath) => {
        if (typeof basePath !== 'string' || !hasGlobMagic(basePath)) return { root: basePath, prefix: '' };
        const { baseDir, relativePattern } = extractGlobBaseDirectory(canonicalizeGlobSlashes(basePath));
        // A trailing pure-`*` segment ("cache/*") means "the children" — the
        // pattern itself supplies the leaf match, so nesting it one level
        // deeper ("*/<pat>") would skip files directly under the dir. Drop
        // that segment; `**` and mid-path magic still nest.
        const segs = relativePattern.replace(/^\//, '').split('/').filter(Boolean);
        if (segs[segs.length - 1] === '*') segs.pop();
        return { root: baseDir || '.', prefix: segs.join('/') };
    });
    const resolvedSearchRoots = new Map();
    function resolvedForSearchRoot(root) {
        if (!resolvedSearchRoots.has(root)) {
            resolvedSearchRoots.set(root, resolveSearchScope(root, workDir));
        }
        return resolvedSearchRoots.get(root);
    }
    for (const e of baseEntries) {
        if (isUncOrSmbPath(e.root)) {
            return uncRefusalMessage('glob', e.root, e.root);
        }
        const resolvedBase = resolvedForSearchRoot(e.root);
        if (isUncOrSmbPath(resolvedBase)) {
            return uncRefusalMessage('glob', e.root, resolvedBase);
        }
    }
    for (const p of patterns) {
        if (isAbsolute(p) && isUncOrSmbPath(p)) {
            return uncRefusalMessage('glob', p, p);
        }
    }
    const headLimitRaw = args.head_limit;
    const headLimitCoerced = coerceNonNegInt(headLimitRaw);
    if (Number.isNaN(headLimitCoerced)) {
        return `Error: invalid head_limit ${JSON.stringify(headLimitRaw)}; expected a non-negative integer (0 = unlimited)`;
    }
    const headLimit = headLimitCoerced === null
        ? 100
        : (headLimitCoerced === 0 ? Infinity : headLimitCoerced);
    const offsetCoerced = coerceNonNegInt(args.offset);
    if (Number.isNaN(offsetCoerced)) {
        return `Error: invalid offset ${JSON.stringify(args.offset)}; expected a non-negative integer`;
    }
    const offset = offsetCoerced === null || offsetCoerced === 0 ? 0 : offsetCoerced;
    const rawSort = typeof args.sort === 'string' ? args.sort.trim() : '';
    const sortMode = rawSort === 'mtime' ? 'mtime' : 'natural';
    // Internal-only ignore extension (see normalizeGlobArgs). Caller (e.g.
    // ai-wrapped-dispatch broad-cwd preflight) appends basename ignore globs
    // so head_limit bounds SOURCE entries rather than artifact noise.
    const extraIgnoreGlobs = Array.isArray(args._extraIgnoreDirs)
        ? args._extraIgnoreDirs.map((name) => `!**/${name}/**`)
        : [];
    const groups = new Map();
    function addToGroup(root, rel) {
        if (!groups.has(root)) groups.set(root, []);
        const rels = groups.get(root);
        if (!rels.includes(rel)) rels.push(rel);
    }
    for (const p of patterns) {
        if (isAbsolute(p)) {
            const { baseDir, relativePattern } = extractGlobBaseDirectory(p);
            addToGroup(baseDir || baseEntries[0]?.root || '.', relativePattern);
        } else {
            for (const e of baseEntries) addToGroup(e.root, e.prefix ? `${e.prefix}/${p}` : p);
        }
    }

    const cacheBasePath = [...groups.keys()]
        .map((root) => normalizeOutputPath(resolvedForSearchRoot(root)))
        .sort()
        .join('\x01');
    const cacheKey = buildGlobCacheKey({ patterns, basePath: cacheBasePath, headLimit, offset, extraIgnore: extraIgnoreGlobs, sort: sortMode, patternCapTotal: globPatternCapTotal });
    const cached = cacheGet(cacheKey);
    if (cached !== null) return cached;

    return await runResultCacheInFlight(cacheKey, async () => {
    const globGroups = [...groups.entries()];

    const allFiles = [];
    const rgErrors = [];
    let accumTruncated = false;
    let rgStdoutTruncated = false;
    let rgStdoutPartial = false;
    const accumCap = 50000;
    const groupRuns = await Promise.all(globGroups.map(async ([root, rels]) => {
        const rgArgs = ['--files', '--hidden'];
        for (const ex of DEFAULT_IGNORE_GLOBS) rgArgs.push('--glob', ex);
        for (const ex of extraIgnoreGlobs) rgArgs.push('--glob', ex);
        for (const rel of rels) rgArgs.push('--glob', rel);
        const rgCwd = resolvedForSearchRoot(root);
        rgArgs.push('.');
        const cwdStat = statCached(rgCwd);
        if (cwdStat.err) {
            const err = cwdStat.err;
            // One shared ENOENT scan cache for the redirect probe + not-found
            // hint (both resolve the same missing rgCwd).
            const groupEnoentCache = {};
            const redirected = await tryReadFamilyEnoentRedirect({
                workDir,
                resolvedPath: rgCwd,
                requestedPath: root,
                errCode: err?.code,
                options,
                cache: groupEnoentCache,
                rerun: (target, opts) => executeGlobTool({ ...args, path: target }, workDir, opts),
            });
            if (redirected) {
                return {
                    error: null,
                    paths: [],
                    stdoutTruncated: false,
                    redirected,
                };
            }
            const hint = buildNotFoundHint(workDir, rgCwd, 'Search', err?.code, groupEnoentCache);
            return {
                error: `path does not exist: ${normalizeOutputPath(rgCwd)} (${err?.code || 'ENOENT'})${finalizeReadFamilyEnoentTail(hint, root, err?.code)}`,
                paths: [],
                stdoutTruncated: false,
            };
        }
        try {
            const stdout = await runRg(rgArgs, { cwd: rgCwd, timeout: 10000 });
            const stdoutTruncated = Boolean(stdout && typeof stdout === 'object' && stdout.truncated);
            const stdoutPartial = Boolean(stdout && typeof stdout === 'object' && stdout.partial);
            const paths = [];
            for (const line of String(stdout).split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                paths.push(isAbsolute(trimmed) ? trimmed : resolveAgainstCwd(trimmed, rgCwd));
            }
            return { error: null, paths, stdoutTruncated, stdoutPartial };
        } catch (err) {
            const stderr = String(err?.stderr || err?.message || err).trim().split('\n').slice(0, 3).join('; ');
            return {
                error: `rg failed for ${normalizeOutputPath(root)}: ${stderr || 'unknown error'}`,
                paths: [],
                stdoutTruncated: false,
                stdoutPartial: false,
            };
        }
    }));

    outer: for (const run of groupRuns) {
        if (run.redirected) return run.redirected;
        if (run.error) {
            rgErrors.push(run.error);
            continue;
        }
        if (run.stdoutTruncated) rgStdoutTruncated = true;
        if (run.stdoutPartial) rgStdoutPartial = true;
        for (const p of run.paths) {
            allFiles.push(p);
            if (allFiles.length >= accumCap) {
                accumTruncated = true;
                break outer;
            }
        }
    }
    if (rgErrors.length > 0 && allFiles.length === 0) {
        return `Error: ${rgErrors.join(' | ').slice(0, 500)}`;
    }

    const unique = Array.from(new Set(allFiles));
    let orderedPaths;
    if (sortMode === 'mtime') {
        // Opt-in mtime sorting is intentionally slower: it stats every match.
        // Bound the post-rg stat phase so a hung mount cannot pin glob until
        // the agent stall watchdog fires.
        const withStatAll = await statPathsForMtime(unique, workDir, 64, { deadlineMs: 5000 });
        const withStat = withStatAll.filter((entry) => entry?.stat != null);
        withStat.sort((a, b) => {
            const dm = b.mtime - a.mtime;
            if (dm !== 0) return dm;
            return globMtimeTiePath(a).localeCompare(globMtimeTiePath(b));
        });
        orderedPaths = withStat.map((entry) => entry.full || resolveAgainstCwd(entry.path, workDir));
    } else {
        orderedPaths = unique.map((entry) => isAbsolute(entry) ? resolve(entry) : resolveAgainstCwd(entry, workDir));
    }
    const totalBeforeOffset = orderedPaths.length;
    const windowed = offset > 0 ? orderedPaths.slice(offset) : orderedPaths;
    const capped = (headLimit === Infinity ? windowed : windowed.slice(0, headLimit))
        .map((abs) => relativeSearchResultPath(abs, workDir));
    const remaining = windowed.length - capped.length;
    const truncSuffix = accumTruncated
        ? '\n... [truncated at accumulation cap (50000)]'
        : (rgStdoutTruncated ? '\n... [truncated at rg stdout cap (20MB); results incomplete]' : '')
            + (rgStdoutPartial ? '\n... [warning] rg exit 2 (partial results); listing may be incomplete' : '');
    const errSuffix = (rgErrors.length > 0 ? `\n... [warning] ${rgErrors.join(' | ')}` : '') + truncSuffix;
    let emptyDiag = '';
    if (capped.length === 0 && rgErrors.length === 0) {
        const patternStr = patterns.length === 1 ? JSON.stringify(patterns[0]) : JSON.stringify(patterns);
        const baseLabel = basePaths.length === 1 ? normalizeOutputPath(basePaths[0]) : `[${basePaths.map(normalizeOutputPath).join(', ')}]`;
        if (totalBeforeOffset > 0 && offset >= totalBeforeOffset) {
            emptyDiag = `(no entries after offset=${offset}; total=${totalBeforeOffset}) pattern=${patternStr} path=${baseLabel}`;
        } else {
            emptyDiag = `(no files found) pattern=${patternStr} path=${baseLabel}; ${basePathDiagnostic(baseEntries.map((e) => e.root), workDir, statCache)}`;
        }
    }
    const body = capped.length > 0
        ? `${capped.join('\n')}${remaining > 0 ? `\n... [${remaining} more entries of ${totalBeforeOffset} total — pass offset:${offset + capped.length} to continue]` : ''}${errSuffix}`
        : '';
    const out = globPatternCapNote + (body || emptyDiag || '(no files found)');
    if (options?.scopedCacheOutcome && (accumTruncated || rgStdoutTruncated || rgStdoutPartial || remaining > 0)) {
        markScopedCacheIncomplete(options.scopedCacheOutcome);
    }
    const globIncomplete = accumTruncated || rgStdoutTruncated || rgStdoutPartial || remaining > 0;
    if (!globIncomplete) {
        cacheSet(cacheKey, out, { scopes: [...groups.keys()].map((root) => resolvedForSearchRoot(root)) });
    }
    // ② completion progress (claude "Found N" parity). Best-effort, no-op
    // when onProgress is absent (no progressToken).
    if (typeof options?.onProgress === 'function') {
        try { options.onProgress(`found ${totalBeforeOffset} files`); } catch { /* best-effort */ }
    }
    return out;
    });
}
