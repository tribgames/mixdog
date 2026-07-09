import { readdirSync } from 'fs';
import { basename, relative } from 'path';
import {
    coerceReadFamilyPathArg,
    extractGlobBaseDirectory,
    hasGlobMagic,
    normalizeInputPath,
    normalizeOutputPath,
    resolveAgainstCwd,
} from './path-utils.mjs';
import { buildNotFoundHint, finalizeReadFamilyEnoentTail, tryReadFamilyEnoentRedirect } from './search-path-diagnostics.mjs';
import { normalizeErrorMessage } from './path-diagnostics.mjs';
import { isUncPath, isWindowsDevicePath, hasUnsafeWin32Component } from './device-paths.mjs';
import {
    buildListCacheKey,
    DEFAULT_IGNORE_GLOBS,
} from './search-builders.mjs';
import { markScopedCacheIncomplete } from '../../session/cache/scoped-cache-outcome.mjs';
import {
    cacheGet,
    cacheSet,
    getCachedReadOnlyStat,
    statPathsForMtime,
    lstatPathsForMtime,
    registerCacheInvalidationListener,
} from './cache-layers.mjs';
import {
    compileSimpleGlob,
    NOISE_DIR_NAMES,
    walkDir,
} from './glob-walk.mjs';
import { formatMtime, formatListSize } from './list-formatting.mjs';
import { TOOL_OUTPUT_MAX_BYTES } from './tool-output-limit.mjs';
import { runRg } from './rg-runner.mjs';
import { hasSpareCapacity as childSpawnHasSpareCapacity } from '../../../../shared/child-spawn-gate.mjs';
import { fuzzyRank } from './fuzzy-match.mjs';
import { assertPathReachable } from './fs-reachability.mjs';

const FIND_WALK_TIMEOUT_MS = 20_000;
const LIST_WALK_TIMEOUT_MS = 20_000;
const LIST_ABSOLUTE_CAP = 50_000;

/** undefined / invalid / negative → defaultCap; 0 = no page cap (absolute caps still apply). */
async function readFamilyPathEnoentOrError(workDir, fullPath, inputPath, args, options, err, rerunTool) {
    const redirected = await tryReadFamilyEnoentRedirect({
        workDir,
        resolvedPath: fullPath,
        requestedPath: inputPath,
        errCode: err?.code,
        options,
        rerun: (target, opts) => rerunTool({ ...args, path: target }, workDir, opts),
    });
    if (redirected) return redirected;
    const msg = `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
    const hint = buildNotFoundHint(workDir, fullPath, 'List', err?.code);
    return msg + finalizeReadFamilyEnoentTail(hint, inputPath, err?.code);
}

function normalizeListHeadLimit(raw, defaultCap) {
    if (raw === undefined || raw === null || raw === '') return defaultCap;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return defaultCap;
    return Math.floor(n);
}

// UNC / Windows-device / NTFS-ADS guard for directory-walking modes
// (list / tree / find). Walking a UNC share auto-authenticates to the
// remote host (NTLM hash leak); a raw-device / reserved-name path can
// hang or grant raw access. Mirrors the read path's string-based checks.
// Returns an Error string when the path is blocked, else null.
function listGuardPath(p) {
    if (typeof isUncPath === 'function' && isUncPath(p))
        return `Error: cannot walk UNC / SMB path (network credential leak risk): ${normalizeOutputPath(p)}`;
    if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(p))
        return `Error: cannot walk Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(p)}`;
    if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(p))
        return `Error: cannot walk Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(p)}`;
    return null;
}

export async function executeListTool(args, workDir, options = {}) {
    args.path = coerceReadFamilyPathArg(args.path, workDir);
    if (Array.isArray(args.path)) {
        const list = [...new Set(args.path.map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p.length > 0))];
        const capped = list.length > 10;
        const targets = capped ? list.slice(0, 10) : list;
        if (targets.length > 1) {
            // Bounded parallel fan-out: each target is an independent listing
            // (own guard/cache/reachability), so run them concurrently instead
            // of serially. Bodies land in a fixed-index array so the emitted
            // section order still matches the caller's `path[]` order — only the
            // wall-clock cost changes. Concurrency is capped so a 10-path batch
            // cannot exhaust the child-spawn / FS-handle budget.
            const LIST_FANOUT_CONCURRENCY = 4;
            const bodies = new Array(targets.length);
            let cursor = 0;
            const runWorker = async () => {
                for (;;) {
                    const i = cursor++;
                    if (i >= targets.length) return;
                    try {
                        bodies[i] = await executeListTool({ ...args, path: targets[i] }, workDir, options);
                    } catch (err) {
                        bodies[i] = `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
                    }
                }
            };
            await Promise.all(
                Array.from({ length: Math.min(LIST_FANOUT_CONCURRENCY, targets.length) }, runWorker),
            );
            const sections = targets.map((p, i) => `# list ${p}\n${bodies[i]}`);
            if (capped) sections.push(`... [capped at 10 of ${list.length} paths]`);
            return sections.join('\n\n');
        }
        args.path = targets[0];
    }
    if (typeof args.fuzzy === 'string' && args.fuzzy.length > 0) {
        return executeFuzzyFindTool({ ...args, query: args.fuzzy }, workDir, options);
    }
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
    const headLimit = normalizeListHeadLimit(args.head_limit, 200);
    const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
    const needsGlobalStat = sort === 'mtime' || sort === 'size';
    const includeNoise = Boolean(args.include_noise);
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
    });
    const cached = cacheGet(cacheKey);
    if (cached !== null) return cached;
    try { await assertPathReachable(fullPath); }
    catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
    let st;
    try { st = getCachedReadOnlyStat(fullPath); }
    catch (err) {
        return await readFamilyPathEnoentOrError(workDir, fullPath, inputPath, args, options, err, executeListTool);
    }
    if (!st.isDirectory()) return `Error: not a directory — ${normalizeOutputPath(fullPath)}`;

    const rows = [];
    // Width guard: depth is capped above, but a single very wide directory
    // tree could push unbounded rows before sort/slice runs and exhaust
    // memory. Mirror the find-mode FIND_ABSOLUTE_CAP + walk deadline so the
    // accumulator stops growing once the cap or timeout trips. Small dirs
    // never hit either bound, so normal behavior is unchanged.
    let truncatedByCap = false;
    const walkDeadline = Date.now() + LIST_WALK_TIMEOUT_MS;
    await walkDir(fullPath, {
        hidden,
        maxDepth: depth,
        excludeDirNames: includeNoise ? null : NOISE_DIR_NAMES,
        signal: options.signal,
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

    if (needsGlobalStat && rows.length > 0) {
        // lstat: symlinks should report own metadata, not the target's.
        const stats = await lstatPathsForMtime(rows.map((row) => row.fullPath), workDir, 64, { deadlineMs: 5000 });
        for (let i = 0; i < rows.length; i++) {
            const item = stats[i];
            if (!item?.stat) continue;
            rows[i].size = item.size;
            rows[i].mtimeMs = item.mtimeMs;
        }
    }

    if (sort === 'mtime') rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
    else if (sort === 'size') rows.sort((a, b) => b.size - a.size);
    else rows.sort((a, b) => a.path.localeCompare(b.path));

    const windowed = offset > 0 ? rows.slice(offset) : rows;
    const sliced = headLimit > 0 ? windowed.slice(0, headLimit) : windowed;
    if (!needsGlobalStat && sliced.length > 0) {
        // Use lstat so a symlink reports its own size/mtime instead of
        // the target's. The walker already typed symlinks from Dirent;
        // following the link here would lie about the listed entry.
        const stats = await lstatPathsForMtime(sliced.map((row) => row.fullPath), workDir, 64, { deadlineMs: 5000 });
        for (let i = 0; i < sliced.length; i++) {
            const item = stats[i];
            if (!item?.stat) continue;
            sliced[i].size = item.size;
            sliced[i].mtimeMs = item.mtimeMs;
        }
    }
    const lines = sliced.map(r =>
        `${normalizeOutputPath(r.path)}\t${r.type}\t${formatListSize(r.type, r.size)}\t${formatMtime(r.mtimeMs)}`);
    if (windowed.length > sliced.length) lines.push(`... [entries ${offset + 1}-${offset + sliced.length} of ${rows.length}; pass offset:${offset + sliced.length} to continue]`);
    if (truncatedByCap) lines.push(`... walk truncated at ${LIST_ABSOLUTE_CAP} rows or ${LIST_WALK_TIMEOUT_MS}ms timeout; narrow the path or lower depth for a complete listing`);
    let emptyMsg = '(empty directory)';
    if (lines.length === 0 && (typeFilter !== 'any' || hidden === false)) {
        const filterParts = [];
        if (typeFilter !== 'any') filterParts.push(`type=${typeFilter}`);
        if (hidden === false) {
            let hasHidden = false;
            try {
                const entries = readdirSync(fullPath, { withFileTypes: true });
                hasHidden = entries.some(e => e.name && e.name.startsWith('.'));
            } catch {}
            if (hasHidden) filterParts.push(`hidden=false (dotfiles present — pass hidden:true to include)`);
            else filterParts.push(`hidden=false`);
        }
        emptyMsg = `(no entries match filter) ${filterParts.join(', ')} path=${inputPath}`;
    }
    const out = lines.join('\n') || emptyMsg;
    if (options?.scopedCacheOutcome && (truncatedByCap || windowed.length > sliced.length)) {
        markScopedCacheIncomplete(options.scopedCacheOutcome);
    }
    cacheSet(cacheKey, out, { scopes: [fullPath] });
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
    const headLimit = normalizeListHeadLimit(args.head_limit, 200);
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
    try { await assertPathReachable(fullPath); }
    catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
    let st;
    try { st = getCachedReadOnlyStat(fullPath); }
    catch (err) {
        return await readFamilyPathEnoentOrError(workDir, fullPath, inputPath, args, options, err, executeListTool);
    }
    if (!st.isDirectory()) return `Error: not a directory — ${normalizeOutputPath(fullPath)}`;
    const lines = [`${normalizeOutputPath(fullPath)}/`];
    const prefixStack = [''];
    const TREE_BRANCH_LINE_CAP = 500;
    await walkDir(fullPath, {
        hidden,
        maxDepth: depth,
        excludeDirNames: includeNoise ? null : NOISE_DIR_NAMES,
        signal: options.signal,
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
    const TREE_OUTPUT_CHAR_CAP = TOOL_OUTPUT_MAX_BYTES;
    let out = outLines.join('\n');
    let outputCharTruncated = false;
    if (out.length > TREE_OUTPUT_CHAR_CAP) {
        outputCharTruncated = true;
        out = out.slice(0, TREE_OUTPUT_CHAR_CAP) + `\n... [output truncated at ${Math.round(TREE_OUTPUT_CHAR_CAP/1024)} KB; narrow path or lower depth]`;
    }
    if (options?.scopedCacheOutcome && (windowed.length > sliced.length || outputCharTruncated)) {
        markScopedCacheIncomplete(options.scopedCacheOutcome);
    }
    cacheSet(cacheKey, out, { scopes: [fullPath] });
    return out;
}

// ── Broad-enumeration cache (shared `rg --files` sweep) ──────────────────
// A `rg --files` sweep of a root depends ONLY on (root, hidden, depth,
// includeNoise) — NOT on the per-query narrowing. Yet both the fuzzy-find
// broad pass and the find_files broad fast path re-run that full sweep for
// every query item AND for every concurrent caller (measured 1-4s each when
// 8 explorer sub-sessions hit the same root). Cache the PARSED file list per
// key with in-flight promise dedup (N concurrent callers share ONE sweep)
// plus a short TTL for serial reuse. Truncated/partial sweeps are
// known-incomplete and are NEVER cached.
const FIND_ENUM_CACHE = new Map(); // key -> { files, expiresAt, gen }
const FIND_ENUM_INFLIGHT = new Map(); // key -> Promise<{files,truncated,partial}>
let FIND_ENUM_GEN = 0;

// The broad enumeration is a DERIVED cache the scope/path invalidation layer
// does not otherwise know about — a file created/renamed after a sweep would
// stay invisible to broad find reuse for the whole TTL. Drop all entries on any
// write-invalidation event (TTL remains the secondary bound). Full clear is
// fine: entries are cheap to rebuild.
registerCacheInvalidationListener(() => {
    FIND_ENUM_GEN += 1;
    FIND_ENUM_CACHE.clear();
    FIND_ENUM_INFLIGHT.clear();
});

function findEnumTtlMs() {
    const raw = process.env.MIXDOG_FIND_ENUM_CACHE_TTL_MS;
    if (raw == null || raw === '') return 30000;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 30000; // malformed → default
    return Math.floor(n); // 0 = disabled
}

function findEnumKey({ root, hidden, depth, includeNoise }) {
    return `${root}\u0000${hidden ? 1 : 0}\u0000${depth ?? ''}\u0000${includeNoise ? 1 : 0}`;
}

// Parse `rg --files` stdout into the same normalized relative-path list both
// broad passes build (strip trailing CR, drop empties, strip leading `./`,
// forward-slash). Module-level so the cache and both call sites agree.
function parseRgFileList(stdout) {
    return String(stdout)
        .split('\n')
        .map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p))
        .filter((p) => p.length > 0)
        .map((p) => normalizeOutputPath(p.replace(/^\.[/\\]/, '')));
}

// Run (or reuse) the broad `rg --files` sweep for a root. Returns
// { files, truncated, partial }. The returned `files` array is SHARED — callers
// must treat it as read-only. `rgArgs` must be the broad-pass args (no per-query
// narrowing); the cache key is the 4 dims only, so any caller producing an
// equivalent sweep for the same dims reuses the result.
async function getBroadEnumeration({ root, hidden, depth, includeNoise, rgArgs, cwd, runRgImpl = runRg, bestEffort = false }) {
    const ttl = findEnumTtlMs();
    const key = findEnumKey({ root, hidden, depth, includeNoise });
    if (ttl > 0) {
        const hit = FIND_ENUM_CACHE.get(key);
        if (hit && hit.gen === FIND_ENUM_GEN && hit.expiresAt > Date.now()) {
            return { files: hit.files, truncated: false, partial: false };
        }
        if (hit) FIND_ENUM_CACHE.delete(key); // expired
    }
    // Single-flight is independent of the persistent TTL cache. Even when
    // MIXDOG_FIND_ENUM_CACHE_TTL_MS=0 disables reuse across calls, concurrent
    // query[] fan-out should still share the one broad `rg --files` sweep
    // instead of spawning N identical enumerations.
    const inflight = FIND_ENUM_INFLIGHT.get(key);
    if (inflight) return inflight;
    // Non-competing prewarm: past the cache/single-flight fast paths this runs
    // a fresh `rg` sweep (a child-spawn slot). Best-effort warmers skip that
    // spawn when the gate has no spare capacity, returning a known-incomplete
    // result — and skipping BEFORE registering FIND_ENUM_INFLIGHT so a real
    // caller is never attached to (or cache-poisoned by) a skipped warm.
    if (bestEffort && !childSpawnHasSpareCapacity()) {
        return { files: [], truncated: false, partial: true };
    }
    const genAtStart = FIND_ENUM_GEN;
    const run = (async () => {
        const stdout = await runRgImpl(rgArgs, { cwd });
        const truncated = Boolean(stdout && typeof stdout === 'object' && stdout.truncated);
        const partial = Boolean(stdout && typeof stdout === 'object' && stdout.partial);
        const files = parseRgFileList(stdout);
        // Never cache a truncated/partial sweep — it is known-incomplete, so a
        // later query with a larger head_limit must re-run the enumeration.
        // Also never let an in-flight prewarm/real sweep repopulate after a
        // write invalidation cleared the cache during the sweep.
        if (ttl > 0 && !truncated && !partial && FIND_ENUM_GEN === genAtStart) {
            FIND_ENUM_CACHE.set(key, { files, expiresAt: Date.now() + ttl, gen: genAtStart });
        }
        return { files, truncated, partial };
    })();
    FIND_ENUM_INFLIGHT.set(key, run);
    try { return await run; }
    finally {
        if (FIND_ENUM_INFLIGHT.get(key) === run) FIND_ENUM_INFLIGHT.delete(key);
    }
}

// Best-effort warm of the broad enumeration for a root using the `find` tool's
// DEFAULT flags (hidden:true, includeNoise:false, depth:unbounded). Swallows
// all errors — a failed prewarm must never surface or block the caller.
export async function prewarmFindEnumeration(root) {
    try {
        if (!root || typeof root !== 'string') return;
        const hidden = true, includeNoise = false, depth = null;
        const rgArgs = ['--files', '--no-ignore', '--hidden'];
        for (const ex of DEFAULT_IGNORE_GLOBS) rgArgs.push('--glob', ex);
        rgArgs.push('.');
        await getBroadEnumeration({
            root: normalizeOutputPath(root),
            hidden, depth, includeNoise,
            rgArgs, cwd: root, bestEffort: true,
        });
    } catch { /* best-effort warm; never surface */ }
}

 // Fuzzy filename search (nucleo-style): collect the file
// list via `rg --files`, then rank by subsequence score. `list.fuzzy` still
// routes here for hidden backward compatibility, but the model-facing tool is
// `find`.
export async function executeFuzzyFindTool(args, workDir, options = {}) {
    if (Array.isArray(args.query)) {
        const list = [...new Set(args.query.map((q) => (typeof q === 'string' ? q.trim() : '')).filter((q) => q.length > 0))];
        const capped = list.length > 5;
        const targets = capped ? list.slice(0, 5) : list;
        if (targets.length > 1) {
            // Bounded parallel fan-out: every query shares ONE broad `rg --files`
            // sweep via the enumeration cache's in-flight single-flight dedup, so
            // running them concurrently collapses N broad sweeps into one and
            // overlaps the tiny per-query narrowed passes. Bodies land at a fixed
            // index so the emitted section order still matches the caller's
            // query[] order — only wall-clock cost changes. Concurrency is capped
            // so a 5-query batch cannot exhaust the child-spawn budget.
            const FIND_FANOUT_CONCURRENCY = 4;
            const bodies = new Array(targets.length);
            let cursor = 0;
            const runWorker = async () => {
                for (;;) {
                    const i = cursor++;
                    if (i >= targets.length) return;
                    try {
                        bodies[i] = await executeFuzzyFindTool({ ...args, query: targets[i] }, workDir, options);
                    } catch (err) {
                        bodies[i] = `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
                    }
                }
            };
            await Promise.all(
                Array.from({ length: Math.min(FIND_FANOUT_CONCURRENCY, targets.length) }, runWorker),
            );
            const sections = targets.map((q, i) => `# find ${q}\n${bodies[i]}`);
            if (capped) sections.push(`... [capped at 5 of ${list.length} queries]`);
            return sections.join('\n\n');
        }
        args.query = targets[0];
    }
    const query = String(args.query ?? args.fuzzy ?? '').trim();
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
    const headLimit = normalizeListHeadLimit(args.head_limit, 25);
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
    if (cached !== null) return cached;
    // --no-ignore: match the find_files fast path contract — do not consult
    // .gitignore, so a .gitignored-but-present file is still discoverable.
    // Noise dirs stay excluded via DEFAULT_IGNORE_GLOBS below.
    // Shared rg flags for both enumeration passes below.
    const baseRgArgs = ['--files', '--no-ignore'];
    if (hidden) baseRgArgs.push('--hidden');
    if (depth != null) baseRgArgs.push('--max-depth', String(depth));
    // Noise-exclusion globs are kept SEPARATE and always appended LAST (after
    // any positive --iglob). ripgrep's "last matching glob wins" rule means a
    // positive include placed after these negations would re-admit e.g.
    // `.git/<query>` — so the exclusions must trail the narrowed include.
    const ignoreGlobs = [];
    if (!includeNoise) {
        for (const ex of DEFAULT_IGNORE_GLOBS) ignoreGlobs.push('--glob', ex);
    }
    // The narrowed pass must treat `query` as a LITERAL filename substring, not
    // a glob. Wrap every globset metacharacter in a single-char character class
    // (`[` → `[[]`, `*` → `[*]`, …): character-class quoting is the only form
    // globset honors on Windows, where a backslash-escape (`\*`) is read as a
    // literal path separator and does NOT escape. So a query like "[slug].tsx"
    // still produces the intended `*[[]slug[]].tsx*` include instead of a
    // character-class that matches one of s/l/u/g.
    const escapeGlobLiteral = (s) => s.replace(/[*?[\]{}]/g, (c) => `[${c}]`);
    // Test-only seam: allow a caller to inject a runRg stand-in (e.g. to
    // simulate a truncated broad pass) without touching the production path.
    // Never set on the real tool-execution options object.
    const runRgImpl = (options && typeof options.__runRg === 'function') ? options.__runRg : runRg;
    const parseRgFiles = (stdout) => String(stdout)
        .split('\n')
        // Strip only the trailing CR from rg's line split — do NOT trim, or a
        // filename with leading/trailing spaces would be corrupted.
        .map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p))
        .filter((p) => p.length > 0)
        .map((p) => normalizeOutputPath(p.replace(/^\.[/\\]/, '')));
    // Broad enumeration: every file under the scope, ranked by fuzzy score.
    // Subject to rg's 20MB/20s cap — an exact-name hit deep in a huge tree can
    // be dropped by cap lottery, so it is backstopped by the narrowed pass.
    // Shared across queries/concurrent callers via the broad-enumeration cache
    // (keyed on root+hidden+depth+includeNoise, i.e. exactly this pass's args).
    let broadEnum;
    try {
        broadEnum = await getBroadEnumeration({
            root: normalizeOutputPath(fullPath),
            hidden, depth, includeNoise,
            rgArgs: [...baseRgArgs, ...ignoreGlobs, '.'],
            cwd: fullPath,
            runRgImpl,
        });
    } catch (err) {
        return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
    }
    const rgTruncated = broadEnum.truncated;
    const rgPartial = broadEnum.partial;
    // Narrowed enumeration: only files whose NAME contains the query
    // (case-insensitive substring glob). This output is tiny and effectively
    // never truncated, so exact/substring hits are guaranteed to reach ranking
    // regardless of whether the broad pass was cut at the cap. Best-effort:
    // failures here never fail the tool — the broad pass still stands.
    let narrowPaths = [];
    try {
        // A positive --iglob whitelist makes ripgrep re-admit paths its own
        // `!**/<noise>/**` negations would otherwise exclude (the whitelist
        // wins regardless of glob order), so noise dirs are pruned in JS here
        // instead — matching the broad pass's effective exclusion set.
        const narrowStdout = await runRgImpl([...baseRgArgs, '--iglob', `*${escapeGlobLiteral(query)}*`, '.'], { cwd: fullPath });
        narrowPaths = parseRgFiles(narrowStdout).filter((p) =>
            includeNoise || !p.split('/').some((seg) => NOISE_DIR_NAMES.has(seg)));
    } catch { /* best-effort backstop; broad pass already collected */ }
    // Merge broad + narrowed, deduplicating by path (broad order preserved,
    // narrowed-only exact-name candidates appended).
    const seen = new Set();
    const items = [];
    for (const p of broadEnum.files) {
        if (seen.has(p)) continue;
        seen.add(p);
        items.push({ path: p });
    }
    for (const p of narrowPaths) {
        if (seen.has(p)) continue;
        seen.add(p);
        items.push({ path: p });
    }
    const rankLimit = headLimit > 0 ? headLimit + 1 : headLimit;
    const rankedRaw = fuzzyRank(query, items, rankLimit);
    const hasMore = headLimit > 0 && rankedRaw.length > headLimit;
    const ranked = hasMore ? rankedRaw.slice(0, headLimit) : rankedRaw;
    // Build output lines uniformly for the hit and no-match cases so a
    // truncated/partial broad pass ALWAYS surfaces its warning — otherwise a
    // cut-off enumeration that happened to drop the sole match would silently
    // report "(no fuzzy match …)" as if the tree were exhaustively searched.
    const noMatch = ranked.length === 0;
    const lines = noMatch ? [`(no fuzzy match for "${query}")`] : ranked.map((r) => r.item.path);
    if (!noMatch && hasMore) lines.push(`... (top ${headLimit}; raise head_limit for more)`);
    if (rgTruncated) lines.push('... [warning] rg stdout truncated at 20MB cap; broad ranking incomplete (exact-name hits still merged)');
    if (rgPartial && !rgTruncated) lines.push('... [warning] rg exit 2 (partial results); broad ranking may be incomplete');
    const result = lines.join('\n');
    // Do not cache a truncated/partial enumeration — the broad ranking is
    // known-incomplete, so a later call with a larger head_limit must re-run.
    // A no-match result is also left uncached (mirrors the prior early return).
    if (!noMatch && !rgTruncated && !rgPartial) {
        cacheSet(cacheKey, result, { scopes: [fullPath] });
    }
    if (typeof options?.onProgress === 'function') {
        try { options.onProgress(`${ranked.length} candidates`); } catch { /* best-effort */ }
    }
    return result;
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

    try { await assertPathReachable(fullPath); }
    catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
    let rootStat;
    try { rootStat = getCachedReadOnlyStat(fullPath); }
    catch (err) {
        return await readFamilyPathEnoentOrError(workDir, fullPath, inputPath, args, options, err, executeFindFilesTool);
    }
    if (!rootStat.isDirectory()) return `Error: not a directory — ${normalizeOutputPath(fullPath)}`;

    const matches = [];
    const FIND_ABSOLUTE_CAP = 50_000;
    let truncatedByCap = false;
    let rgStdoutTruncated = false;
    let rgStdoutPartial = false;
    const useBatchedStat = minSize === null && maxSize === null && after === null && before === null;
    let handledByRgFiles = false;
    if (useBatchedStat && typeFilter === 'file') {
        try {
            // --no-ignore: do not consult .gitignore. The slow walk path
            // never honours .gitignore, so the fast path must match that
            // contract — otherwise the rg branch silently returns fewer
            // results than the fallback. Noise dirs are still excluded
            // via DEFAULT_IGNORE_GLOBS below (unless include_noise).
            const rgArgs = ['--files', '--no-ignore'];
            if (hidden) rgArgs.push('--hidden');
            if (depth != null) rgArgs.push('--max-depth', String(depth));
            if (!includeNoise) {
                for (const ex of DEFAULT_IGNORE_GLOBS) rgArgs.push('--glob', ex);
            }
            // Substring `name` (no glob metachars) → contains-glob so rg's
            // pre-filter matches the JS matcher; explicit globs pass through.
            if (namePattern) rgArgs.push('--iglob', nameIsGlob ? namePattern : `*${namePattern}*`);
            rgArgs.push('.');
            // No `name` filter → this is the pure broad sweep (rgArgs match the
            // fuzzy-find broad pass), so share it via the enumeration cache.
            // With a `name` filter the sweep is narrowed by --iglob and must
            // NOT hit the broad cache — run it directly.
            let relPaths;
            if (!namePattern) {
                const enumRes = await getBroadEnumeration({
                    root: normalizeOutputPath(fullPath),
                    hidden, depth, includeNoise,
                    rgArgs, cwd: fullPath,
                });
                rgStdoutTruncated = enumRes.truncated;
                rgStdoutPartial = enumRes.partial;
                relPaths = enumRes.files;
            } else {
                const stdout = await runRg(rgArgs, { cwd: fullPath });
                rgStdoutTruncated = Boolean(stdout && typeof stdout === 'object' && stdout.truncated);
                rgStdoutPartial = Boolean(stdout && typeof stdout === 'object' && stdout.partial);
                relPaths = parseRgFileList(stdout);
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
            const withStat = await statPathsForMtime(candidates, workDir, 64, { deadlineMs: 5000 });
            for (const item of withStat) {
                if (!item?.stat) continue;
                matches.push({ path: item.full, size: item.size, mtimeMs: item.mtimeMs });
            }
            handledByRgFiles = true;
        } catch {
            handledByRgFiles = false;
        }
    }
    if (!handledByRgFiles && useBatchedStat) {
        const candidates = [];
        const walkDeadline1 = Date.now() + FIND_WALK_TIMEOUT_MS;
        await walkDir(fullPath, {
            hidden,
            maxDepth: depth ?? Infinity,
            excludeDirNames: includeNoise ? null : NOISE_DIR_NAMES,
            signal: options.signal,
            visit: (ent, entPath) => {
                if (Date.now() > walkDeadline1) { truncatedByCap = true; return false; }
                const isDir = ent.isDirectory();
                const isFile = ent.isFile();
                if (typeFilter === 'file' && !isFile) return;
                if (typeFilter === 'dir' && !isDir) return;
                if (!matchesFindNamePattern(ent.name, entPath)) return;
                candidates.push(entPath);
                if (candidates.length >= FIND_ABSOLUTE_CAP) {
                    truncatedByCap = true;
                    return false;
                }
            },
        });
        const withStat = await statPathsForMtime(candidates, workDir, 64, { deadlineMs: 5000 });
        for (const item of withStat) {
            if (!item?.stat) continue;
            matches.push({ path: item.full, size: item.size, mtimeMs: item.mtimeMs });
        }
    } else if (!handledByRgFiles) {
        // Size filters only have meaning for files; when the caller passed
        // min_size/max_size without also restricting type, narrow the
        // result set to files so directories don't slip past with their
        // (usually 0-byte) directory size.
        const sizeFiltered = (minSize !== null || maxSize !== null);
        const effectiveTypeFilter = sizeFiltered && typeFilter === 'any' ? 'file' : typeFilter;
        const candidates = [];
        const walkDeadline2 = Date.now() + FIND_WALK_TIMEOUT_MS;
        await walkDir(fullPath, {
            hidden,
            maxDepth: depth ?? Infinity,
            excludeDirNames: includeNoise ? null : NOISE_DIR_NAMES,
            signal: options.signal,
            visit: (ent, entPath) => {
                if (Date.now() > walkDeadline2) { truncatedByCap = true; return false; }
                const isDir = ent.isDirectory();
                const isFile = ent.isFile();
                if (effectiveTypeFilter === 'file' && !isFile) return;
                if (effectiveTypeFilter === 'dir' && !isDir) return;
                if (!matchesFindNamePattern(ent.name, entPath)) return;
                candidates.push(entPath);
                if (candidates.length >= FIND_ABSOLUTE_CAP) {
                    truncatedByCap = true;
                    return false;
                }
            },
        });
        const withStat = await statPathsForMtime(candidates, workDir, 64, { deadlineMs: 5000 });
        for (const item of withStat) {
            if (!item?.stat) continue;
            const { stat, full: entPath, mtimeMs } = item;
            if (stat.isFile()) {
                if (minSize !== null && stat.size < minSize) continue;
                if (maxSize !== null && stat.size > maxSize) continue;
            }
            if (after !== null && mtimeMs < after) continue;
            if (before !== null && mtimeMs > before) continue;
            matches.push({ path: entPath, size: stat.size, mtimeMs });
            if (matches.length >= FIND_ABSOLUTE_CAP) {
                truncatedByCap = true;
                break;
            }
        }
    }

    matches.sort((a, b) => {
        if (sortMode === 'name') return normalizeOutputPath(a.path).localeCompare(normalizeOutputPath(b.path));
        if (sortMode === 'size') return b.size - a.size;
        return b.mtimeMs - a.mtimeMs;
    });
    const windowed = offset > 0 ? matches.slice(offset) : matches;
    const sliced = headLimit > 0 ? windowed.slice(0, headLimit) : windowed;
    const lines = sliced.map(m =>
        `${normalizeOutputPath(m.path)}\t${formatListSize('file', m.size)}\t${formatMtime(m.mtimeMs)}`);
    if (windowed.length > sliced.length) lines.push(`... [entries ${offset + 1}-${offset + sliced.length} of ${matches.length}; pass offset:${offset + sliced.length} to continue]`);
    if (rgStdoutTruncated) lines.push('... [warning] rg stdout truncated at 20MB cap; results incomplete');
    if (rgStdoutPartial) lines.push('... [warning] rg exit 2 (partial results); listing may be incomplete');
    if (truncatedByCap) lines.push(`... walk truncated at ${FIND_ABSOLUTE_CAP} matches; narrow the scope (path/name/modified_after) for accurate global sort`);
    const out = lines.join('\n') || '(no matches)';
    if (options?.scopedCacheOutcome && (truncatedByCap || rgStdoutTruncated || rgStdoutPartial || windowed.length > sliced.length)) {
        markScopedCacheIncomplete(options.scopedCacheOutcome);
    }
    const findIncomplete = truncatedByCap || rgStdoutTruncated || rgStdoutPartial || windowed.length > sliced.length;
    if (!findIncomplete) {
        cacheSet(cacheKey, out, { scopes: [fullPath] });
    }
    return out;
}
