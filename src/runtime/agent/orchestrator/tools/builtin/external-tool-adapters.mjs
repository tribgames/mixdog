// Native adapters for well-known tool names from OTHER agent CLIs whose
// argument shapes differ from any mixdog builtin (StrReplace/Write/bash
// variants). Executed directly against the filesystem via atomicWrite / the
// existing shell runner — NOT by synthesizing an apply_patch V4A string
// (that approach was tried and abandoned: building a correct V4A envelope
// from arbitrary old_string/new_string/contents blew up in edge-case
// complexity for no benefit over a direct fs edit).
//
// Contract: tryExecuteExternalToolAdapter(name, args, workDir, options)
// returns a result STRING when the call was handled (success or a concrete
// tool-level error), or `null` when the args shape didn't match what the
// adapter expects — the caller (builtin.mjs default: case) falls back to
// the existing EXTERNAL_TOOL_REDIRECTS guidance message in that case.
import { readFileSync, mkdirSync, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { atomicWrite } from './atomic-write.mjs';
import { assertPathsReachable } from './fs-reachability.mjs';
import { normalizeInputPath, resolveAgainstCwd, normalizeOutputPath } from './path-utils.mjs';
import { isUncPath, isWindowsDevicePath, hasUnsafeWin32Component, isBlockedDevicePath, isSpecialFileStat } from './device-paths.mjs';
import { executeBashTool } from './bash-tool.mjs';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';
import { markCodeGraphDirtyPaths } from '../code-graph-state.mjs';

const STR_REPLACE_NAMES = new Set(['strreplace', 'str_replace', 'str_replace_editor', 'search_replace']);
const WRITE_NAMES = new Set(['write', 'create_file', 'createfile']);
// 'bash'/'Bash' explicitly request the posix/git-bash shell kind; the
// run/runcommand/terminal/run_terminal_cmd family leaves `shell` unset so
// executeBashTool's own default-shell resolution applies (mirrors how the
// native `shell` tool behaves when the caller omits `shell`).
const BASH_SHELL_KIND_NAMES = new Set(['bash']);
const BASH_DEFAULT_NAMES = new Set(['run', 'runcommand', 'terminal', 'run_terminal_cmd']);

/**
 * True when `name` is a foreign-CLI tool this module can adapt natively.
 * Used by the session loop's dispatch so these names route INTO
 * executeBuiltinTool (whose default: case invokes the adapter) instead of
 * short-circuiting to the unknown-tool redirect message.
 */
export function isExternalAdapterTool(name) {
    if (typeof name !== 'string' || !name) return false;
    const key = name.toLowerCase();
    return STR_REPLACE_NAMES.has(key) || WRITE_NAMES.has(key)
        || BASH_SHELL_KIND_NAMES.has(key) || BASH_DEFAULT_NAMES.has(key);
}

// Same write-target guards the read/list surfaces enforce (UNC → NTLM hash
// leak, device namespace → raw device access / hang, trailing-dot / ADS →
// device-guard bypass). Writes are strictly more dangerous than reads, so
// every adapter write path must run these on both the normalized input and
// the fully resolved path. Returns an Error string or null.
function guardWritePath(p) {
    if (isUncPath(p))
        return `Error: cannot write UNC / SMB path (network credential leak risk): ${normalizeOutputPath(p)}`;
    if (isWindowsDevicePath(p))
        return `Error: cannot write Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(p)}`;
    if (hasUnsafeWin32Component(p))
        return `Error: cannot write Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(p)}`;
    if (isBlockedDevicePath(p))
        return `Error: cannot write device file (would block or corrupt a device): ${normalizeOutputPath(p)}`;
    return null;
}

// Realpath to the nearest existing ancestor (create-mode leaves don't exist
// yet). Returns { probe, real } or null when nothing on the path exists /
// realpath itself fails.
function realpathNearestExisting(fullPath) {
    let probe = fullPath;
    while (probe && !existsSync(probe)) {
        const parent = dirname(probe);
        if (!parent || parent === probe) return null;
        probe = parent;
    }
    if (!probe || !existsSync(probe)) return null;
    try { return { probe, real: realpathSync(probe) }; } catch { return null; }
}

// Realpath-based guard: a symlink/junction in the target (or its nearest
// existing ancestor, for create-mode paths) can point at a UNC share or a
// device namespace that the lexical checks above never see. Mirrors the
// realpath verification apply_patch runs on every header. Returns an Error
// string or null; never throws.
function guardRealTarget(fullPath) {
    const nearest = realpathNearestExisting(fullPath);
    if (nearest && nearest.real !== nearest.probe) {
        const guardErr = guardWritePath(nearest.real);
        if (guardErr) return `${guardErr} (symlink target of ${normalizeOutputPath(nearest.probe)})`;
    }
    try {
        const lst = lstatSync(fullPath);
        if (lst.isSymbolicLink()) {
            const realTarget = realpathSync(fullPath);
            const linkGuardErr = guardWritePath(realTarget);
            if (linkGuardErr) return `${linkGuardErr} (symlink target of ${normalizeOutputPath(fullPath)})`;
        }
        // statSync FOLLOWS a leaf symlink, so a link pointing at a custom
        // FIFO/socket/char/block inode trips here too (lstat alone only saw
        // the link inode itself).
        const st = statSync(fullPath);
        if (isSpecialFileStat(st))
            return `Error: cannot write special file (FIFO / character / block device / socket): ${normalizeOutputPath(fullPath)}`;
    } catch { /* ENOENT (create mode) — nothing to check */ }
    return null;
}

// Write containment — mirrors apply_patch's realBase check: the REAL resolved
// target (symlinks flattened, create-mode suffix re-attached lexically) must
// stay inside the REAL workDir. A lexically-inside path whose ancestor
// symlink/junction lands outside the project must not be writable through
// this adapter surface (apply_patch refuses the same shape).
function guardBaseContainment(fullPath, workDir) {
    let realBase;
    try { realBase = realpathSync(workDir); } catch { return null; }
    const nearest = realpathNearestExisting(fullPath);
    if (!nearest) return null;
    const realResolved = nearest.real + fullPath.slice(nearest.probe.length);
    const fold = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
    const baseWithSep = realBase.endsWith(sep) ? realBase : realBase + sep;
    if (fold(realResolved) !== fold(realBase) && !fold(realResolved).startsWith(fold(baseWithSep))) {
        return `Error: cannot write outside the working directory: ${normalizeOutputPath(realResolved)} escapes ${normalizeOutputPath(realBase)}`;
    }
    return null;
}

async function resolveTargetPath(args, workDir) {
    const raw = args?.path ?? args?.file_path;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const norm = normalizeInputPath(raw);
    const guardErr = guardWritePath(norm);
    if (guardErr) return { error: guardErr };
    const full = resolveAgainstCwd(norm, workDir);
    const fullGuardErr = guardWritePath(full);
    if (fullGuardErr) return { error: fullGuardErr };
    // Reachability preflight BEFORE any sync fs (existsSync/realpathSync/
    // lstatSync in the guards below): a dead mount would wedge the event loop
    // on the first sync stat, defeating every downstream timeout. Same
    // deadline-raced probe the read path runs (_readReachPreflight).
    try { await assertPathsReachable([full]); }
    catch (e) { return { error: `Error: ${e?.message || e}` }; }
    const realGuardErr = guardRealTarget(full);
    if (realGuardErr) return { error: realGuardErr };
    const containErr = guardBaseContainment(full, workDir);
    if (containErr) return { error: containErr };
    return { full };
}

function invalidateAfterWrite(fullPath) {
    try { invalidateBuiltinResultCache([fullPath]); } catch { /* best-effort */ }
    try { markCodeGraphDirtyPaths([fullPath]); } catch { /* best-effort */ }
}

function countOccurrences(haystack, needle) {
    let count = 0;
    let idx = -1;
    while ((idx = haystack.indexOf(needle, idx + 1)) !== -1) count += 1;
    return count;
}

async function adaptStrReplace(args, workDir, options) {
    const oldStr = args?.old_string;
    const newStr = args?.new_string;
    if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null;
    // Empty old_string would loop forever in countOccurrences (indexOf('', i)
    // never returns -1) and has no meaningful replace semantics anyway.
    if (oldStr.length === 0) return 'Error: old_string must be a non-empty string';
    const target = await resolveTargetPath(args, workDir);
    if (!target) return null;
    if (target.error) return target.error;
    const fullPath = target.full;
    let content;
    let statBefore = null;
    try {
        try { statBefore = statSync(fullPath); } catch { /* readFileSync below surfaces the real error */ }
        content = readFileSync(fullPath, 'utf8');
    } catch (err) {
        return `Error: cannot read ${fullPath} (${err?.message || err})`;
    }
    const matchCount = countOccurrences(content, oldStr);
    if (matchCount === 0) return `Error: old_string not found in ${fullPath}`;
    if (matchCount > 1) return `Error: old_string is ambiguous: ${matchCount} matches in ${fullPath}`;
    const first = content.indexOf(oldStr);
    const updated = content.slice(0, first) + newStr + content.slice(first + oldStr.length);
    // Lost-update guard: hand the pre-read stat to atomicWrite as an expected
    // target snapshot — it re-stats immediately before EACH rename attempt and
    // aborts with ESTALE_TARGET when another writer (parallel tool call,
    // interleaved apply_patch) changed the file after our read. This closes
    // the check-then-write race a pre-write mtime comparison here would leave.
    try {
        await atomicWrite(fullPath, updated, {
            sessionId: options?.readStateScope || options?.sessionId,
            expectedTargetSnapshot: statBefore ? {
                exists: true,
                size: statBefore.size,
                mtimeMs: statBefore.mtimeMs,
                ctimeMs: statBefore.ctimeMs,
                ino: statBefore.ino,
            } : undefined,
        });
    } catch (err) {
        if (err?.code === 'ESTALE_TARGET') {
            return `Error: ${fullPath} changed on disk during the replace; re-read and retry`;
        }
        throw err;
    }
    invalidateAfterWrite(fullPath);
    return `Updated ${fullPath} (1 replacement)`;
}

async function adaptWrite(args, workDir, options) {
    const contents = args?.contents ?? args?.content ?? args?.file_text;
    if (typeof contents !== 'string') return null;
    const target = await resolveTargetPath(args, workDir);
    if (!target) return null;
    if (target.error) return target.error;
    const fullPath = target.full;
    const existed = existsSync(fullPath);
    try { mkdirSync(dirname(fullPath), { recursive: true }); } catch { /* best-effort: parent may already exist */ }
    await atomicWrite(fullPath, contents, { sessionId: options?.readStateScope || options?.sessionId });
    invalidateAfterWrite(fullPath);
    return `${existed ? 'Updated' : 'Created'} ${fullPath} (${Buffer.byteLength(contents, 'utf8')} bytes)`;
}

async function adaptBash(key, args, workDir, options) {
    if (typeof args?.command !== 'string' || args.command.length === 0) return null;
    const shellArgs = { ...args };
    if (BASH_SHELL_KIND_NAMES.has(key) && shellArgs.shell === undefined) shellArgs.shell = 'bash';
    return executeBashTool(shellArgs, workDir, options);
}

export async function tryExecuteExternalToolAdapter(name, args, workDir, options) {
    if (typeof name !== 'string' || !name) return null;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    const key = name.toLowerCase();
    try {
        if (STR_REPLACE_NAMES.has(key)) return await adaptStrReplace(args, workDir, options);
        if (WRITE_NAMES.has(key)) return await adaptWrite(args, workDir, options);
        if (BASH_SHELL_KIND_NAMES.has(key) || BASH_DEFAULT_NAMES.has(key)) return await adaptBash(key, args, workDir, options);
    } catch (err) {
        return `Error: ${name} failed (${err?.message || String(err)})`;
    }
    return null;
}
