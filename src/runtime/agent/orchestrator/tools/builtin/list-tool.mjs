import { readdir, stat } from 'fs/promises';
import { basename, isAbsolute, relative } from 'path';
import {
    coerceReadFamilyPathArg,
    extractGlobBaseDirectory,
    hasGlobMagic,
    normalizeInputPath,
    normalizeOutputPath,
    resolveAgainstCwd,
} from './path-utils.mjs';
import { normalizeErrorMessage } from './path-diagnostics.mjs';
import {
    buildListCacheKey,
    DEFAULT_IGNORE_GLOBS,
    rootScanIgnoreGlobs,
} from './search-builders.mjs';
import { markScopedCacheIncomplete } from '../../session/cache/scoped-cache-outcome.mjs';
import {
    cacheGet,
    cacheSet,
    runResultCacheInFlight,
    lstatPathsForMtime,
    statCacheSet,
    statPathsForMtime,
} from './cache-layers.mjs';
import { formatListSize, formatMtime } from './list-formatting.mjs';
import {
    compileSimpleGlob,
    NOISE_DIR_NAMES,
    walkDir,
} from './glob-walk.mjs';
import {
    capLineOrientedToolOutput,
    LOCATOR_OUTPUT_MAX_BYTES,
    TOOL_OUTPUT_MAX_BYTES,
} from './tool-output-limit.mjs';
import { runRg, runRgWindowedLines } from './native-search-runner.mjs';
import { tryServeFuzzySearch, tryServeListMetadata } from './native-search-client.mjs';
import {
    recordLocalSearchBackend,
    recordLocalSearchCacheHit,
    recordNativeSearchTiming,
} from './local-search-telemetry.mjs';
import { assertPathReachable } from './fs-reachability.mjs';
import { listGuardPath, normalizeListHeadLimit, readFamilyPathEnoentOrError } from './lib/list-helpers.mjs';
import {
    recordRuntimeDirectoryReadSuccess,
    reportRuntimeDirectoryReadFailure,
} from '../../../../shared/session-runtime-health.mjs';

function positiveTimeoutEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
const FIND_WALK_TIMEOUT_MS = 20_000;
// Fuzzy find is a locate-the-path probe, not an inventory: it must answer in
// about a second even when the caller points it at `/`. The old 20s walk hit
// the read-only deadline first and returned NOTHING (observed live: six
// whole-filesystem probes across six benchmark tasks, each burning a turn for
// an error). At this cap the native search returns its ranked partial instead.
const FIND_FUZZY_TIMEOUT_MS = positiveTimeoutEnv('MIXDOG_FIND_FUZZY_TIMEOUT_MS', 1_500);
// Same contract for name/glob find: bound the walk and the metadata pass, then
// SAY the result is partial. The old 20s walk plus a 5s stat deadline silently
// dropped every path whose stat missed the deadline, so a slow scope reported
// fewer matches than it actually found.
const FIND_FILES_TIMEOUT_MS = positiveTimeoutEnv('MIXDOG_FIND_FILES_TIMEOUT_MS', 2_000);
const FIND_STAT_DEADLINE_MS = positiveTimeoutEnv('MIXDOG_FIND_STAT_DEADLINE_MS', 1_000);
const LIST_WALK_TIMEOUT_MS = 20_000;
const LIST_ABSOLUTE_CAP = 50_000;

function directoryReadFailureLine(failure, warning = false) {
    const code = String(failure?.error?.code || 'UNKNOWN').toUpperCase();
    const path = normalizeOutputPath(failure?.dir || '');
    return `${warning ? '[warning] ' : 'Error: '}readdir failed (${code}): ${path}`;
}

function throwIfDirectoryWalkAborted(signal, walkResult, label) {
    if (!signal?.aborted && !walkResult?.aborted) return;
    if (signal?.reason instanceof Error) throw signal.reason;
    const error = new Error(String(signal?.reason || `${label} aborted`));
    error.name = 'AbortError';
    throw error;
}

function recordDirectoryWalkTelemetry(options, status, walkResult, warningCount = 0) {
    if (!options?.resultTelemetry || typeof options.resultTelemetry !== 'object') return;
    options.resultTelemetry.integrity = {
        kind: 'directory-walk',
        status,
        entriesVisited: Math.max(0, Number(walkResult?.entriesVisited) || 0),
        warnings: Math.max(0, Number(warningCount) || 0),
    };
}

// A/B override surface for the default result caps (stock: list 100, tree 200,
// fuzzy find 25). Env-gated so bench variants can match competitor-style
// generous caps without changing the shipped defaults.
function _listDefaultHeadLimit(fallback) {
    const parsed = parseInt(process.env.MIXDOG_LIST_DEFAULT_HEAD_LIMIT ?? '', 10);
    return parsed > 0 ? parsed : fallback;
}
function _findDefaultHeadLimit(fallback) {
    const parsed = parseInt(process.env.MIXDOG_FIND_DEFAULT_HEAD_LIMIT ?? '', 10);
    return parsed > 0 ? parsed : fallback;
}

function _findOutputBudgetBytes(options = {}) {
    const requested = Number(options?.__findOutputBudgetBytes);
    const explicit = Number(options?.toolOutputMaxBytes);
    return Math.max(1, Math.min(
        LOCATOR_OUTPUT_MAX_BYTES,
        Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : LOCATOR_OUTPUT_MAX_BYTES,
        Number.isFinite(explicit) && explicit > 0 ? Math.trunc(explicit) : LOCATOR_OUTPUT_MAX_BYTES,
    ));
}

// Entry paths render relative to the listed root — the caller supplied the
// base via `path`, so repeating the absolute prefix on every row is pure
// duplication (~2KB per 80 rows). Falls back to the absolute form when the
// entry escapes the root (drive change / `..`), where a relative form would
// be ambiguous. Cache-safe: keys already include the absolute root, and the
// rendered rows no longer depend on the session workDir.
function displayRelPath(entPath, rootPath) {
    const rel = relative(rootPath, entPath);
    if (!rel || rel === '.' || rel.startsWith('..') || /^[A-Za-z]:/.test(rel)) {
        return normalizeOutputPath(entPath);
    }
    return normalizeOutputPath(rel);
}

// `meta` column renderers: compact `ls -l` equivalents (size bytes,
// second-precision UTC mtime, octal permission bits). Stat-failed entries
// render `?` so a denied/hung lstat is visible instead of masquerading as an
// empty epoch-zero file.
function _metaMtimeIso(mtimeMs) {
    if (!(mtimeMs > 0)) return '?';
    return new Date(mtimeMs).toISOString().slice(0, 19) + 'Z';
}
function _metaModeOctal(mode) {
    if (!(mode > 0)) return '?';
    return (mode & 0o7777).toString(8).padStart(3, '0');
}

async function listMetadataForPaths(paths, workDir, options = {}) {
    if (!Array.isArray(paths) || paths.length === 0) return [];
    const nativeImpl = typeof options?.__tryServeListMetadata === 'function'
        ? options.__tryServeListMetadata
        : tryServeListMetadata;
    try {
        const entries = await nativeImpl(paths, {
            cwd: workDir,
            signal: options?.signal || options?.abortSignal || null,
            timeout: 5_000,
        });
        if (Array.isArray(entries) && entries.length === paths.length) {
            return entries.map((entry, index) => ({
                fullPath: paths[index],
                type: entry && !entry.error ? String(entry.type || '') : '',
                stat: entry && !entry.error ? { mode: Number(entry.mode) || 0 } : null,
                size: entry && !entry.error ? Math.max(0, Number(entry.size) || 0) : 0,
                mtimeMs: entry && !entry.error ? Math.max(0, Number(entry.mtimeMs) || 0) : 0,
            }));
        }
    } catch {
        // Older/unavailable native helpers preserve the existing JS fallback.
    }
    return lstatPathsForMtime(paths, workDir, 64, { deadlineMs: 5000 });
}

async function tryNativeDeepListRows({
    fullPath,
    workDir,
    depth,
    hidden,
    includeNoise,
    signal,
    options,
}) {
    if (depth <= 1 || typeof options?.readdirImpl === 'function') return null;
    const rgArgs = ['--files', '--directories', '--no-ignore', '--no-require-git'];
    if (hidden) rgArgs.push('--hidden');
    rgArgs.push('--max-depth', String(depth));
    if (!includeNoise) {
        for (const glob of DEFAULT_IGNORE_GLOBS) rgArgs.push('--glob', glob);
    }
    rgArgs.push('--', fullPath);
    try {
        const served = await runRgWindowedLines(
            rgArgs,
            { cwd: workDir, timeout: LIST_WALK_TIMEOUT_MS, signal },
            { offset: 0, limit: LIST_ABSOLUTE_CAP, nativeInventory: true },
        );
        if (served?.complete !== true || served?.partial === true || !Array.isArray(served?.lines)) {
            return null;
        }
        const paths = Array.from(new Set(served.lines.map((line) => (
            isAbsolute(line) ? line : resolveAgainstCwd(line, workDir)
        )))).filter((path) => path !== fullPath);
        const metadata = await listMetadataForPaths(paths, workDir, options);
        if (!Array.isArray(metadata) || metadata.length !== paths.length) return null;
        const rows = paths.map((path, index) => {
            const item = metadata[index] || {};
            const type = ['file', 'dir', 'symlink', 'other'].includes(item.type)
                ? item.type
                : (item.stat?.isDirectory?.()
                    ? 'dir'
                    : (item.stat?.isFile?.()
                        ? 'file'
                        : (item.stat?.isSymbolicLink?.() ? 'symlink' : 'other')));
            return {
                path,
                type,
                size: Number(item.size) || 0,
                mtimeMs: Number(item.mtimeMs) || 0,
                // listMetadataForPaths stores permissions at item.stat.mode
                // (both the native and the lstat fallback shape); reading
                // item.mode made every recursive meta:true row print `?`.
                mode: Number(item.stat?.mode ?? item.mode) || 0,
                fullPath: path,
            };
        });
        return {
            rows,
            walkResult: {
                entriesVisited: rows.length,
                directoriesVisited: rows.filter((row) => row.type === 'dir').length,
                aborted: false,
                nativeInventory: true,
            },
        };
    } catch {
        return null;
    }
}

export async function executeListTool(args, workDir, options = {}) {
    if (args.mode === 'tree') return executeTreeTool(args, workDir, options);
    if (args.mode === 'find') return executeFindFilesTool(args, workDir, options);
    args.path = normalizeInputPath(args.path);
    if (!args.name && hasGlobMagic(args.path)) {
        return executeFindFilesTool({ ...args, mode: 'find' }, workDir);
    }
    const inputPath = args.path || '.';
    const depth = Math.min(Math.max(parseInt(args.depth ?? 1, 10) || 1, 1), 10);
    const hidden = Boolean(args.hidden);
    const sort = ['name', 'mtime', 'size'].includes(args.sort) ? args.sort : 'name';
    const typeFilter = ['any', 'file', 'dir'].includes(args.type) ? args.type : 'any';
    const listHeadLimitCap = _listDefaultHeadLimit(100);
    const requestedHeadLimit = normalizeListHeadLimit(args.head_limit, listHeadLimitCap);
    const headLimit = requestedHeadLimit === 0
        ? 0
        : Math.min(requestedHeadLimit, listHeadLimitCap);
    const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
    const needsGlobalStat = sort === 'mtime' || sort === 'size';
    const includeNoise = Boolean(args.include_noise);
    const meta = Boolean(args.meta);
    const _listGuard = listGuardPath(inputPath);
    if (_listGuard) return _listGuard;
    const fullPath = resolveAgainstCwd(inputPath, workDir);
    const _listGuardFull = listGuardPath(fullPath);
    if (_listGuardFull) return _listGuardFull;
    const cacheKey = buildListCacheKey({
        mode: 'list',
        inputPath: normalizeOutputPath(fullPath),
        depth,
        hidden,
        sort,
        typeFilter,
        headLimit,
        offset,
        includeNoise,
        meta,
    });
    const cached = cacheGet(cacheKey);
    if (cached !== null) return cached;
    if (options?._listSingleFlightKey !== cacheKey) {
        return await runResultCacheInFlight(
            cacheKey,
            ({ signal }) => executeListTool(
                { ...args },
                workDir,
                { ...options, signal, _listSingleFlightKey: cacheKey },
            ),
            {
                signal: options?.signal || options?.abortSignal || null,
                scopes: [fullPath],
            },
        );
    }
    let _preStat;
    try { _preStat = await assertPathReachable(fullPath); }
    catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
    // Feed the reachability preflight's stat into the cache so the root is
    // stat'd once instead of immediately re-stat'd by getCachedReadOnlyStat.
    if (_preStat) statCacheSet(fullPath, _preStat);
    let st;
    try {
        st = _preStat || await stat(fullPath);
        if (!_preStat) statCacheSet(fullPath, st);
    }
    catch (err) {
        return await readFamilyPathEnoentOrError(workDir, fullPath, inputPath, args, options, err, executeListTool);
    }
    if (!st.isDirectory()) {
        if (st.isFile()) {
            const out = meta
                ? `${normalizeOutputPath(fullPath)}\tfile\t${st.size}\t${_metaMtimeIso(st.mtimeMs)}\t${_metaModeOctal(st.mode)}`
                : `${normalizeOutputPath(fullPath)}\tfile`;
            cacheSet(cacheKey, out, { scopes: [fullPath] });
            return out;
        }
        return `Error: not a directory — ${normalizeOutputPath(fullPath)}`;
    }

    const rows = [];
    // Width guard: depth is capped above, but a single very wide directory
    // tree could push unbounded rows before sort/slice runs and exhaust
    // memory. Mirror the find-mode FIND_ABSOLUTE_CAP + walk deadline so the
    // accumulator stops growing once the cap or timeout trips. Small dirs
    // never hit either bound, so normal behavior is unchanged.
    let truncatedByCap = false;
    const walkWarnings = [];
    const walkDeadline = Date.now() + LIST_WALK_TIMEOUT_MS;
    const nativeDeep = await tryNativeDeepListRows({
        fullPath,
        workDir,
        depth,
        hidden,
        includeNoise,
        signal: options.signal,
        options,
    });
    let walkResult;
    if (nativeDeep) {
        for (const row of nativeDeep.rows) {
            if (typeFilter === 'file' && row.type !== 'file') continue;
            if (typeFilter === 'dir' && row.type !== 'dir') continue;
            rows.push(row);
        }
        walkResult = nativeDeep.walkResult;
    } else {
        walkResult = await walkDir(fullPath, {
            hidden,
            maxDepth: depth,
            excludeDirNames: includeNoise ? null : NOISE_DIR_NAMES,
            signal: options.signal,
            readdirImpl: options.readdirImpl,
            onWarn: (dir, error, context) => walkWarnings.push({ dir, error, root: Boolean(context?.root) }),
            visit: (ent, entPath) => {
                if (Date.now() > walkDeadline) { truncatedByCap = true; return false; }
                const isDir = ent.isDirectory();
                const isFile = ent.isFile();
                if (typeFilter === 'file' && !isFile) return;
                if (typeFilter === 'dir' && !isDir) return;
                const entType = isDir ? 'dir' : (isFile ? 'file' : (ent.isSymbolicLink() ? 'symlink' : 'other'));
                rows.push({
                    path: entPath,
                    type: entType,
                    size: 0,
                    mtimeMs: 0,
                    mode: 0,
                    fullPath: entPath,
                });
                if (rows.length >= LIST_ABSOLUTE_CAP) {
                    truncatedByCap = true;
                    return false;
                }
                // Pre-sort truncation removed: a global name sort needs all
                // candidates collected before slicing, otherwise the visible
                // window depends on traversal order rather than sort order.
            },
        });
    }
    throwIfDirectoryWalkAborted(options.signal, walkResult, 'list walk');
    const rootFailure = walkWarnings.find((warning) => warning.root);
    if (rootFailure) {
        reportRuntimeDirectoryReadFailure(fullPath, rootFailure.error);
        recordDirectoryWalkTelemetry(options, 'failed', walkResult, walkWarnings.length);
        if (options?.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
        return directoryReadFailureLine(rootFailure);
    }
    recordRuntimeDirectoryReadSuccess();

    if (!nativeDeep && needsGlobalStat && rows.length > 0) {
        // lstat: symlinks should report own metadata, not the target's.
        const stats = await listMetadataForPaths(rows.map((row) => row.fullPath), workDir, options);
        for (let i = 0; i < rows.length; i++) {
            const item = stats[i];
            if (!item?.stat) continue;
            rows[i].size = item.size;
            rows[i].mtimeMs = item.mtimeMs;
            rows[i].mode = item.stat.mode;
        }
    }

    if (sort === 'mtime') rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
    else if (sort === 'size') rows.sort((a, b) => b.size - a.size);
    else rows.sort((a, b) => a.path.localeCompare(b.path));

    const windowed = offset > 0 ? rows.slice(offset) : rows;
    const sliced = headLimit > 0 ? windowed.slice(0, headLimit) : windowed;
    // Paths and entry types are the default list contract; size/mtime/mode
    // stat columns are opt-in via `meta` so the `ls -la` metadata surface has
    // a first-class home without taxing every listing. Meta-only requests
    // stat just the visible window (a global stat already ran for
    // mtime/size sorts); `sliced` shares row objects with `rows`, so the
    // assignments land on the rendered entries.
    if (!nativeDeep && meta && !needsGlobalStat && sliced.length > 0) {
        const stats = await listMetadataForPaths(sliced.map((row) => row.fullPath), workDir, options);
        for (let i = 0; i < sliced.length; i++) {
            const item = stats[i];
            if (!item?.stat) continue;
            sliced[i].size = item.size;
            sliced[i].mtimeMs = item.mtimeMs;
            sliced[i].mode = item.stat.mode;
        }
    }
    const lines = sliced.map(r => meta
        ? `${displayRelPath(r.path, fullPath)}\t${r.type}\t${r.size}\t${_metaMtimeIso(r.mtimeMs)}\t${_metaModeOctal(r.mode)}`
        : `${displayRelPath(r.path, fullPath)}\t${r.type}`);
    if (windowed.length > sliced.length) lines.push(`... [entries ${offset + 1}-${offset + sliced.length} of ${rows.length}; pass offset:${offset + sliced.length} to continue]`);
    if (truncatedByCap) lines.push(`... walk truncated at ${LIST_ABSOLUTE_CAP} rows or ${LIST_WALK_TIMEOUT_MS}ms timeout; narrow the path or lower depth for a complete listing`);
    for (const warning of walkWarnings) lines.push(directoryReadFailureLine(warning, true));
    let emptyMsg = '(empty directory)';
    if (lines.length === 0 && offset > 0 && rows.length > 0) {
        // Offset past the end is a windowing condition, not a filter one —
        // blaming hidden/type filters here misdirects the next call.
        emptyMsg = `(no entries after offset=${offset}; total=${rows.length}) path=${inputPath}`;
    } else if (lines.length === 0 && (typeFilter !== 'any' || hidden === false)) {
        const filterParts = [];
        if (typeFilter !== 'any') filterParts.push(`type=${typeFilter}`);
        if (hidden === false) {
            let hasHidden = false;
            try {
                const entries = await readdir(fullPath, { withFileTypes: true });
                hasHidden = entries.some(e => e.name && e.name.startsWith('.'));
            } catch {}
            if (hasHidden) filterParts.push(`hidden=false (dotfiles present — pass hidden:true to include)`);
            else filterParts.push(`hidden=false`);
        }
        emptyMsg = `(no entries match filter) ${filterParts.join(', ')} path=${inputPath}`;
    }
    const out = lines.join('\n') || emptyMsg;
    recordDirectoryWalkTelemetry(
        options,
        walkWarnings.length > 0
            ? 'partial'
            : (walkResult.entriesVisited === 0 ? 'empty' : (rows.length === 0 ? 'filtered-empty' : 'complete')),
        walkResult,
        walkWarnings.length,
    );
    if (options?.scopedCacheOutcome && (truncatedByCap || windowed.length > sliced.length || walkWarnings.length > 0)) {
        markScopedCacheIncomplete(options.scopedCacheOutcome);
    }
    if (walkWarnings.length === 0) cacheSet(cacheKey, out, { scopes: [fullPath] });
    // ② completion progress (claude "Found N" parity). Best-effort, no-op
    // when onProgress is absent (no progressToken).
    if (typeof options?.onProgress === 'function') {
        try { options.onProgress(`${windowed.length} entries`); } catch { /* best-effort */ }
    }
    return out;
}

export async function executeTreeTool(args, workDir, options = {}) {
    args.path = normalizeInputPath(args.path);
    const inputPath = args.path || '.';
    const depth = Math.min(Math.max(parseInt(args.depth ?? 3, 10) || 3, 1), 6);
    const hidden = Boolean(args.hidden);
    const headLimit = normalizeListHeadLimit(args.head_limit, _listDefaultHeadLimit(200));
    const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
    const includeNoise = Boolean(args.include_noise);
    const _treeGuard = listGuardPath(inputPath);
    if (_treeGuard) return _treeGuard;
    const fullPath = resolveAgainstCwd(inputPath, workDir);
    const _treeGuardFull = listGuardPath(fullPath);
    if (_treeGuardFull) return _treeGuardFull;
    const cacheKey = buildListCacheKey({
        mode: 'tree',
        inputPath: normalizeOutputPath(fullPath),
        depth,
        hidden,
        sort: '',
        typeFilter: '',
        headLimit,
        offset,
        includeNoise,
    });
    const cached = cacheGet(cacheKey);
    if (cached !== null) return cached;
    let _preStat;
    try { _preStat = await assertPathReachable(fullPath); }
    catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
    if (_preStat) statCacheSet(fullPath, _preStat);
    let st;
    try {
        st = _preStat || await stat(fullPath);
        if (!_preStat) statCacheSet(fullPath, st);
    }
    catch (err) {
        return await readFamilyPathEnoentOrError(workDir, fullPath, inputPath, args, options, err, executeListTool);
    }
    if (!st.isDirectory()) return `Error: not a directory — ${normalizeOutputPath(fullPath)}`;
    const lines = [`${normalizeOutputPath(fullPath)}/`];
    const prefixStack = [''];
    const TREE_BRANCH_LINE_CAP = 500;
    const walkWarnings = [];
    const walkResult = await walkDir(fullPath, {
        hidden,
        maxDepth: depth,
        excludeDirNames: includeNoise ? null : NOISE_DIR_NAMES,
        signal: options.signal,
        readdirImpl: options.readdirImpl,
        onWarn: (dir, error, context) => walkWarnings.push({ dir, error, root: Boolean(context?.root) }),
        sort: (a, b) => {
            const ad = a.isDirectory(), bd = b.isDirectory();
            if (ad !== bd) return ad ? -1 : 1;
            return a.name.localeCompare(b.name);
        },
        visit: (ent, _entPath, ctx) => {
            const prefix = prefixStack[ctx.depth - 1] || '';
            const branch = ctx.isLast ? '└── ' : '├── ';
            const display = ent.isDirectory() ? `${ent.name}/` : ent.name;
            lines.push(`${prefix}${branch}${display}`);
            if (ent.isDirectory()) {
                prefixStack[ctx.depth] = prefix + (ctx.isLast ? '    ' : '│   ');
            }
            if (headLimit !== 0) {
                const gatherLimit = headLimit > 0
                    ? offset + headLimit + 1
                    : offset + TREE_BRANCH_LINE_CAP + 1;
                // Exclude the root line (lines[0]) from the body-row count:
                // the windowed slice operates on lines.slice(1), so gather
                // must measure body rows, not total. Without -1 the sentinel
                // "+N more entries" misfires off-by-one on the boundary.
                if (lines.length - 1 >= gatherLimit) return false;
            }
        },
    });
    throwIfDirectoryWalkAborted(options.signal, walkResult, 'tree walk');
    const rootFailure = walkWarnings.find((warning) => warning.root);
    if (rootFailure) {
        reportRuntimeDirectoryReadFailure(fullPath, rootFailure.error);
        recordDirectoryWalkTelemetry(options, 'failed', walkResult, walkWarnings.length);
        if (options?.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
        return directoryReadFailureLine(rootFailure);
    }
    recordRuntimeDirectoryReadSuccess();
    const root = lines[0];
    const body = lines.slice(1);
    const windowed = offset > 0 ? body.slice(offset) : body;
    // head_limit:0 means "no cap" (Infinity); negative/NaN means "use default cap".
    const branchLimit = headLimit === 0
        ? Infinity
        : (headLimit > 0 ? headLimit : TREE_BRANCH_LINE_CAP);
    const sliced = branchLimit === Infinity ? windowed : windowed.slice(0, branchLimit);
    const outLines = [root, ...sliced];
    if (windowed.length > sliced.length) {
        // The walk stops gathering at gatherLimit, so when body filled to the
        // cap the true total is unknown — render `N+` so the caller keeps
        // paging instead of reading the capped count as the real total.
        const gatherCap = headLimit > 0 ? offset + headLimit + 1 : offset + TREE_BRANCH_LINE_CAP + 1;
        const totalLabel = body.length >= gatherCap ? `${body.length}+` : `${body.length}`;
        outLines.push(`... [entries ${offset + 1}-${offset + sliced.length} of ${totalLabel}; pass offset:${offset + sliced.length} to continue]`);
    }
    for (const warning of walkWarnings) outLines.push(directoryReadFailureLine(warning, true));
    const TREE_OUTPUT_CHAR_CAP = TOOL_OUTPUT_MAX_BYTES;
    let out = outLines.join('\n');
    let outputCharTruncated = false;
    if (out.length > TREE_OUTPUT_CHAR_CAP) {
        outputCharTruncated = true;
        out = out.slice(0, TREE_OUTPUT_CHAR_CAP) + `\n... [output truncated at ${Math.round(TREE_OUTPUT_CHAR_CAP/1024)} KB; narrow path or lower depth]`;
    }
    recordDirectoryWalkTelemetry(
        options,
        walkWarnings.length > 0
            ? 'partial'
            : (walkResult.entriesVisited === 0 ? 'empty' : 'complete'),
        walkResult,
        walkWarnings.length,
    );
    if (options?.scopedCacheOutcome && (windowed.length > sliced.length || outputCharTruncated || walkWarnings.length > 0)) {
        markScopedCacheIncomplete(options.scopedCacheOutcome);
    }
    if (walkWarnings.length === 0) cacheSet(cacheKey, out, { scopes: [fullPath] });
    return out;
}

// Fuzzy filename search has one canonical implementation: the Rust search
// server's resident inventory. A server failure is surfaced instead of
// launching a second filesystem walk with different semantics.
export async function executeFuzzyFindTool(args, workDir, options = {}) {
    return runFuzzyFindPass(args, workDir, options);
}

async function runFuzzyFindPass(args, workDir, options = {}) {
    const query = String(args.query ?? '').trim();
    if (!query) return 'Error: find requires query.';
    const inputPath = normalizeInputPath(args.path) || '.';
    const guard = listGuardPath(inputPath);
    if (guard) return guard;
    const fullPath = resolveAgainstCwd(inputPath, workDir);
    const guardFull = listGuardPath(fullPath);
    if (guardFull) return guardFull;
    // Fuzzy find defaults to searching dot-directories (hidden:true) so
    // machine-wide discovery reaches paths like ~/.mixdog/data/…; callers
    // opt out with hidden:false. .git and other noise dirs are still pruned
    // via DEFAULT_IGNORE_GLOBS below (unless include_noise).
    const hidden = args.hidden === false ? false : true;
    const includeNoise = Boolean(args.include_noise);
    // head_limit:0 means "no cap" per list semantics; default is intentionally
    // compact so ambiguous discovery does not dump a huge candidate list.
    const headLimit = normalizeListHeadLimit(args.head_limit, _findDefaultHeadLimit(25));
    const depth = args.depth != null ? Math.max(parseInt(args.depth, 10) || 1, 1) : null;
    const cacheKey = buildListCacheKey({
        mode: 'fuzzy_find',
        inputPath: normalizeOutputPath(fullPath),
        depth: depth ?? '',
        hidden,
        sort: 'score',
        typeFilter: 'file',
        headLimit,
        offset: '',
        namePattern: query,
        includeNoise,
    });
    const cached = cacheGet(cacheKey);
    const capFindResult = (value) => capLineOrientedToolOutput(
        value,
        _findOutputBudgetBytes(options),
        () => `... [find result budget reached for query=${JSON.stringify(query)}; narrow path/limit]`,
    );
    if (cached !== null) {
        recordLocalSearchCacheHit('result');
        return capFindResult(cached);
    }
    const nativeFuzzyImpl = typeof options?.__tryServeFuzzySearch === 'function'
        ? options.__tryServeFuzzySearch
        : tryServeFuzzySearch;
    let nativeEmptyPartial = null;
    // Space-separated fragments AND-match one path. The native matcher handles
    // every token independently and sums exact per-token scores.
    {
        const nativeStartedAt = performance.now();
        try {
            const served = await nativeFuzzyImpl({
                query,
                cwd: fullPath,
                limit: headLimit > 0 ? headLimit + 1 : 1_000,
                hidden,
                includeNoise,
                maxDepth: depth,
                exclude: [
                    ...(includeNoise ? [] : DEFAULT_IGNORE_GLOBS),
                    // Kernel-virtual trees are pruned even under include_noise:
                    // they are never dependency noise, and walking them starves
                    // the fuzzy inventory budget on a full-root scan.
                    ...rootScanIgnoreGlobs(fullPath),
                ],
            }, {
                cwd: fullPath,
                timeout: FIND_FUZZY_TIMEOUT_MS,
                signal: options.signal,
            });
            if (served?.complete) {
                recordNativeSearchTiming(served);
                recordLocalSearchBackend('native_fuzzy', performance.now() - nativeStartedAt, 'hit');
                const hasMore = served.hasMore || (headLimit > 0 && served.matches.length > headLimit);
                const matches = headLimit > 0 && hasMore ? served.matches.slice(0, headLimit) : served.matches;
                const lines = matches.length === 0
                    ? [`(no fuzzy match for "${query}")`]
                    : [...matches, ...(hasMore ? [`... (top ${headLimit || 1_000}; narrow query or raise limit for more)`] : [])];
                const result = lines.join('\n');
                if (served.cacheSafe !== false) {
                    cacheSet(cacheKey, result, { scopes: [fullPath] });
                }
                if (typeof options?.onProgress === 'function') {
                    try { options.onProgress(`${matches.length} candidates`); } catch {}
                }
                return capFindResult(result);
            }
            if (served?.partial) {
                recordNativeSearchTiming(served);
                recordLocalSearchBackend('native_fuzzy', performance.now() - nativeStartedAt, 'partial');
                const matches = served.matches.slice(0, headLimit);
                if (matches.length > 0) {
                    const lines = [...matches];
                    lines.push(served.scanErrors > 0
                        ? `... [warning] ${served.scanErrors} path(s) could not be enumerated; partial results shown`
                            + (served.walkErrorDetails?.length ? `: ${served.walkErrorDetails.join('; ')}` : '')
                        : '... [search timed out; partial results shown — narrow path/query for a complete result]');
                    if (options?.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
                    return capFindResult(lines.join('\n'));
                }
                nativeEmptyPartial = served;
            } else {
                recordLocalSearchBackend('native_fuzzy', performance.now() - nativeStartedAt, 'miss');
                return capFindResult('Error: native fuzzy search returned an invalid response.');
            }
        } catch (error) {
            if (options.signal?.aborted) throw error;
            // Native fuzzy and broad enumeration use the same complete
            // inventory. Retrying the broad pass after a fuzzy timeout repeats
            // the same expensive walk and used to turn one Find call into two
            // consecutive timeouts that killed the shared search server.
            // A deadline that expires before ANY response is the same outcome
            // as the served-partial path below: the scope was too large to
            // rank inside the budget. Reporting it as a tool failure cost the
            // caller a whole turn for something that is a bounded, expected
            // answer, so it returns the empty partial plus the same recovery
            // guidance instead. Every other native error still surfaces.
            if (error?.code === 'NATIVE_SEARCH_TIMEOUT') {
                recordLocalSearchBackend('native_fuzzy', performance.now() - nativeStartedAt, 'partial');
                nativeEmptyPartial = {
                    matches: [],
                    partial: true,
                    timeout: true,
                    scanErrors: 0,
                    walkErrorDetails: [],
                };
            } else {
                recordLocalSearchBackend('native_fuzzy', performance.now() - nativeStartedAt, 'error');
                return capFindResult(`Error: ${normalizeErrorMessage(error instanceof Error ? error.message : String(error))}`);
            }
        }
    }
    if (nativeEmptyPartial) {
        if (options?.scopedCacheOutcome) markScopedCacheIncomplete(options.scopedCacheOutcome);
        const scanErrorNote = nativeEmptyPartial.scanErrors > 0
            ? `; ${nativeEmptyPartial.scanErrors} path(s) could not be enumerated`
                + (nativeEmptyPartial.walkErrorDetails?.length
                    ? `: ${nativeEmptyPartial.walkErrorDetails.join('; ')}`
                    : '')
            : '';
        return capFindResult([
            `(no fuzzy match yet for "${query}")`,
            `... [native inventory was incomplete${scanErrorNote}; retry immediately to reuse its short lease, or narrow path/query for a complete result]`,
        ].join('\n'));
    }
    return capFindResult('Error: native fuzzy search did not return a result.');
}

export async function executeFindFilesTool(args, workDir, options = {}) {
    args.path = coerceReadFamilyPathArg(args.path, workDir);
    args.path = normalizeInputPath(args.path);
    let inputPath = args.path || '.';
    let namePattern = typeof args.name === 'string' ? args.name : null;
    if (!namePattern && hasGlobMagic(inputPath)) {
        const { baseDir, relativePattern } = extractGlobBaseDirectory(inputPath);
        inputPath = baseDir || '.';
        namePattern = relativePattern.replace(/^\/+/, '');
    }
    if (namePattern) namePattern = normalizeInputPath(namePattern).replace(/^\/+/, '');
    const typeFilter = ['any', 'file', 'dir'].includes(args.type) ? args.type : 'any';
    const sortMode = ['name', 'size', 'mtime'].includes(args.sort) ? args.sort : 'mtime';
    const minSize = typeof args.min_size === 'number' && args.min_size > 0 ? args.min_size : null;
    const maxSize = typeof args.max_size === 'number' && args.max_size >= 0 ? args.max_size : null;
    const headLimit = normalizeListHeadLimit(args.head_limit, 100);
    const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
    const includeNoise = Boolean(args.include_noise);
    const hidden = Boolean(args.hidden);
    // Clamp depth to >=1 when caller passes it; null means unbounded (legacy
    // find-mode behavior). Forwarded to walkDir.maxDepth and the rg fast
    // path's --max-depth so both code paths honor the cap consistently.
    const depth = args.depth != null
        ? Math.max(parseInt(args.depth, 10) || 1, 1)
        : null;
    const _findGuard = listGuardPath(inputPath);
    if (_findGuard) return _findGuard;
    const fullPath = resolveAgainstCwd(inputPath, workDir);
    const _findGuardFull = listGuardPath(fullPath);
    if (_findGuardFull) return _findGuardFull;
    const cacheKey = buildListCacheKey({
        mode: 'find',
        inputPath: normalizeOutputPath(fullPath),
        depth: depth ?? '',
        hidden,
        sort: sortMode,
        typeFilter,
        headLimit,
        offset,
        namePattern,
        minSize,
        maxSize,
        modifiedAfter: args.modified_after || '',
        modifiedBefore: args.modified_before || '',
        includeNoise,
    });
    const cached = cacheGet(cacheKey);
    if (cached !== null) return cached;

    const parseTime = (v) => {
        if (typeof v !== 'string') return null;
        const m = v.match(/^(\d+)([hdm])$/);
        if (m) {
            const n = parseInt(m[1], 10);
            const unit = m[2] === 'h' ? 3600 * 1000
                       : m[2] === 'd' ? 86400 * 1000
                       : 60 * 1000;
            return Date.now() - n * unit;
        }
        const t = Date.parse(v);
        return isNaN(t) ? null : t;
    };
    const after = parseTime(args.modified_after);
    const before = parseTime(args.modified_before);
    // An unparseable date must FAIL, not silently disable the filter — a
    // caller who passed a filter believes the listing is filtered.
    if (args.modified_after && after === null) {
        return `Error: invalid modified_after ${JSON.stringify(args.modified_after)}; expected an ISO date/time or a relative window like 90m / 12h / 7d`;
    }
    if (args.modified_before && before === null) {
        return `Error: invalid modified_before ${JSON.stringify(args.modified_before)}; expected an ISO date/time or a relative window like 90m / 12h / 7d`;
    }

    // `name` is documented as a SUBSTRING filter (use glob mode for patterns).
    // Compile it as a glob ONLY when it actually contains glob metacharacters;
    // otherwise match by case-insensitive contains. The bug was that EVERY name
    // was glob-compiled, so a plain fragment like ".mjs" anchored-matched nothing.
    const nameIsGlob = Boolean(namePattern && /[*?\[\]{}]/.test(namePattern));
    let nameRegex = null, nameRootOptionalRegex = null;
    if (namePattern && nameIsGlob) {
        try {
            // compileSimpleGlob throws (R16 DoS caps: >256 brace variants /
            // oversized pattern/regex body) — convert to a tool-error string.
            nameRegex = compileSimpleGlob(namePattern);
            nameRootOptionalRegex = namePattern.startsWith('**/')
                ? compileSimpleGlob(namePattern.slice(3))
                : null;
        } catch (err) {
            return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
        }
    }
    const nameLower = namePattern ? namePattern.toLowerCase() : null;
    const namePatternHasPath = Boolean(namePattern && /[\\/]/.test(namePattern));
    const matchesFindNamePattern = (entName, entPath) => {
        if (!namePattern) return true;
        const subject = namePatternHasPath
            ? normalizeOutputPath(relative(fullPath, entPath))
            : entName;
        if (nameIsGlob) return nameRegex.test(subject) || Boolean(nameRootOptionalRegex?.test(subject));
        return subject.toLowerCase().includes(nameLower);
    };

    let _preStat;
    try { _preStat = await assertPathReachable(fullPath); }
    catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
    if (_preStat) statCacheSet(fullPath, _preStat);
    let rootStat;
    try {
        rootStat = _preStat || await stat(fullPath);
        if (!_preStat) statCacheSet(fullPath, rootStat);
    }
    catch (err) {
        return await readFamilyPathEnoentOrError(workDir, fullPath, inputPath, args, options, err, executeFindFilesTool);
    }
    if (!rootStat.isDirectory()) return `Error: not a directory — ${normalizeOutputPath(fullPath)}`;

    const matches = [];
    const FIND_ABSOLUTE_CAP = 50_000;
    let truncatedByCap = false;
    const inventoryArgs = ['--files', '--directories', '--no-ignore'];
    if (hidden) inventoryArgs.push('--hidden');
    if (depth != null) inventoryArgs.push('--max-depth', String(depth));
    if (!includeNoise) {
        for (const ex of DEFAULT_IGNORE_GLOBS) inventoryArgs.push('--glob', ex);
    }
    for (const ex of rootScanIgnoreGlobs(fullPath)) inventoryArgs.push('--glob', ex);
    if (namePattern) {
        inventoryArgs.push('--iglob', nameIsGlob ? namePattern : `*${namePattern}*`);
    }
    inventoryArgs.push('.');
    let relPaths;
    let walkIncomplete = false;
    let walkTimedOut = false;
    try {
        // runRg returns a plain string ONLY for a complete, cache-safe sweep;
        // a timed-out / truncated / non-cache-safe one comes back as a String
        // object carrying {partial,timeout,truncated,cacheSafe}. Discarding
        // that metadata cached a half-finished walk as authoritative, so one
        // slow enumeration became a persistent false negative.
        const inventory = await runRg(inventoryArgs, {
            cwd: fullPath,
            signal: options.signal,
            timeout: FIND_FILES_TIMEOUT_MS,
        });
        if (inventory && typeof inventory === 'object') {
            walkIncomplete = inventory.partial === true
                || inventory.truncated === true
                || inventory.cacheSafe === false;
            walkTimedOut = inventory.timeout === true;
        }
        relPaths = parseRgFileList(String(inventory));
    } catch (error) {
        const message = normalizeErrorMessage(error instanceof Error ? error.message : String(error));
        // The walk cap is the answer here, not a mystery failure: say which
        // scope blew it, and how to widen the cap when the scope is intended.
        if (/timed out/i.test(message)) {
            return `Error: file enumeration under ${normalizeOutputPath(fullPath)} exceeded the ${FIND_FILES_TIMEOUT_MS}ms walk cap; narrow the scope (path/name/depth), or raise MIXDOG_FIND_FILES_TIMEOUT_MS when the whole tree is required.`;
        }
        return `Error: ${message}`;
    }
    const candidates = [];
    for (const rel of relPaths) {
        if (!rel) continue;
        const candidate = resolveAgainstCwd(normalizeInputPath(rel), fullPath);
        if (!matchesFindNamePattern(basename(candidate), candidate)) continue;
        candidates.push(candidate);
        if (candidates.length >= FIND_ABSOLUTE_CAP) {
            truncatedByCap = true;
            break;
        }
    }
    const sizeFiltered = minSize !== null || maxSize !== null;
    const effectiveTypeFilter = sizeFiltered && typeFilter === 'any' ? 'file' : typeFilter;
    const withStat = await statPathsForMtime(candidates, workDir, 64, { deadlineMs: FIND_STAT_DEADLINE_MS });
    const filtersNeedStat = effectiveTypeFilter !== 'any'
        || minSize !== null || maxSize !== null || after !== null || before !== null;
    let unstatted = 0;
    for (let index = 0; index < withStat.length; index++) {
        const item = withStat[index];
        if (!item?.stat) {
            // A missed stat used to drop the path outright, so a time-bounded
            // metadata pass silently reported fewer matches than the walk found.
            // For a find the PATH is the answer; only an active size/type/date
            // filter may legitimately exclude one whose metadata is unknown.
            unstatted++;
            if (filtersNeedStat) continue;
            matches.push({ path: candidates[index], type: 'file', size: 0, mtimeMs: 0, unknownMeta: true });
            if (matches.length >= FIND_ABSOLUTE_CAP) {
                truncatedByCap = true;
                break;
            }
            continue;
        }
        const { stat, full: entPath, mtimeMs } = item;
        if (effectiveTypeFilter === 'file' && !stat.isFile()) continue;
        if (effectiveTypeFilter === 'dir' && !stat.isDirectory()) continue;
        if (stat.isFile()) {
            if (minSize !== null && stat.size < minSize) continue;
            if (maxSize !== null && stat.size > maxSize) continue;
        }
        if (after !== null && mtimeMs < after) continue;
        if (before !== null && mtimeMs > before) continue;
        matches.push({
            path: entPath,
            type: stat.isDirectory() ? 'dir' : 'file',
            size: stat.size,
            mtimeMs,
        });
        if (matches.length >= FIND_ABSOLUTE_CAP) {
            truncatedByCap = true;
            break;
        }
    }

    matches.sort((a, b) => {
        if (sortMode === 'name') return normalizeOutputPath(a.path).localeCompare(normalizeOutputPath(b.path));
        if (sortMode === 'size') return b.size - a.size;
        return b.mtimeMs - a.mtimeMs;
    });
    const windowed = offset > 0 ? matches.slice(offset) : matches;
    const sliced = headLimit > 0 ? windowed.slice(0, headLimit) : windowed;
    const lines = sliced.map(m => (m.unknownMeta
        ? `${displayRelPath(m.path, fullPath)}\t-\t-`
        : `${displayRelPath(m.path, fullPath)}\t${formatListSize(m.type, m.size)}\t${formatMtime(m.mtimeMs)}`));
    if (windowed.length > sliced.length) lines.push(`... [entries ${offset + 1}-${offset + sliced.length} of ${matches.length}; pass offset:${offset + sliced.length} to continue]`);
    if (truncatedByCap) lines.push(`... walk truncated at ${FIND_ABSOLUTE_CAP} matches; narrow the scope (path/name/modified_after) for accurate global sort`);
    if (walkIncomplete) {
        lines.push(`... walk INCOMPLETE (${walkTimedOut ? 'file enumeration timed out' : 'file enumeration returned partial results'}); matches are missing — narrow the scope (path/name/depth) and re-run`);
    }
    if (unstatted) {
        lines.push(`... ${unstatted} path(s) had no metadata within ${FIND_STAT_DEADLINE_MS}ms; `
            + (filtersNeedStat
                ? 'excluded because a size/type/date filter is active'
                : 'listed with "-" for size/date'));
    }
    const out = lines.join('\n') || '(no matches)';
    if (options?.scopedCacheOutcome && (truncatedByCap || walkIncomplete || unstatted || windowed.length > sliced.length)) {
        markScopedCacheIncomplete(options.scopedCacheOutcome);
    }
    // A bounded page is still an exact result because offset/limit are keyed
    // and watcher invalidation covers the scope. Only the absolute safety cap
    // or a known-incomplete walk makes the computation incomplete.
    if (!truncatedByCap && !walkIncomplete && !unstatted) {
        cacheSet(cacheKey, out, { scopes: [fullPath] });
    }
    return out;
}
