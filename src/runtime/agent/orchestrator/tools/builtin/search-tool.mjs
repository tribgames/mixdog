import { statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { trueCasePath } from './path-utils.mjs';
import {
    canonicalizeGlobSlashes,
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
    buildGlobCacheKey,
    buildGrepCacheKey,
    buildGrepRgArgs,
    DEFAULT_IGNORE_GLOBS,
} from './search-builders.mjs';
import { runRg, runRgWindowedLines } from './rg-runner.mjs';
import { markScopedCacheIncomplete } from '../../session/cache/scoped-cache-outcome.mjs';
import {
    groupGrepContentByFile,
    normalizeGrepLine,
    splitGrepCountPrefix,
    splitGrepLinePrefix,
} from './grep-formatting.mjs';
import {
    cacheGet,
    cacheSet,
    statPathsForMtime,
} from './cache-layers.mjs';
import { recordReadSnapshot } from './read-snapshot-runtime.mjs';
import { applyGrepContextLeadPolicy, GREP_CONTEXT_MAX } from './arg-guard.mjs';

// Deterministic ENOENT recovery: when a grep path does not exist, surface
// indexed files that share the missing path's basename, turning a guessed or
// misplaced path (e.g. session/result-compression.mjs vs the real
// tools/result-compression.mjs) into the actual file in one step. Exact
// basename only — no stem/token fuzzing — so the hint is high-signal and
// noise-free. Invariant: every ENOENT runs the same basename lookup; there is
// no "guessed a lot" branch. Returns '' (appends nothing) when no same-named
// indexed file exists or the glob child is unavailable.
async function _suggestIndexedPaths(missingPath, executeChildBuiltinTool, workDir) {
    if (typeof executeChildBuiltinTool !== 'function') return '';
    const base = String(missingPath).replace(/\\/g, '/').split('/').pop();
    // Skip when there is no usable basename or it carries glob magic (the
    // pattern, not a literal filename, would not map to a real file).
    if (!base || /[*?[\]{}]/.test(base)) return '';
    try {
        const out = await executeChildBuiltinTool('glob', { pattern: `**/${base}`, head_limit: 6 }, workDir);
        if (typeof out !== 'string') return '';
        // Drop ONLY the exact diagnostic forms glob emits: the empty-result line
        // ("(no files found ...", "(no entries after offset ...") and the
        // suffix/warning lines ("... [N more entries]", "... [warning] ...").
        // A broad startsWith('(' / '...' / 'Error') would wrongly drop real
        // paths like ErrorBoundary.mjs or a "(draft)/x.mjs" leading segment.
        const hits = out.split('\n')
            .filter((s) => s && !/^\(no (?:files found|entries\b)/.test(s) && !/^\.\.\. \[/.test(s))
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 5);
        return hits.length ? `\n[path not found here; same-named indexed file(s): ${hits.join(', ')}]` : '';
    } catch {
        return '';
    }
}

function relativePathPrefix(pathPrefix, workDir) {
    if (!workDir) return pathPrefix;
    const cwdFwd = workDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const absFwd = String(pathPrefix || '').replace(/\\/g, '/');
    const haystack = process.platform === 'win32' ? absFwd.toLocaleLowerCase() : absFwd;
    const needle = process.platform === 'win32' ? cwdFwd.toLocaleLowerCase() : cwdFwd;
    if (haystack.startsWith(needle + '/') || haystack === needle) {
        return absFwd.slice(cwdFwd.length + 1) || '.';
    }
    return pathPrefix;
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

function relativeSearchResultPath(path, workDir) {
    const normalizedWorkDir = normalizeOutputPath(workDir);
    const normalizedAbs = normalizeOutputPath(path);
    if (normalizedAbs.startsWith(normalizedWorkDir + '/') || normalizedAbs.startsWith(normalizedWorkDir + '\\')) {
        return normalizedAbs.slice(normalizedWorkDir.length + 1);
    }
    return normalizedAbs;
}

function uniqueStrings(values) {
    return Array.from(new Set(values.filter((value) => typeof value === 'string' && value)));
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

function resolveSearchScope(root, workDir) {
    return isAbsolute(root) ? resolve(root) : resolveAgainstCwd(root, workDir);
}

function isUncOrSmbPath(path) {
    if (typeof path !== 'string' || !path) return false;
    return path.startsWith('\\\\') || path.startsWith('//');
}

function uncRefusalMessage(toolName, original, resolved) {
    const shown = normalizeOutputPath(resolved || original || '');
    return `Error: ${toolName} refuses UNC/SMB path ${JSON.stringify(shown)}; remote share access is blocked to prevent NTLM credential leaks`;
}

function basePathDiagnostic(basePaths, workDir) {
    return basePaths.map((basePath) => {
        const resolved = resolveSearchScope(basePath, workDir);
        try {
            const st = statSync(resolved);
            return `${normalizeOutputPath(basePath)}: ${st.isDirectory() ? 'path exists (dir)' : 'path exists (file)'}`;
        } catch (err) {
            return `${normalizeOutputPath(basePath)}: path does not exist (${err?.code || 'ENOENT'})`;
        }
    }).join('; ');
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

// Per-pattern file-count probe for array grby: runs ONE rg --files-with-matches
// per pattern (reusing the same scope/glob/type/flags as the merged search) so
// the summary line can surface patterns that matched zero files — otherwise the
// merged result hides which member of the array contributed nothing.
async function _perPatternFileCounts({ patterns, searchPath, globPatterns, caseInsensitive, multilineMode, fileType, workDir }) {
    const results = await Promise.all(patterns.map(async (pattern) => {
        try {
            const rgArgs = buildGrepRgArgs({
                patterns: [pattern],
                searchPath,
                globPatterns,
                outputMode: 'files_with_matches',
                caseInsensitive,
                showLineNumbers: false,
                beforeN: null,
                afterN: null,
                contextN: null,
                multilineMode,
                fileType,
                onlyMatching: false,
            });
            const stdout = await runRg(rgArgs, { cwd: workDir });
            // A boxed partial/truncated stdout means the count is not the true
            // total — render '?' rather than a misleadingly-low or zero number.
            if (stdout && typeof stdout === 'object' && (stdout.partial || stdout.truncated)) return null;
            return String(stdout).split('\n').filter(Boolean).length;
        } catch {
            // Probe threw → count unknown, NOT zero.
            return null;
        }
    }));
    // Quote first (so newline/control chars can't inject footer lines), then
    // truncate the quoted string to 40 chars — matches the no-match path.
    const trunc = (p) => {
        const q = JSON.stringify(p);
        return q.length > 40 ? `${q.slice(0, 40)}...` : q;
    };
    return `\n# per-pattern: ${patterns.map((p, i) => `${trunc(p)}=${results[i] === null ? '?' : `${results[i]} files`}`).join(', ')}`;
}

function formatGrepOutput({ windowed, totalWindowed, totalKnown, headLimit, offset, outputMode, patterns: _patterns, beforeN, afterN, contextN, searchPath, grepResolvedPath: _grepResolvedPath, workDir, globPatterns: _globPatterns, fileType: _fileType, filenameOmitted = false, prefix = '', broadAdvisory: _broadAdvisory = true }) {
    const lines = headLimit === Infinity ? windowed : windowed.slice(0, headLimit);
    const normalized = lines.map((line) => relativeGrepLine(line, workDir, outputMode === 'files_with_matches', outputMode, filenameOmitted));
    const remaining = Math.max(0, totalWindowed - lines.length);
    const shown = lines.length;
    const total = totalWindowed;
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
    const groupedBody = (outputMode === 'content' && !hasContext && !filenameOmitted)
        ? groupGrepContentByFile(normalized)
        : normalized.join('\n');
    const body = groupedBody + truncated + countSummary;
    return `${prefix}${body}`;
}

export async function executeGrepTool(args, workDir, executeChildBuiltinTool, readStateScope = null, options = {}) {
    args = normalizeGrepArgs(args);
    // Shape context immediately before deriving rg flags. This keeps the
    // Lead-direct MCP path and direct executeGrepTool callers on the same
    // policy even if they bypass or race the outer builtin arg guard.
    applyGrepContextLeadPolicy(args);
    args.path = normalizeInputPath(args.path);
    args.pattern = coerceShapeFlex(args.pattern);
    args.glob = coerceShapeFlex(args.glob);
    const rawPattern = args.pattern;
    const patterns = uniqueStrings((Array.isArray(rawPattern)
        ? rawPattern.filter(p => typeof p === 'string' && p)
        : (rawPattern ? [String(rawPattern)] : [])).map(normalizeSearchPattern));
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
    const multilineMode = args.multiline === true;
    if (multilineMode && patterns.length > GREP_MULTILINE_PATTERN_CAP) {
        return `Error: multiline:true with more than ${GREP_MULTILINE_PATTERN_CAP} patterns is not allowed (got ${patterns.length}); split into separate grep calls`;
    }
    if (patterns.length > GREP_ARRAY_PATTERN_CAP) {
        return `Error: pattern array exceeds the ${GREP_ARRAY_PATTERN_CAP}-pattern cap (got ${patterns.length}); split into separate grep calls`;
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
    const normalizedGlobPatterns = uniqueStrings(globPatterns.map(canonicalizeGlobSlashes));

    const ALLOWED_OUTPUT_MODES = new Set(['files_with_matches', 'content', 'count']);
    const rawOutputMode = typeof args.output_mode === 'string' ? args.output_mode.trim() : '';
    if (rawOutputMode && !ALLOWED_OUTPUT_MODES.has(rawOutputMode)) {
        return `Error: invalid output_mode ${JSON.stringify(args.output_mode)}; expected one of ${[...ALLOWED_OUTPUT_MODES].join(', ')}`;
    }
    // Default to `content` when output_mode is omitted. A pattern is always
    // present here (the no-pattern case returned above), so this is a content
    // search — it should return the matching lines WITH line numbers, not just
    // filenames. Filename-only was forcing callers to re-grep for the actual
    // coordinates (the explorer over-iteration root cause). `files_with_matches`
    // is now opt-in; pure filename discovery belongs to `glob`.
    const outputMode = rawOutputMode || 'content';
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
    });
    // Single-file grep registers a whole-file read snapshot (parity with
    // apply_patch), satisfying the read-before-edit guard while keeping drift
    // detection intact via the auto-computed contentHash. Directory/glob greps
    // do NOT record.
    const recordGrepReadSnapshot = (st) => {
        try {
            if (st && st.isFile()) {
                recordReadSnapshot(grepResolvedPath, st, readStateScope, { source: 'grep' });
            }
        } catch {}
    };

    const cached = cacheGet(cacheKey);
    // Cache-hit returns a PRIOR grep's output; the file may have changed since
    // that result was cached. Recording a fresh whole-file snapshot here would
    // mismatch what the caller actually saw (stale cached lines) and defeat
    // drift detection. So only the fresh-compute path (below) records a read.
    if (cached !== null) return cached;

    let grepStat;
    try { grepStat = statSync(grepResolvedPath); }
    catch (err) {
        const msg = `Error: path does not exist: ${normalizeOutputPath(grepResolvedPath)} (${err?.code || 'ENOENT'})`;
        return msg + await _suggestIndexedPaths(grepResolvedPath, executeChildBuiltinTool, workDir);
    }
    const filenameOmitted = grepStat.isFile();

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

    try {
        const GREP_CONTENT_HARD_CAP = 300;
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
        });
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
        // Array-pattern visibility: append a per-pattern file-count summary so
        // zero-hit members of the merged result are not silently hidden.
        let perPatternSummary = '';
        if (patterns.length > 1) {
            perPatternSummary = await _perPatternFileCounts({
                patterns,
                searchPath,
                globPatterns: normalizedGlobPatterns,
                caseInsensitive,
                multilineMode,
                fileType,
                workDir: rgSpawnCwd,
            });
        }
        const out = body + rgPartialSuffix + perPatternSummary;
        const shownLines = headLimit === Infinity ? windowed : windowed.slice(0, headLimit);
        const remaining = Math.max(0, totalWindowed - shownLines.length);
        // Mirrors formatGrepOutput truncation / totalKnown semantics.
        if (options?.scopedCacheOutcome && (!totalKnown || remaining > 0)) {
            markScopedCacheIncomplete(options.scopedCacheOutcome);
        }
        recordGrepReadSnapshot(grepStat);
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
        const stderr = err?.stderr ? String(err.stderr).trim() : '';
        const msg = stderr || err?.message || String(err);
        return `Error: ${msg.slice(0, 500)}`;
    }
}

export async function executeGlobTool(args, workDir, options = {}) {
    args = normalizeGlobArgs(args);
    args.path = Array.isArray(args.path)
        ? args.path.map((p) => normalizeInputPath(p)).filter((p) => typeof p === 'string' && p)
        : normalizeInputPath(args.path);
    if (Array.isArray(args.path) && args.path.length === 0) {
        return 'Error: path array must contain at least one base directory';
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
        return globMissingPatternMessage();
    }

    const basePaths = (Array.isArray(args.path) && args.path.length > 0)
        ? args.path
        : [args.path || '.'];
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
    const cacheKey = buildGlobCacheKey({ patterns, basePath: cacheBasePath, headLimit, offset, extraIgnore: extraIgnoreGlobs });
    const cached = cacheGet(cacheKey);
    if (cached !== null) return cached;

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
        try { statSync(rgCwd); }
        catch (err) {
            return {
                error: `path does not exist: ${normalizeOutputPath(rgCwd)} (${err?.code || 'ENOENT'})`,
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
    // Bound the post-rg stat phase: a single hung stat (dead mount /
    // unresponsive network path) must not pin glob until the 600s bridge stall
    // watchdog. Per-stat 5s deadline → a hung entry is treated as stat-failed
    // and dropped, while normal local stats (sub-ms) are unaffected.
    const withStatAll = await statPathsForMtime(unique, workDir, 64, { deadlineMs: 5000 });
    const withStat = withStatAll.filter((entry) => entry?.stat != null);
    withStat.sort((a, b) => {
        const dm = b.mtime - a.mtime;
        if (dm !== 0) return dm;
        return globMtimeTiePath(a).localeCompare(globMtimeTiePath(b));
    });
    const totalBeforeOffset = withStat.length;
    const windowed = offset > 0 ? withStat.slice(offset) : withStat;
    const capped = (headLimit === Infinity ? windowed : windowed.slice(0, headLimit)).map((entry) => {
        const abs = entry.full || resolveAgainstCwd(entry.path, workDir);
        return relativeSearchResultPath(abs, workDir);
    });
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
            emptyDiag = `(no files found) pattern=${patternStr} path=${baseLabel}; ${basePathDiagnostic(baseEntries.map((e) => e.root), workDir)}`;
        }
    }
    const body = capped.length > 0
        ? `${capped.join('\n')}${remaining > 0 ? `\n... [${remaining} more entries of ${totalBeforeOffset} total — pass offset:${offset + capped.length} to continue]` : ''}${errSuffix}`
        : '';
    const out = body || emptyDiag || '(no files found)';
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
}
