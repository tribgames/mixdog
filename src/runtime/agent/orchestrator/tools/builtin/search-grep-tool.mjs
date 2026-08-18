import { createHash } from 'crypto';
import { isAbsolute } from 'path';
import { trueCasePath } from './path-utils.mjs';
import {
    canonicalizeGlobSlashes,
    coerceReadFamilyPathArg,
    coerceShapeFlex,
    extractGlobBaseDirectory,
    GREP_AUTO_CONTEXT_LINES,
    hasGlobMagic,
    normalizeGrepArgs,
    normalizeInputPath,
    normalizeOutputPath,
    normalizeSearchPattern,
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
    buildGrepCacheKey,
    buildGrepRgArgs,
} from './search-builders.mjs';
import { runRg, runRgWindowedLines, rgSupportsPcre2 } from './native-search-runner.mjs';
import { markScopedCacheIncomplete } from '../../session/cache/scoped-cache-outcome.mjs';
import {
    cacheGet,
    cacheSet,
    runResultCacheInFlight,
    statPathsForMtime,
} from './cache-layers.mjs';
import { recordLocalSearchCacheHit } from './local-search-telemetry.mjs';
import { applyGrepContextLeadPolicy, GREP_CONTEXT_MAX, hasUnsupportedRipgrepRegex } from './arg-guard.mjs';
import {
    expandLegacyEscapedAlternationPattern,
    uniqueStrings,
    isRgRegexParseError,
    coerceNonNegInt,
    splitGlobString,
    isRedundantAllFilesGlob,
    parseGrepCountLine,
} from './lib/search-input-helpers.mjs';
import { statReachable } from './fs-reachability.mjs';
// Fan-out / chunk-merge / rescue sub-flows extracted from this file; each
// receives `executeGrepTool` as a parameter to avoid an import cycle.
import { runGrepPathFanout } from './lib/grep-path-fanout.mjs';
import { runGrepPatternFanout } from './lib/grep-pattern-fanout.mjs';
import { runGrepChunkMerge } from './lib/grep-chunk-merge.mjs';
import { runGrepFixedStringFallback } from './lib/grep-fixed-fallback.mjs';

// A single glob string may pack multiple filters
// separated by whitespace or commas, e.g. "*.ts,*.tsx" or "*.ts *.tsx". Split
// each into its own --glob. Brace patterns ("*.{ts,tsx}") are left intact so
// their internal commas are not torn apart.

// Grep output rendering (context-block windowing, fan-out dedupe, notices)
// lives in lib/grep-output.mjs.
import {
    formatGrepContextOutput,
    formatGrepOutput,
    grepMissingPatternMessage,
} from './lib/grep-output.mjs';
import {
    expandGrepAnchorContextOutput,
    GREP_CONTEXT_CHAR_BUDGET_DEFAULT,
} from './lib/grep-context-expander.mjs';

// Default grep result cap when head_limit is unspecified. 250 is the common
// harness default; the tool-result offload layer still bounds oversized
// results. MIXDOG_GREP_DEFAULT_HEAD_LIMIT overrides for A/B runs.
function _grepDefaultHeadLimit() {
    const parsed = parseInt(process.env.MIXDOG_GREP_DEFAULT_HEAD_LIMIT ?? '', 10);
    return parsed > 0 ? parsed : 250;
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
            // Multi-root fan-out (combined single-spawn or legacy bounded
            // recursion) lives in lib/grep-path-fanout.mjs.
            return await runGrepPathFanout({
                list,
                args,
                workDir,
                executeChildBuiltinTool,
                readStateScope,
                options,
                callContextCharBudget,
                defaultHeadLimit: _grepDefaultHeadLimit(),
                executeGrepTool,
            });
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
        // pattern[] fan-out (speculative prefilter + combined single-spawn +
        // legacy per-pattern recursion) lives in lib/grep-pattern-fanout.mjs.
        return await runGrepPatternFanout({
            args,
            patterns,
            workDir,
            executeChildBuiltinTool,
            readStateScope,
            options,
            callContextCharBudget,
            patternCapNote,
            searchPath,
            grepResolvedPath,
            normalizedGlobPatterns,
            outputMode,
            headLimit,
            offset,
            caseInsensitive,
            showLineNumbers,
            beforeN,
            afterN,
            contextN,
            multilineMode,
            pcre2Mode,
            fileType,
            executeGrepTool,
        });
    }

    const patternChunkCap = multilineMode ? GREP_MULTILINE_PATTERN_CAP : GREP_ARRAY_PATTERN_CAP;
    if (patterns.length > patternChunkCap) {
        // Chunked pattern[] fetch + deterministic merge replay lives in
        // lib/grep-chunk-merge.mjs.
        return await runGrepChunkMerge({
            args,
            patterns,
            patternChunkCap,
            workDir,
            executeChildBuiltinTool,
            readStateScope,
            options,
            patternCapNote,
            searchPath,
            grepResolvedPath,
            normalizedGlobPatterns,
            outputMode,
            headLimit,
            headLimitCoerced,
            offset,
            beforeN,
            afterN,
            contextN,
            fileType,
            executeGrepTool,
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

    return await runResultCacheInFlight(cacheKey, async ({ signal: sharedSignal }) => {
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
        // Guessed-scope fallback: a RELATIVE single-segment scope ("test",
        // "docs") with no redirect candidate is a guessed directory name.
        // Search the project root instead of erroring — the notice keeps the
        // remap visible. Absolute and multi-segment paths keep the error+hint
        // contract (a wrong deep path usually flags a wrong assumption).
        const rawScope = String(searchPath || '');
        if (!options?._grepRootFallback
            && rawScope
            && rawScope !== '.'
            && !isAbsolute(rawScope)
            && !/[\\/:]/.test(rawScope)) {
            const body = await executeGrepTool(
                { ...args, path: '.' },
                workDir,
                executeChildBuiltinTool,
                readStateScope,
                { ...options, _grepRootFallback: true },
            );
            if (typeof body === 'string' && !/^\s*Error[\s:[]/i.test(body)) {
                return `[notice] path "${rawScope}" does not exist — searched the project root instead.\n${body}`;
            }
        }
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

    // Cased-letter hint shared by EVERY no-match body (context modes
    // included): a zero-match single-pattern search whose pattern carries
    // cased letters may have failed only on case. ONE case-insensitive
    // files_with_matches probe; non-empty output nudges toward `-i`.
    // Skipped for pattern arrays and when `-i` is already set.
    const caseHintSuffix = async () => {
        const caseInsensitive = args['-i'] === true;
        // A broad no-match must not trigger a second whole-tree scan just to
        // produce an advisory casing hint. The requested case-sensitive result
        // is already complete; retain the hint only for explicit file scopes.
        if (grepStat.isDirectory()
            || caseInsensitive
            || patterns.length !== 1
            || !/[A-Za-z]/.test(patterns[0])) return '';
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
            const probeOut = await runRg(probeArgs, { cwd: rgSpawnCwd, signal: sharedSignal });
            if (String(probeOut).split('\n').some(Boolean)) {
                return ' (case-insensitive would match — try -i)';
            }
        } catch { /* best-effort hint */ }
        return '';
    };

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
                    { cwd: rgSpawnCwd, signal: sharedSignal },
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
                    signal: sharedSignal,
                });
                if (ctx.total > 0 || streamed.lines.length === 0) {
                    let ctxBody = ctx.text;
                    if (!ctxBody) {
                        const patternStr = patterns.length === 1 ? JSON.stringify(patterns[0]) : JSON.stringify(patterns);
                        const globStr = normalizedGlobPatterns.length > 0 ? ` glob=${JSON.stringify(normalizedGlobPatterns)}` : '';
                        const pathInfo = grepStat.isDirectory() ? 'path exists (dir)' : 'path exists (file)';
                        ctxBody = `(no matches) pattern=${patternStr} path=${searchPath}${globStr}; ${pathInfo}`;
                        if (offset === 0 && ctx.total === 0) ctxBody += await caseHintSuffix();
                    }
                    const ctxOut = patternCapNote + ctxBody + ctxPartialSuffix;
                    if (options?.scopedCacheOutcome && (!ctxTotalKnown || ctx.omitted > 0 || !ctx.sourceComplete)) {
                        markScopedCacheIncomplete(options.scopedCacheOutcome);
                    }
                    if (ctxTotalKnown && ctx.omitted === 0 && ctx.sourceComplete
                        && streamed.cacheSafe !== false) {
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
            const streamed = await runRgWindowedLines(rgArgs, { cwd: rgSpawnCwd, signal: sharedSignal }, { offset: 0, limit: lineCap, summaryLimit: 0 });
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
                if (offset === 0 && ctx.total === 0) ctxBody += await caseHintSuffix();
            }
            const ctxOut = patternCapNote + ctxBody + ctxPartialSuffix;
            if (options?.scopedCacheOutcome && (!ctxTotalKnown || ctx.omitted > 0)) {
                markScopedCacheIncomplete(options.scopedCacheOutcome);
            }
            if (ctxTotalKnown && ctx.omitted === 0 && streamed.cacheSafe !== false) {
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
        let resultCacheSafe = true;
        let rgPartialSuffix = '';
        if (effectiveHeadLimit !== Infinity) {
            const summaryLimit = outputMode === 'content' ? 120 : 0;
            const streamed = await runRgWindowedLines(rgArgs, { cwd: rgSpawnCwd, signal: sharedSignal }, {
                offset,
                limit: effectiveHeadLimit,
                summaryLimit,
            });
            windowed = streamed.lines;
            totalWindowed = streamed.totalSeen;
            totalKnown = streamed.complete;
            resultCacheSafe = streamed.cacheSafe !== false;
            if (streamed.partial) {
                totalKnown = false;
                rgPartialSuffix = streamed.timeout
                    ? '\n[warning] rg timed out; partial results shown. Narrow path/glob/pattern for a complete result.'
                    : streamed.rgStderr
                    ? `\n[warning] rg exit 2 (partial results): ${String(streamed.rgStderr).trim().slice(0, 300)}`
                    : '\n[warning] rg exit 2 (partial results)';
            }
        } else {
            const stdout = await runRg(rgArgs, { cwd: rgSpawnCwd, signal: sharedSignal });
            const allLines = String(stdout).split('\n').filter(Boolean);
            windowed = offset > 0 ? allLines.slice(offset) : allLines;
            totalWindowed = windowed.length;
            // runRg boxes stdout + sets .truncated when the 20MB stdout cap
            // tripped (rg-runner). Mark the result incomplete so formatGrepOutput
            // emits the truncation notice instead of presenting it as complete.
            if (typeof stdout === 'object' && stdout.truncated) totalKnown = false;
            if (typeof stdout === 'object' && stdout.cacheSafe === false) resultCacheSafe = false;
            if (typeof stdout === 'object' && stdout.partial) {
                totalKnown = false;
                rgPartialSuffix = stdout.timeout
                    ? '\n[warning] rg timed out; partial results shown. Narrow path/glob/pattern for a complete result.'
                    : stdout.rgStderr
                    ? `\n[warning] rg exit 2 (partial results): ${String(stdout.rgStderr).trim().slice(0, 300)}`
                    : '\n[warning] rg exit 2 (partial results)';
            }
        }
        // files_with_matches: newest-first (mtime desc, path tiebreak) so
        // recently edited files surface first. Statting is bounded (64
        // workers, 5s deadline); stat-failed entries keep rg traversal order
        // after the statted ones. Sort covers the shown window — with the
        // default head limit the common case is the complete result set.
        if (outputMode === 'files_with_matches' && windowed.length > 1) {
            const withStat = await statPathsForMtime(windowed, rgSpawnCwd, 64, { deadlineMs: 5000 });
            const statted = [];
            const unstatted = [];
            for (let i = 0; i < windowed.length; i++) {
                const entry = withStat[i];
                if (entry?.stat) statted.push({ line: windowed[i], mtimeMs: entry.mtimeMs });
                else unstatted.push(windowed[i]);
            }
            statted.sort((a, b) => {
                const dm = b.mtimeMs - a.mtimeMs;
                if (dm !== 0) return dm;
                return a.line.localeCompare(b.line);
            });
            windowed = [...statted.map((e) => e.line), ...unstatted];
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
            // True zero-match only: an empty body with offset>0 (or pre-offset
            // matches) just means the window skipped past real case-sensitive
            // hits, so the hint would be misleading.
            if (offset === 0 && totalWindowed === 0) {
                body += await caseHintSuffix();
            }
        }
        const out = patternCapNote + body + rgPartialSuffix;
        const shownLines = headLimit === Infinity ? windowed : windowed.slice(0, headLimit);
        const remaining = Math.max(0, totalWindowed - shownLines.length);
        // Mirrors formatGrepOutput truncation / totalKnown semantics.
        if (options?.scopedCacheOutcome && (!totalKnown || remaining > 0)) {
            markScopedCacheIncomplete(options.scopedCacheOutcome);
        }
        if (totalKnown && remaining === 0 && resultCacheSafe) {
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
        if (sharedSignal?.aborted) throw err;
        if (isRgRegexParseError(err) && !multilineMode) {
            // Fixed-string rescue lives in lib/grep-fixed-fallback.mjs;
            // null falls through to the original rg error below.
            const rescued = await runGrepFixedStringFallback({
                args,
                patterns,
                patternCapNote,
                searchPath,
                grepResolvedPath,
                workDir,
                normalizedGlobPatterns,
                outputMode,
                caseInsensitive,
                showLineNumbers,
                beforeN,
                afterN,
                contextN,
                fileType,
                forceGrepFilename,
                filenameOmitted,
                scopedCandidateFiles,
                headLimit,
                offset,
                contentHardCap: GREP_CONTENT_HARD_CAP,
                rgSpawnCwd,
                signal: sharedSignal,
            });
            if (rescued !== null) return rescued;
        }
        const stderr = err?.stderr ? String(err.stderr).trim() : '';
        const msg = stderr || err?.message || String(err);
        return `Error: ${msg.slice(0, 500)}`;
    }
    }, {
        signal: options?.signal || options?.abortSignal || null,
        scopes: [grepResolvedPath],
    });
}
