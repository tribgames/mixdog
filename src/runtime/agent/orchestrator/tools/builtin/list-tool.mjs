import { readdirSync } from 'fs';
import { basename, relative } from 'path';
import {
    extractGlobBaseDirectory,
    hasGlobMagic,
    normalizeInputPath,
    normalizeOutputPath,
    resolveAgainstCwd,
} from './path-utils.mjs';
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
} from './cache-layers.mjs';
import {
    compileSimpleGlob,
    NOISE_DIR_NAMES,
    walkDir,
} from './glob-walk.mjs';
import { formatMtime } from './list-formatting.mjs';
import { runRg } from './rg-runner.mjs';
import { fuzzyRank } from './fuzzy-match.mjs';
import { assertPathReachable } from './fs-reachability.mjs';

const FIND_WALK_TIMEOUT_MS = 20_000;
const LIST_WALK_TIMEOUT_MS = 20_000;
const LIST_ABSOLUTE_CAP = 50_000;

/** undefined / invalid / negative → defaultCap; 0 = no page cap (absolute caps still apply). */
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
    if (typeof args.fuzzy === 'string' && args.fuzzy.length > 0) {
        return executeFuzzyFind(args, workDir);
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
    catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
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
        `${normalizeOutputPath(r.path)}\t${r.type}\t${r.size}\t${formatMtime(r.mtimeMs)}`);
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
    catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
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
    const TREE_OUTPUT_CHAR_CAP = 50_000;
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

// Fuzzy filename search (codex file-search / nucleo style): collect the file
// list via `rg --files`, then rank by subsequence score. Lets a partial name
// like "edeng" surface "edit-engine.mjs" in one call instead of guessing an
// exact glob pattern. Honors path/hidden/include_noise/depth/head_limit.
async function executeFuzzyFind(args, workDir) {
    const query = String(args.fuzzy);
    const inputPath = normalizeInputPath(args.path) || '.';
    const guard = listGuardPath(inputPath);
    if (guard) return guard;
    const fullPath = resolveAgainstCwd(inputPath, workDir);
    const guardFull = listGuardPath(fullPath);
    if (guardFull) return guardFull;
    const hidden = Boolean(args.hidden);
    const includeNoise = Boolean(args.include_noise);
    // head_limit:0 means "no cap" per list semantics — keep 0 distinct from default.
    const headLimit = normalizeListHeadLimit(args.head_limit, 40);
    const depth = args.depth != null ? Math.max(parseInt(args.depth, 10) || 1, 1) : null;
    const rgArgs = ['--files', '--no-ignore'];
    if (hidden) rgArgs.push('--hidden');
    if (depth != null) rgArgs.push('--max-depth', String(depth));
    if (!includeNoise) {
        for (const ex of DEFAULT_IGNORE_GLOBS) rgArgs.push('--glob', ex);
    }
    rgArgs.push('.');
    let stdout;
    try {
        stdout = await runRg(rgArgs, { cwd: fullPath });
    } catch (err) {
        return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
    }
    const items = String(stdout)
        .split('\n')
        // Strip only the trailing CR from rg's line split — do NOT trim, or a
        // filename with leading/trailing spaces would be corrupted.
        .map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p))
        .filter((p) => p.length > 0)
        .map((p) => ({ path: normalizeOutputPath(p.replace(/^\.[/\\]/, '')) }));
    const ranked = fuzzyRank(query, items, headLimit);
    if (ranked.length === 0) return `(no fuzzy match for "${query}")`;
    const out = ranked.map((r) => r.item.path).join('\n');
    return headLimit > 0 && ranked.length >= headLimit
        ? `${out}\n... (top ${headLimit}; raise head_limit for more)`
        : out;
}

export async function executeFindFilesTool(args, workDir, options = {}) {
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
    catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
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
            const stdout = await runRg(rgArgs, { cwd: fullPath });
            rgStdoutTruncated = Boolean(stdout && typeof stdout === 'object' && stdout.truncated);
            rgStdoutPartial = Boolean(stdout && typeof stdout === 'object' && stdout.partial);
            const candidates = [];
            for (const line of String(stdout).split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const candidate = resolveAgainstCwd(normalizeInputPath(trimmed), fullPath);
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
        `${normalizeOutputPath(m.path)}\t${m.size}\t${formatMtime(m.mtimeMs)}`);
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
