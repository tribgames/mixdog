import { statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'crypto';
import { isAbsolute, resolve } from 'path';
import { trueCasePath } from './path-utils.mjs';
import {
    canonicalizeGlobSlashes,
    coerceReadFamilyPathArg,
    coerceShapeFlex,
    extractGlobBaseDirectory,
    GREP_AUTO_CONTEXT_LINES,
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
import { runRg, runRgWindowedLines, rgSupportsPcre2 } from './native-search-runner.mjs';
import { markScopedCacheIncomplete } from '../../session/cache/scoped-cache-outcome.mjs';
import {
    normalizeGrepLine,
    splitGrepCountPrefix,
} from './grep-formatting.mjs';
import {
    cacheGet,
    cacheSet,
    runResultCacheInFlight,
    statPathsForMtime,
} from './cache-layers.mjs';
import { recordLocalSearchCacheHit } from './local-search-telemetry.mjs';
import { applyGrepContextLeadPolicy, GREP_CONTEXT_MAX, hasUnsupportedRipgrepRegex } from './arg-guard.mjs';
import {
    buildGrepChunkMergePrefix,
    chunkPatternList,
    computeGrepChunkAggregateBudget,
    extractGrepChunkResultLines,
    mergeGrepChunkLines,
} from './lib/search-grep-chunks.mjs';
import {
    expandLegacyEscapedAlternationPattern,
    relativeGrepLine,
    uniqueStrings,
    isRgRegexParseError,
    regexPatternToFixedTerms,
    coerceNonNegInt,
    globMtimeTiePath,
    splitGlobString,
    isRedundantAllFilesGlob,
    parseGrepCountLine,
} from './lib/search-input-helpers.mjs';
import { assertPathReachable } from './fs-reachability.mjs';

// A single glob string may pack multiple filters
// separated by whitespace or commas, e.g. "*.ts,*.tsx" or "*.ts *.tsx". Split
// each into its own --glob. Brace patterns ("*.{ts,tsx}") are left intact so
// their internal commas are not torn apart.

// Grep output rendering (context-block windowing, fan-out dedupe, notices)
// lives in lib/grep-output.mjs.
import {
    dedupeFanoutMatchLines,
    formatGrepContextOutput,
    formatGrepOutput,
    globMissingPatternMessage,
    grepMissingPatternMessage,
} from './lib/grep-output.mjs';
import {
    expandGrepAnchorContextOutput,
    GREP_CONTEXT_CHAR_BUDGET_DEFAULT,
} from './lib/grep-context-expander.mjs';

async function statReachable(path) {
    const reachable = await assertPathReachable(path);
    return reachable || await stat(path);
}

// Default grep result cap when head_limit is unspecified. 250 is the common
// harness default; the tool-result offload layer still bounds oversized
// results. MIXDOG_GREP_DEFAULT_HEAD_LIMIT overrides for A/B runs.
function _grepDefaultHeadLimit() {
    const parsed = parseInt(process.env.MIXDOG_GREP_DEFAULT_HEAD_LIMIT ?? '', 10);
    return parsed > 0 ? parsed : 250;
}
// Same A/B override surface for glob (stock default 100).
function _globDefaultHeadLimit() {
    const parsed = parseInt(process.env.MIXDOG_GLOB_DEFAULT_HEAD_LIMIT ?? '', 10);
    return parsed > 0 ? parsed : 100;
}

function _grepContextCharBudget(options = {}) {
    const explicit = Number(options?._grepContextCharBudget);
    if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
    const configured = Number(process.env.MIXDOG_GREP_CONTEXT_CHAR_BUDGET);
    return Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : GREP_CONTEXT_CHAR_BUDGET_DEFAULT;
}

export async function executeGrepTool(args, workDir, executeChildBuiltinTool, readStateScope = null, options = {}) {
    args = normalizeGrepArgs(args);
    args.path = coerceReadFamilyPathArg(args.path, workDir);
    const callContextCharBudget = _grepContextCharBudget(options);
    // Batch multiple string paths concurrently. Recursive calls pass a single
    // string path, so recursion bottoms out after one level. Results retain
    // input order even though every path starts immediately.
    if (Array.isArray(args.path)) {
        const seen = new Set();
        const list = args.path
            .map(p => typeof p === 'string' ? p.trim() : '')
            .filter(p => p && !seen.has(p) && seen.add(p));
        if (list.length > 1) {
            const capped = list;
            // Combined single-spawn path[] fan-out (mirrors the pattern[]
            // combined path below): ONE rg run with every path as a positional
            // operand, then normalized-prefix attribution rebuilds the
            // per-path sections — P paths cost 1 child spawn instead of P.
            // Narrow eligibility: single pattern, no glob/type, default
            // flags, content-ish or files_with_matches mode, every path
            // resolving to an existing non-UNC file/dir. Anything else falls
            // through to the legacy bounded-concurrency fan-out (which owns
            // per-path ENOENT/UNC diagnostics). MIXDOG_GREP_PATH_COMBINED=0
            // disables.
            combinedPaths: if (process.env.MIXDOG_GREP_PATH_COMBINED !== '0'
                && !args.glob
                && !args.type
                && args.multiline !== true
                && args['-o'] !== true
                && args['-n'] !== false
                && args['-A'] === undefined
                && args['-B'] === undefined) {
                const rawPat = coerceShapeFlex(args.pattern);
                const singleList = Array.isArray(rawPat)
                    ? rawPat.filter((p) => typeof p === 'string' && p)
                    : (typeof rawPat === 'string' && rawPat ? [rawPat] : []);
                if (singleList.length !== 1) break combinedPaths;
                const pattern = normalizeSearchPattern(singleList[0]);
                if (!pattern || /\\n/.test(pattern) || hasUnsupportedRipgrepRegex([pattern])) break combinedPaths;
                const rawMode = typeof args.output_mode === 'string' ? args.output_mode.trim() : '';
                if (!['', 'content', 'content_with_context', 'files_with_matches'].includes(rawMode)) break combinedPaths;
                const outMode = rawMode === 'files_with_matches' ? 'files_with_matches' : 'content';
                // Keep in sync with the canonical single-path parsing below.
                const hlRaw = coerceNonNegInt(args.head_limit);
                if (Number.isNaN(hlRaw)) break combinedPaths;
                const headLimit = hlRaw === null ? _grepDefaultHeadLimit() : (hlRaw === 0 ? Infinity : hlRaw);
                const offRaw = coerceNonNegInt(args.offset);
                if (Number.isNaN(offRaw)) break combinedPaths;
                const offset = offRaw === null ? 0 : offRaw;
                const ctxRaw = args['-C'] !== undefined && args['-C'] !== null && args['-C'] !== ''
                    ? args['-C']
                    : args.context;
                let contextN = null;
                if (ctxRaw !== undefined && ctxRaw !== null && ctxRaw !== '') {
                    const n = Number(ctxRaw);
                    if (!Number.isFinite(n) || n < 0) break combinedPaths;
                    contextN = Math.min(Math.floor(n), GREP_CONTEXT_MAX);
                }
                if (outMode === 'content' && contextN === null && (rawMode === '' || rawMode === 'content_with_context')) {
                    contextN = GREP_AUTO_CONTEXT_LINES;
                }
                const caseInsensitive = args['-i'] === true;
                const roots = [];
                for (const p of capped) {
                    const cleaned = stripEmbeddedPathQuotes(normalizeInputPath(p));
                    if (hasGlobMagic(cleaned)) break combinedPaths;
                    const resolved = resolveSearchScope(cleaned, workDir);
                    if (isUncOrSmbPath(cleaned) || isUncOrSmbPath(resolved)) break combinedPaths;
                    let st;
                    try { st = await statReachable(resolved); } catch { break combinedPaths; }
                    roots.push({
                        arg: p,
                        abs: normalizeOutputPath(isAbsolute(resolved) ? await trueCasePath(resolved) : resolved),
                        isDir: st.isDirectory(),
                    });
                }
                const rgArgs = buildGrepRgArgs({
                    patterns: [pattern],
                    searchPath: workDir,
                    globPatterns: [],
                    outputMode: outMode,
                    caseInsensitive,
                    showLineNumbers: true,
                    beforeN: null,
                    afterN: null,
                    contextN: null,
                    multilineMode: false,
                    fileType: '',
                    onlyMatching: false,
                    pcre2: false,
                    withFilename: true,
                    candidateFiles: roots.map((r) => r.abs),
                });
                const perWindow = headLimit === Infinity ? 300 : (offset + headLimit + 4);
                const cap = Math.min(4000, Math.max(400, perWindow * roots.length));
                let streamed;
                try {
                    streamed = await runRgWindowedLines(
                        rgArgs,
                        { cwd: workDir, signal: options.signal },
                        { offset: 0, limit: cap, summaryLimit: 0 },
                    );
                } catch { break combinedPaths; }
                if (!streamed.complete || streamed.partial) break combinedPaths;
                // rg echoes each match under the operand path exactly as
                // passed (normalized absolute), so normalized-prefix compare
                // is exact. Nested roots duplicate a line into every
                // containing section, matching legacy independent scans.
                const ci = process.platform === 'win32';
                const keyOf = (s) => (ci ? s.toLowerCase() : s);
                const wdFwd = normalizeOutputPath(workDir).replace(/\/+$/, '');
                const byRoot = roots.map(() => []);
                for (const line of streamed.lines) {
                    const norm = line.replace(/\\/g, '/');
                    const lineKey = keyOf(norm);
                    for (let i = 0; i < roots.length; i++) {
                        const rootKey = keyOf(roots[i].abs);
                        if (lineKey === rootKey
                            || lineKey.startsWith(rootKey + '/')
                            || lineKey.startsWith(rootKey + ':')) {
                            // Re-relativize against workDir so section bodies
                            // render like a workDir-rooted search.
                            const rel = lineKey.startsWith(keyOf(wdFwd) + '/')
                                ? norm.slice(wdFwd.length + 1)
                                : line;
                            byRoot[i].push(rel);
                        }
                    }
                }
                const perBudget = Math.max(512, Math.floor(callContextCharBudget / roots.length));
                const sections = [];
                const noMatchRoots = [];
                for (let i = 0; i < roots.length; i++) {
                    const r = roots[i];
                    const linesFor = byRoot[i];
                    const noMatch = `(no matches) pattern=${JSON.stringify(pattern)} path=${r.arg}; path exists (${r.isDir ? 'dir' : 'file'})`;
                    let body;
                    if (linesFor.length === 0) {
                        noMatchRoots.push(r.arg);
                        continue;
                    } else if (outMode === 'content' && contextN > 0) {
                        const ctx = await expandGrepAnchorContextOutput({
                            allLines: linesFor,
                            workDir,
                            rgSpawnCwd: wdFwd,
                            grepResolvedPath: r.abs,
                            searchPath: r.arg,
                            outputMode: outMode,
                            filenameOmitted: false,
                            headLimit,
                            offset,
                            totalKnown: true,
                            requestedContext: contextN,
                            maxContext: GREP_AUTO_CONTEXT_LINES,
                            patterns: [pattern],
                            caseInsensitive,
                            charBudget: perBudget,
                            signal: options.signal,
                        });
                        body = ctx.text || noMatch;
                    } else {
                        const post = offset > 0 ? linesFor.slice(offset) : linesFor;
                        const windowedLines = headLimit === Infinity ? post : post.slice(0, headLimit);
                        // Match the legacy per-path presentation: a FILE root
                        // drops the filename prefix (its section header already
                        // names the file) and a DIR root keeps grouped-by-file
                        // rendering.
                        const rootRel = keyOf(r.abs).startsWith(keyOf(wdFwd) + '/')
                            ? r.abs.slice(wdFwd.length + 1)
                            : r.abs;
                        const rendered = r.isDir
                            ? windowedLines
                            : windowedLines.map((l) => {
                                const lineFwd = l.replace(/\\/g, '/');
                                return keyOf(lineFwd).startsWith(keyOf(rootRel) + ':')
                                    ? lineFwd.slice(rootRel.length + 1)
                                    : l;
                            });
                        body = formatGrepOutput({
                            windowed: rendered,
                            totalWindowed: post.length,
                            totalKnown: true,
                            headLimit,
                            offset,
                            outputMode: outMode,
                            patterns: [pattern],
                            beforeN: null,
                            afterN: null,
                            contextN,
                            searchPath: r.arg,
                            grepResolvedPath: r.abs,
                            workDir,
                            globPatterns: [],
                            fileType: '',
                            filenameOmitted: !r.isDir,
                            prefix: '',
                        });
                    }
                    sections.push(`# grep ${r.arg}\n${body}`);
                }
                if (noMatchRoots.length > 0) {
                    sections.push(`(no matches) pattern=${JSON.stringify(pattern)} paths: ${noMatchRoots.join(', ')}; paths exist`);
                }
                return sections.join('\n\n');
            }
            const nestedOptions = {
                ...options,
                _grepPathFanout: true,
                _grepContextCharBudget: Math.max(512, Math.floor(callContextCharBudget / capped.length)),
            };
            const configuredOutputCap = Number(options?.toolOutputMaxBytes) > 0
                ? Math.trunc(Number(options.toolOutputMaxBytes))
                : Math.trunc(Number(process.env.MIXDOG_TOOL_OUTPUT_MAX_BYTES));
            const bodies = await Promise.all(capped.map(async (p) => {
                try {
                    return await executeGrepTool(
                        { ...args, path: p },
                        workDir,
                        executeChildBuiltinTool,
                        readStateScope,
                        nestedOptions,
                    );
                } catch (err) {
                    return `Error: ${err && err.message ? err.message : err}`;
                }
            }));
            const parts = capped.map((p, index) => `# grep ${p}\n${bodies[index]}`);
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
    // Rescue: a pattern containing an unescaped two-char "\n" (backslash + n)
    // outside multiline mode makes rg hard-error with "the literal '\"\\n\"'
    // is not allowed in a regex" — rg requires -U/--multiline before a
    // pattern is allowed to match across a newline. An even backslash run
    // (`\\n`) searches source text containing "\n" and must stay single-line.
    const hasRegexNewlineEscape = (pattern) => {
        const text = String(pattern || '');
        for (let index = 0; index < text.length; index++) {
            if (text[index] !== 'n') continue;
            let slashes = 0;
            for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) slashes++;
            if (slashes % 2 === 1) return true;
        }
        return false;
    };
    const patternsWantMultiline = patterns.some(hasRegexNewlineEscape);
    const multilineMode = args.multiline === true || patternsWantMultiline;
    // Rescue: lookaround/backreference patterns are rejected by rg's default
    // Rust regex engine rejects lookaround/backreferences. The embedded native
    // PCRE2 matcher accepts the same syntax via -P/--pcre2.
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
        // Literal-first: {slug}.md and [id].tsx are REAL filenames in web
        // projects. A magic-looking path that stats as-is IS the target —
        // reinterpreting it as base+glob silently searched the parent with a
        // brace-expanded filter and returned "(no matches)" for an existing
        // file. Only a non-existent magic path is split into base + glob.
        let literalExists = false;
        try { await statReachable(resolveSearchScope(searchPath, workDir)); literalExists = true; } catch { /* fall through to glob split */ }
        if (!literalExists) {
            const { baseDir, relativePattern } = extractGlobBaseDirectory(searchPath);
            searchPath = baseDir || '.';
            rawGlobs.unshift(relativePattern.replace(/^\//, ''));
        }
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
        return `Error: invalid limit ${JSON.stringify(headLimitRaw)}; expected a non-negative integer (0 = unlimited)`;
    }
    const headLimit = headLimitCoerced === null
        ? _grepDefaultHeadLimit()
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
        // Fan-out prefilter, started CONCURRENTLY with the combined attempt
        // below: ONE rg --files-with-matches pass over ALL patterns yields
        // every file any pattern touches. The combined single-spawn path
        // returns without ever awaiting it; the frequent match-heavy bail
        // path (cap/partial) used to pay this pass as a THIRD serial rg wave
        // — overlapping it with the combined attempt removes one full spawn
        // round-trip (~100ms on win32) from every bailed multi-pattern grep.
        // Owner-fair gating keeps the speculative spawn a self-cost of this
        // call. Best-effort: any failure/cap/partial falls back to the
        // unscoped fan-out unchanged. MIXDOG_GREP_FANOUT_PREFILTER=0 disables.
        const GREP_FANOUT_PREFILTER_FILE_CAP = 400;
        const startFanoutPrefilter = async () => {
            try {
                let preSpawnCwd = workDir;
                let preSearchPath = searchPath;
                const preStat = await statReachable(grepResolvedPath);
                if (!preStat.isDirectory()) return null;
                if (isAbsolute(preSearchPath)) {
                    preSearchPath = await trueCasePath(preSearchPath);
                    preSpawnCwd = preSearchPath;
                }
                const prefilterArgs = buildGrepRgArgs({
                    patterns,
                    searchPath: preSearchPath,
                    globPatterns: normalizedGlobPatterns,
                    outputMode: 'files_with_matches',
                    caseInsensitive,
                    showLineNumbers: false,
                    beforeN: null,
                    afterN: null,
                    contextN: null,
                    multilineMode,
                    fileType,
                    onlyMatching: false,
                    pcre2: pcre2Mode,
                    withFilename: false,
                });
                const pre = await runRgWindowedLines(
                    prefilterArgs,
                    { cwd: preSpawnCwd, signal: options.signal },
                    { offset: 0, limit: GREP_FANOUT_PREFILTER_FILE_CAP, summaryLimit: 0 },
                );
                return pre.complete && !pre.partial ? pre.lines : null;
            } catch { return null; }
        };
        const fanoutPrefilterPromise = process.env.MIXDOG_GREP_FANOUT_PREFILTER !== '0'
            ? startFanoutPrefilter()
            : null;
        // Combined single-spawn fan-out: ONE rg run carrying every pattern
        // (-e p1 -e p2 …), then JS-side attribution of each matched line back
        // to its pattern(s) rebuilds the per-pattern sections. K patterns cost
        // 1 child spawn instead of K: under the win32 child-spawn gate the
        // per-spawn queue/AV overhead — not scan size — dominates fan-out
        // cost. Eligibility mirrors the per-pattern paths this replaces;
        // anything exotic (multiline, -o, hidden line numbers, JS-alien
        // regex, non-dir scope, capped/partial stream) falls through to the
        // legacy per-pattern fan-out below. MIXDOG_GREP_FANOUT_COMBINED=0
        // disables.
        combined: if (process.env.MIXDOG_GREP_FANOUT_COMBINED !== '0'
            && !multilineMode
            && args['-o'] !== true
            && showLineNumbers) {
            let jsRegexps;
            try {
                jsRegexps = patterns.map((p) => new RegExp(p, caseInsensitive ? 'i' : ''));
            } catch { break combined; }
            let preStat;
            try { preStat = await statReachable(grepResolvedPath); } catch { break combined; }
            if (!preStat.isDirectory()) break combined;
            let rgCwd = workDir;
            let rgSearchPath = searchPath;
            if (isAbsolute(rgSearchPath)) {
                rgSearchPath = await trueCasePath(rgSearchPath);
                rgCwd = rgSearchPath;
            }
            const combinedArgs = buildGrepRgArgs({
                patterns,
                searchPath: rgSearchPath,
                globPatterns: normalizedGlobPatterns,
                outputMode,
                caseInsensitive,
                showLineNumbers: true,
                beforeN: null,
                afterN: null,
                contextN: null,
                multilineMode: false,
                fileType,
                onlyMatching: false,
                pcre2: pcre2Mode,
                withFilename: true,
            });
            const perPatternWindow = headLimit === Infinity ? 300 : (offset + headLimit + 4);
            const combinedCap = Math.min(4000, Math.max(400, perPatternWindow * patterns.length));
            let streamed;
            try {
                streamed = await runRgWindowedLines(
                    combinedArgs,
                    { cwd: rgCwd, signal: options.signal },
                    { offset: 0, limit: combinedCap, summaryLimit: 0 },
                );
            } catch { break combined; }
            if (!streamed.complete || streamed.partial) break combined;
            const adaptive = contextN > 0 && !(beforeN > 0) && !(afterN > 0);
            const byPattern = patterns.map(() => []);
            const residual = [];
            for (const line of streamed.lines) {
                const m = /^(.*?):(\d+):(.*)$/.exec(line);
                const text = m ? m[3] : line;
                let hitAny = false;
                for (let i = 0; i < jsRegexps.length; i++) {
                    if (jsRegexps[i].test(text)) { byPattern[i].push(line); hitAny = true; }
                }
                if (!hitAny) residual.push(line);
            }
            const seenCombined = new Set();
            const perBudget = Math.max(512, Math.floor(callContextCharBudget / patterns.length));
            const globStr = normalizedGlobPatterns.length > 0 ? ` glob=${JSON.stringify(normalizedGlobPatterns)}` : '';
            const noMatchBody = (p) => `(no matches) pattern=${JSON.stringify(p)} path=${searchPath}${globStr}; path exists (dir)`;
            const sections = [];
            const noMatchPatterns = [];
            for (let i = 0; i < patterns.length; i++) {
                const p = patterns[i];
                const linesFor = byPattern[i];
                let body;
                if (linesFor.length === 0) {
                    noMatchPatterns.push(p);
                    continue;
                } else if (adaptive) {
                    const ctx = await expandGrepAnchorContextOutput({
                        allLines: linesFor,
                        workDir,
                        rgSpawnCwd: rgCwd,
                        grepResolvedPath,
                        searchPath,
                        outputMode,
                        filenameOmitted: false,
                        headLimit,
                        offset,
                        totalKnown: true,
                        requestedContext: contextN,
                        maxContext: GREP_AUTO_CONTEXT_LINES,
                        patterns: [p],
                        caseInsensitive,
                        charBudget: perBudget,
                        signal: options.signal,
                    });
                    body = ctx.text || noMatchBody(p);
                } else {
                    const post = offset > 0 ? linesFor.slice(offset) : linesFor;
                    const windowedLines = headLimit === Infinity ? post : post.slice(0, headLimit);
                    body = formatGrepOutput({
                        windowed: windowedLines,
                        totalWindowed: post.length,
                        totalKnown: true,
                        headLimit,
                        offset,
                        outputMode,
                        patterns: [p],
                        beforeN,
                        afterN,
                        contextN,
                        searchPath,
                        grepResolvedPath,
                        workDir,
                        globPatterns: normalizedGlobPatterns,
                        fileType,
                        filenameOmitted: false,
                        prefix: '',
                        disableContentGrouping: true,
                    });
                }
                sections.push(`# grep pattern:${JSON.stringify(p)}\n${dedupeFanoutMatchLines(body, seenCombined)}`);
            }
            if (noMatchPatterns.length > 0) {
                sections.push(`(no matches) pattern=${JSON.stringify(noMatchPatterns)} path=${searchPath}${globStr}; path exists`);
            }
            if (residual.length > 0) {
                // Rust/JS regex divergence or --max-columns truncation left
                // matches no pattern claimed; surface them rather than drop.
                sections.push(`# grep (unattributed matches)\n${residual.slice(0, 40).join('\n')}`);
            }
            return patternCapNote + sections.join('\n\n');
        }
        // Prefilter result (started above, overlapped with the combined
        // attempt): when it completed under the cap, each per-pattern grep
        // below scopes to that candidate list — K patterns cost 1 repo walk +
        // K file-list scans instead of K full walks. Zero candidates
        // short-circuits with no further spawns.
        let fanoutCandidateFiles = null;
        if (fanoutPrefilterPromise) {
            const pre = await fanoutPrefilterPromise;
            if (pre) {
                if (pre.length === 0) {
                    const globStr = normalizedGlobPatterns.length > 0 ? ` glob=${JSON.stringify(normalizedGlobPatterns)}` : '';
                    return `${patternCapNote}(no matches) pattern=${JSON.stringify(patterns)} path=${searchPath}${globStr}; path exists (dir)`;
                }
                fanoutCandidateFiles = pre;
            }
        }
        const seen = new Set();
        const subOptions = {
            ...options,
            _grepPatternFanout: true,
            _grepContextCharBudget: Math.max(512, Math.floor(callContextCharBudget / patterns.length)),
            ...(fanoutCandidateFiles ? { _grepCandidateFiles: fanoutCandidateFiles } : {}),
        };
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
        // Consolidate single-line no-match sub-results: K missed patterns
        // collapse into ONE summary line instead of K header+body sections.
        const parts = [];
        const missedPatterns = [];
        for (let i = 0; i < patterns.length; i++) {
            const body = dedupeFanoutMatchLines(subs[i], seen);
            if (typeof body === 'string' && body.startsWith('(no matches) ') && !body.includes('\n')) {
                missedPatterns.push(patterns[i]);
                continue;
            }
            parts.push(`# grep pattern:${JSON.stringify(patterns[i])}\n${body}`);
        }
        if (missedPatterns.length > 0) {
            const missGlob = normalizedGlobPatterns.length > 0 ? ` glob=${JSON.stringify(normalizedGlobPatterns)}` : '';
            parts.push(`(no matches) pattern=${JSON.stringify(missedPatterns)} path=${searchPath}${missGlob}; path exists`);
        }
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
        contextCharBudget: callContextCharBudget,
        // Capped requests carry the "[capped at N of M]" notice; key on the
        // original count so they never collide with an exact N-pattern request
        // (or a differently-capped one) in the internal result cache.
        patternCapTotal,
        candidatesKey: Array.isArray(options._grepCandidateFiles) && options._grepCandidateFiles.length > 0
            ? createHash('sha256').update(options._grepCandidateFiles.join('\x01')).digest('hex').slice(0, 16)
            : '',
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
    if (cached !== null) {
        recordLocalSearchCacheHit('result');
        return cached;
    }

    return await runResultCacheInFlight(cacheKey, async () => {
    let grepStat;
    try { grepStat = await statReachable(grepResolvedPath); }
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
    // Single-FILE scope: a positive glob filter can only re-filter the one
    // explicitly targeted file — either a no-op (basename matches) or a
    // mistake that silently turns an explicit file search into
    // "(no matches)". The explicit operand wins; drop the filter.
    if (grepStat.isFile() && normalizedGlobPatterns.length > 0) {
        normalizedGlobPatterns.length = 0;
    }

    // rg builds --glob overrides rooted at its process cwd and relativizes each
    // candidate against it with a CASE-SENSITIVE prefix strip; workDir is
    // case-normalized (lowercased) while callers pass real-cased absolute paths,
    // so the strip fails and slash-anchored globs (src/**/*.mjs) silently match
    // nothing. Spawn rg at the TRUE-CASED search root so relativization — and
    // therefore glob anchoring — always engages. Relative searchPath keeps the
    // workDir cwd (both sides already share workDir's casing).
    let rgSpawnCwd = workDir;
    if (isAbsolute(searchPath)) {
        searchPath = await trueCasePath(searchPath);
        if (grepStat.isDirectory()) rgSpawnCwd = searchPath;
    }

    // Fan-out prefilter scoping: a parent multi-pattern grep already ran one
    // combined --files-with-matches walk and passed the COMPLETE candidate
    // list; every rg below searches only those files (no directory walk).
    const scopedCandidateFiles = Array.isArray(options._grepCandidateFiles)
        && options._grepCandidateFiles.length > 0
        && grepStat.isDirectory()
        ? options._grepCandidateFiles
        : null;

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
            candidateFiles: scopedCandidateFiles,
        });
        const contextMode = outputMode === 'content' && (beforeN > 0 || afterN > 0 || contextN > 0);
        if (contextMode) {
            // A symmetric content search is a fused two-pass operation:
            // pass 1 streams only rg anchors, then pass 2 expands sparse
            // searches to patch-ready source. Broad results expand up to three
            // priority spans and retain compact range anchors, all within the
            // whole-call character budget. Explicit context:0 remains bare.
            const adaptiveContextMode = contextN > 0
                && !(beforeN > 0)
                && !(afterN > 0)
                && showLineNumbers
                && !multilineMode
                && args['-o'] !== true;
            if (adaptiveContextMode) {
                const anchorArgs = buildGrepRgArgs({
                    patterns,
                    searchPath,
                    globPatterns: normalizedGlobPatterns,
                    outputMode,
                    caseInsensitive,
                    showLineNumbers: true,
                    beforeN: null,
                    afterN: null,
                    contextN: null,
                    multilineMode,
                    fileType,
                    onlyMatching: false,
                    pcre2: pcre2Mode,
                    withFilename: forceGrepFilename,
                    candidateFiles: scopedCandidateFiles,
                });
                const anchorCap = Math.min(
                    4000,
                    headLimit === Infinity ? 4000 : Math.max(200, offset + headLimit + 4),
                );
                let ctxPartialSuffix = '';
                const streamed = await runRgWindowedLines(
                    anchorArgs,
                    { cwd: rgSpawnCwd, signal: options.signal },
                    { offset: 0, limit: anchorCap, summaryLimit: 0 },
                );
                let ctxTotalKnown = streamed.complete;
                if (streamed.partial) {
                    ctxTotalKnown = false;
                    ctxPartialSuffix = streamed.timeout
                        ? '\n[warning] rg timed out; partial results shown. Narrow path/glob/pattern for a complete result.'
                        : streamed.rgStderr
                        ? `\n[warning] rg exit 2 (partial results): ${String(streamed.rgStderr).trim().slice(0, 300)}`
                        : '\n[warning] rg exit 2 (partial results)';
                } else if (!streamed.complete) {
                    ctxPartialSuffix = `\n[warning] anchor output capped at ${anchorCap} matches; results partial — narrow path/glob/pattern for the full match set.`;
                }
                const ctx = await expandGrepAnchorContextOutput({
                    allLines: streamed.lines,
                    workDir,
                    rgSpawnCwd,
                    grepResolvedPath,
                    searchPath,
                    outputMode,
                    filenameOmitted,
                    headLimit,
                    offset,
                    totalKnown: ctxTotalKnown,
                    requestedContext: contextN,
                    maxContext: GREP_AUTO_CONTEXT_LINES,
                    patterns,
                    caseInsensitive,
                    charBudget: callContextCharBudget,
                    signal: options.signal,
                });
                if (ctx.total > 0 || streamed.lines.length === 0) {
                    let ctxBody = ctx.text;
                    if (!ctxBody) {
                        const patternStr = patterns.length === 1 ? JSON.stringify(patterns[0]) : JSON.stringify(patterns);
                        const globStr = normalizedGlobPatterns.length > 0 ? ` glob=${JSON.stringify(normalizedGlobPatterns)}` : '';
                        const pathInfo = grepStat.isDirectory() ? 'path exists (dir)' : 'path exists (file)';
                        ctxBody = `(no matches) pattern=${patternStr} path=${searchPath}${globStr}; ${pathInfo}`;
                    }
                    const ctxOut = patternCapNote + ctxBody + ctxPartialSuffix;
                    if (options?.scopedCacheOutcome && (!ctxTotalKnown || ctx.omitted > 0 || !ctx.sourceComplete)) {
                        markScopedCacheIncomplete(options.scopedCacheOutcome);
                    }
                    if (ctxTotalKnown && ctx.omitted === 0 && ctx.sourceComplete) {
                        cacheSet(cacheKey, ctxOut, { scopes: [grepResolvedPath] });
                    }
                    if (typeof options?.onProgress === 'function') {
                        try { options.onProgress(`found ${ctx.total} matches`); } catch { /* best-effort */ }
                    }
                    return ctxOut;
                }
                // Non-empty but unparsable rg output (binary diagnostics or an
                // unexpected platform format) falls through to the legacy
                // context renderer rather than losing the result.
            }
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
            const streamed = await runRgWindowedLines(rgArgs, { cwd: rgSpawnCwd, signal: options.signal }, { offset: 0, limit: lineCap, summaryLimit: 0 });
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
                searchPath,
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
            const streamed = await runRgWindowedLines(rgArgs, { cwd: rgSpawnCwd, signal: options.signal }, {
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
            const stdout = await runRg(rgArgs, { cwd: rgSpawnCwd, signal: options.signal });
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
            includeMatchCount: false,
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
                    const probeOut = await runRg(probeArgs, { cwd: rgSpawnCwd, signal: options.signal });
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
                        candidateFiles: scopedCandidateFiles,
                    });
                    const effectiveHeadLimit = headLimit === Infinity
                        ? (outputMode === 'content' ? GREP_CONTENT_HARD_CAP : Infinity)
                        : headLimit;
                    let windowed;
                    let totalWindowed = 0;
                    let totalKnown = true;
                    let rgPartialSuffix = '';
                    if (effectiveHeadLimit !== Infinity) {
                        const streamed = await runRgWindowedLines(fallbackArgs, { cwd: rgSpawnCwd, signal: options.signal }, {
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
                        const stdout = await runRg(fallbackArgs, { cwd: rgSpawnCwd, signal: options.signal });
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
                    const fallbackPrefix = patternCapNote + '[regex parse fallback: fixed-string terms]\n';
                    let body = formatGrepOutput({
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
                        prefix: fallbackPrefix,
                    });
                    if (!body || (windowed.length === 0 && totalWindowed === 0)) {
                        body = `${fallbackPrefix}(no matches) fixed_terms=${JSON.stringify(fixedPatterns)} path=${searchPath}`;
                    }
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
    const statCached = async (resolvedPath) => {
        if (statCache.has(resolvedPath)) return await statCache.get(resolvedPath);
        const pending = statReachable(resolvedPath)
            .then((st) => ({ st, err: null }), (err) => ({ st: null, err }));
        statCache.set(resolvedPath, pending);
        const settled = await pending;
        if (statCache.get(resolvedPath) === pending) statCache.set(resolvedPath, settled);
        return settled;
    };
    if (!options._enoentRedirectFrom) {
        for (const only of basePaths) {
            const resolvedOnly = resolveSearchScope(only, workDir);
            const pre = await statCached(resolvedOnly);
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
        // Literal-first (same contract as grep's path handling): a directory
        // literally named e.g. "cache{v2}" is the root, not a pattern.
        try {
            if (statSync(resolveAgainstCwd(basePath, workDir)).isDirectory()) {
                return { root: basePath, prefix: '' };
            }
        } catch { /* not a literal dir — treat as base+glob below */ }
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
        return `Error: invalid limit ${JSON.stringify(headLimitRaw)}; expected a non-negative integer (0 = unlimited)`;
    }
    const headLimit = headLimitCoerced === null
        ? _globDefaultHeadLimit()
        : (headLimitCoerced === 0 ? Infinity : headLimitCoerced);
    const offsetCoerced = coerceNonNegInt(args.offset);
    if (Number.isNaN(offsetCoerced)) {
        return `Error: invalid offset ${JSON.stringify(args.offset)}; expected a non-negative integer`;
    }
    const offset = offsetCoerced === null || offsetCoerced === 0 ? 0 : offsetCoerced;
    const rawSort = typeof args.sort === 'string' ? args.sort.trim() : '';
    // Newest-first is the default: recently-touched files are almost always
    // the relevant ones. sort:'natural' opts back into raw walk order, which
    // keeps early windowing and skips the stat phase on huge trees.
    const sortMode = rawSort === 'natural' ? 'natural' : 'mtime';
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
    if (cached !== null) {
        recordLocalSearchCacheHit('result');
        return cached;
    }

    return await runResultCacheInFlight(cacheKey, async () => {
    const globGroups = [...groups.entries()];

    const allFiles = [];
    const rgErrors = [];
    let accumTruncated = false;
    let rgStdoutTruncated = false;
    let rgStdoutPartial = false;
    let rgWindowIncomplete = false;
    const accumCap = 50000;
    const canWindowNatural = sortMode === 'natural' && headLimit !== Infinity;
    const groupRuns = await Promise.all(globGroups.map(async ([root, rels]) => {
        const rgArgs = ['--files', '--hidden'];
        for (const ex of DEFAULT_IGNORE_GLOBS) rgArgs.push('--glob', ex);
        for (const ex of extraIgnoreGlobs) rgArgs.push('--glob', ex);
        for (const rel of rels) rgArgs.push('--glob', rel);
        const rgCwd = resolvedForSearchRoot(root);
        rgArgs.push('.');
        const cwdStat = await statCached(rgCwd);
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
            if (canWindowNatural) {
                const served = await runRgWindowedLines(
                    rgArgs,
                    { cwd: rgCwd, signal: options.signal },
                    { offset: 0, limit: offset + headLimit + 1 },
                );
                return {
                    error: null,
                    paths: served.lines.map((line) =>
                        isAbsolute(line) ? line : resolveAgainstCwd(line, rgCwd)),
                    stdoutTruncated: false,
                    stdoutPartial: served.partial === true,
                    windowIncomplete: served.complete !== true,
                };
            }
            const stdout = await runRg(rgArgs, { cwd: rgCwd, signal: options.signal });
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
        if (run.windowIncomplete) rgWindowIncomplete = true;
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
        // Default mtime sorting stats every match. Bound the post-rg stat
        // phase so a hung mount cannot pin glob until the agent stall
        // watchdog fires.
        const withStatAll = await statPathsForMtime(unique, workDir, 64, { deadlineMs: 5000 });
        const statted = [];
        const unstatted = [];
        for (const entry of withStatAll) {
            if (!entry) continue;
            if (entry.stat != null) statted.push(entry);
            else unstatted.push(entry);
        }
        statted.sort((a, b) => {
            const dm = b.mtime - a.mtime;
            if (dm !== 0) return dm;
            return globMtimeTiePath(a).localeCompare(globMtimeTiePath(b));
        });
        // A deadline-expired or failed stat degrades ORDERING only, never
        // completeness: unsortable entries keep their walk order at the tail.
        orderedPaths = [...statted, ...unstatted].map((entry) => entry.full || resolveAgainstCwd(entry.path, workDir));
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
    const moreSuffix = rgWindowIncomplete
        ? `\n... [more entries available — pass offset:${offset + capped.length} to continue]`
        : (remaining > 0 ? `\n... [${remaining} more entries of ${totalBeforeOffset} total — pass offset:${offset + capped.length} to continue]` : '');
    const body = capped.length > 0
        ? `${capped.join('\n')}${moreSuffix}${errSuffix}`
        : '';
    const out = globPatternCapNote + (body || emptyDiag || '(no files found)');
    if (options?.scopedCacheOutcome && (accumTruncated || rgStdoutTruncated || rgStdoutPartial || rgWindowIncomplete || remaining > 0)) {
        markScopedCacheIncomplete(options.scopedCacheOutcome);
    }
    const globIncomplete = accumTruncated || rgStdoutTruncated || rgStdoutPartial || rgWindowIncomplete || remaining > 0;
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
