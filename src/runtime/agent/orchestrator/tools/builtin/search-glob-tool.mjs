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
    rootScanIgnoreGlobs,
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
    visitPathsForMtime,
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

function compareGlobMtimeEntries(a, b) {
    const dm = b.mtime - a.mtime;
    if (dm !== 0) return dm;
    return globMtimeTiePath(a).localeCompare(globMtimeTiePath(b));
}

function retainBestEntries(heap, candidate, limit, compare) {
    if (heap.length < limit) {
        heap.push(candidate);
        for (let index = heap.length - 1; index > 0;) {
            const parent = Math.floor((index - 1) / 2);
            if (compare(heap[index], heap[parent]) <= 0) break;
            [heap[index], heap[parent]] = [heap[parent], heap[index]];
            index = parent;
        }
        return;
    }
    if (compare(candidate, heap[0]) >= 0) return;
    heap[0] = candidate;
    for (let index = 0;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let worst = index;
        if (left < heap.length && compare(heap[left], heap[worst]) > 0) worst = left;
        if (right < heap.length && compare(heap[right], heap[worst]) > 0) worst = right;
        if (worst === index) break;
        [heap[index], heap[worst]] = [heap[worst], heap[index]];
        index = worst;
    }
}

export function _createGlobMtimeTopK(limit) {
    const cap = Math.max(1, Math.floor(Number(limit) || 1));
    const statted = [];
    const unstatted = [];
    return {
        add(entry, index) {
            if (entry?.stat != null) {
                retainBestEntries(statted, entry, cap, compareGlobMtimeEntries);
            } else {
                retainBestEntries(unstatted, { ...entry, _walkIndex: index }, cap,
                    (a, b) => a._walkIndex - b._walkIndex);
            }
        },
        values() {
            statted.sort(compareGlobMtimeEntries);
            unstatted.sort((a, b) => a._walkIndex - b._walkIndex);
            return [...statted, ...unstatted].slice(0, cap);
        },
    };
}

function _grepContextCharBudget(options = {}) {
    const explicit = Number(options?._grepContextCharBudget);
    if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
    const configured = Number(process.env.MIXDOG_GREP_CONTEXT_CHAR_BUDGET);
    return Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : GREP_CONTEXT_CHAR_BUDGET_DEFAULT;
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

    return await runResultCacheInFlight(cacheKey, async ({ signal: sharedSignal }) => {
    const globGroups = [...groups.entries()];

    const allFiles = [];
    const rgErrors = [];
    let accumTruncated = false;
    let rgStdoutTruncated = false;
    let rgStdoutPartial = false;
    let rgWindowIncomplete = false;
    let rgCacheUnsafe = false;
    let nativeMtimeTotal = null;
    const accumCap = 50000;
    const canWindowNatural = sortMode === 'natural' && headLimit !== Infinity;
    const canWindowMtime = sortMode === 'mtime'
        && headLimit !== Infinity;
    const groupRuns = await Promise.all(globGroups.map(async ([root, rels]) => {
        const rgArgs = ['--files', '--hidden'];
        // Explicit literal basenames (no glob magic in the final segment)
        // name a concrete file: honor rg's later-glob-wins contract and let
        // the lookup descend dependency-noise dirs, which the native walker
        // would otherwise prune before the pattern could ever match. Wildcard
        // basenames keep the noise prunes; device-name globs (no trailing
        // /**) always apply.
        const explicitBasenames = rels.length > 0 && rels.every((rel) => {
            const base = String(rel).split('/').filter(Boolean).pop() || '';
            return base !== '' && !hasGlobMagic(base);
        });
        for (const ex of DEFAULT_IGNORE_GLOBS) {
            if (explicitBasenames && /^!\*\*\/[^/]+\/\*\*$/.test(ex)) continue;
            rgArgs.push('--glob', ex);
        }
        for (const ex of extraIgnoreGlobs) rgArgs.push('--glob', ex);
        for (const rel of rels) rgArgs.push('--glob', rel);
        const rgCwd = resolvedForSearchRoot(root);
        // Root-anchored kernel-tree prunes trail every positive glob so
        // rg's later-glob-wins rule can never re-admit /proc//sys//dev on a
        // full-root scan.
        for (const ex of rootScanIgnoreGlobs(rgCwd)) rgArgs.push('--glob', ex);
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
            if (canWindowMtime) {
                const served = await runRgWindowedLines(
                    rgArgs,
                    { cwd: rgCwd, signal: sharedSignal },
                    { offset: 0, limit: offset + headLimit + 1, mtimeTopK: true },
                );
                return {
                    error: null,
                    paths: served.lines.map((line) =>
                        isAbsolute(line) ? line : resolveAgainstCwd(line, rgCwd)),
                    stdoutTruncated: false,
                    stdoutPartial: served.partial === true,
                    windowIncomplete: false,
                    cacheSafe: served.cacheSafe !== false,
                    nativeMtime: true,
                    totalSeen: served.totalSeen,
                };
            }
            if (canWindowNatural) {
                const served = await runRgWindowedLines(
                    rgArgs,
                    { cwd: rgCwd, signal: sharedSignal },
                    { offset: 0, limit: offset + headLimit + 1 },
                );
                return {
                    error: null,
                    paths: served.lines.map((line) =>
                        isAbsolute(line) ? line : resolveAgainstCwd(line, rgCwd)),
                    stdoutTruncated: false,
                    stdoutPartial: served.partial === true,
                    windowIncomplete: served.complete !== true,
                    cacheSafe: served.cacheSafe !== false,
                };
            }
            const stdout = await runRg(rgArgs, { cwd: rgCwd, signal: sharedSignal });
            const stdoutTruncated = Boolean(stdout && typeof stdout === 'object' && stdout.truncated);
            const stdoutPartial = Boolean(stdout && typeof stdout === 'object' && stdout.partial);
            const cacheSafe = !(stdout && typeof stdout === 'object' && stdout.cacheSafe === false);
            const paths = [];
            for (const line of String(stdout).split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                paths.push(isAbsolute(trimmed) ? trimmed : resolveAgainstCwd(trimmed, rgCwd));
            }
            return { error: null, paths, stdoutTruncated, stdoutPartial, cacheSafe };
        } catch (err) {
            if (sharedSignal?.aborted) throw err;
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
        if (run.cacheSafe === false) rgCacheUnsafe = true;
        if (run.nativeMtime) {
            nativeMtimeTotal = (nativeMtimeTotal ?? 0) + Math.max(0, Number(run.totalSeen) || 0);
        }
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
    if (nativeMtimeTotal !== null && globGroups.length === 1) {
        orderedPaths = unique;
    } else if (nativeMtimeTotal !== null) {
        const withStat = await statPathsForMtime(unique, workDir, 64, { deadlineMs: 5000 });
        const statted = [];
        const unstatted = [];
        for (const entry of withStat) {
            if (!entry) continue;
            if (entry.stat != null) statted.push(entry);
            else unstatted.push(entry);
        }
        statted.sort(compareGlobMtimeEntries);
        orderedPaths = [...statted, ...unstatted]
            .map((entry) => entry.full || resolveAgainstCwd(entry.path, workDir));
    } else if (sortMode === 'mtime') {
        // Default mtime sorting stats every match. Bound the post-rg stat
        // phase so a hung mount cannot pin glob until the agent stall
        // watchdog fires.
        if (headLimit === Infinity) {
            const withStatAll = await statPathsForMtime(unique, workDir, 64, { deadlineMs: 5000 });
            const statted = [];
            const unstatted = [];
            for (const entry of withStatAll) {
                if (!entry) continue;
                if (entry.stat != null) statted.push(entry);
                else unstatted.push(entry);
            }
            statted.sort(compareGlobMtimeEntries);
            // A deadline-expired or failed stat degrades ORDERING only, never
            // completeness: unsortable entries keep their walk order at the tail.
            orderedPaths = [...statted, ...unstatted]
                .map((entry) => entry.full || resolveAgainstCwd(entry.path, workDir));
        } else {
            // Scan and stat every match for exact global ordering, but retain
            // only the requested page plus one lookahead row. This changes
            // O(N log N) sorting and O(N) result retention to O(N log K) and
            // O(K) without narrowing the searched candidate set.
            const selector = _createGlobMtimeTopK(
                Math.min(unique.length, offset + headLimit + 1),
            );
            await visitPathsForMtime(unique, workDir, 64, { deadlineMs: 5000 },
                (entry, index) => selector.add(entry, index));
            orderedPaths = selector.values()
                .map((entry) => entry.full || resolveAgainstCwd(entry.path, workDir));
        }
    } else {
        orderedPaths = unique.map((entry) => isAbsolute(entry) ? resolve(entry) : resolveAgainstCwd(entry, workDir));
    }
    const totalBeforeOffset = nativeMtimeTotal ?? unique.length;
    const windowed = offset > 0 ? orderedPaths.slice(offset) : orderedPaths;
    const capped = (headLimit === Infinity ? windowed : windowed.slice(0, headLimit))
        .map((abs) => relativeSearchResultPath(abs, workDir));
    const remaining = Math.max(0, totalBeforeOffset - offset - capped.length);
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
    // Pagination is not an incomplete computation: limit/offset are part of
    // the cache key, and the native watcher invalidates the scoped page on any
    // relevant namespace/mtime change. Cache exact pages even when more rows
    // exist; only a genuinely partial scan must bypass reuse.
    const globComputationIncomplete = accumTruncated || rgStdoutTruncated || rgStdoutPartial || rgErrors.length > 0;
    if (!globComputationIncomplete && !rgCacheUnsafe) {
        cacheSet(cacheKey, out, { scopes: [...groups.keys()].map((root) => resolvedForSearchRoot(root)) });
    }
    // ② completion progress (claude "Found N" parity). Best-effort, no-op
    // when onProgress is absent (no progressToken).
    if (typeof options?.onProgress === 'function') {
        try { options.onProgress(`found ${totalBeforeOffset} files`); } catch { /* best-effort */ }
    }
    return out;
    }, {
        signal: options?.signal || options?.abortSignal || null,
        scopes: [...groups.keys()].map((root) => resolvedForSearchRoot(root)),
    });
}
