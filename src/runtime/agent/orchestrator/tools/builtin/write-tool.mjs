import { mkdirSync, statSync, lstatSync, openSync, readSync, closeSync } from 'fs';
import { dirname } from 'path';
import { markCodeGraphDirtyPaths } from '../code-graph.mjs';
import {
    normalizeInputPath,
    normalizeOutputPath,
    resolveAgainstCwd,
} from './path-utils.mjs';
import { normalizeErrorMessage } from './path-diagnostics.mjs';
import { withPathLock, withBuiltinPathLocks, pathLockKey } from './path-locks.mjs';
import { withAdvisoryLocks } from './advisory-lock.mjs';
import { hashText } from './hash-utils.mjs';
import { snapshotCoversFullFile } from './snapshot-helpers.mjs';
import {
    getReadSnapshot,
    isSnapshotStale,
    readContentIfSnapshotHashMatches,
    recordReadSnapshot,
} from './read-snapshot-runtime.mjs';
import {
    invalidateBuiltinResultCache,
    seedRawContentCacheAfterWrite,
} from './cache-layers.mjs';
import { atomicWrite } from './atomic-write.mjs';
import {
    hasUnsafeWin32Component,
    isWindowsDevicePath,
    isUncPath,
    isSpecialFileStat,
} from './device-paths.mjs';
import { assertPathReachable, assertPathsReachable } from './fs-reachability.mjs';

const STREAMING_THRESHOLD_BYTES = 1024 * 1024;

// BOM invariant: an existing file's encoding is determined STRICTLY by its
// leading BOM bytes — never by content sniffing. Mirrors Claude Code
// detectFileEncoding (src/utils/file.ts:84-118) and the FF FE -> utf16le
// check in src/utils/fileRead.ts:34. Returns a tag describing how to
// re-emit content so an overwrite preserves the on-disk encoding:
//   { encoding: 'utf16le', bom: <Buffer FF FE> }   -> UTF-16LE w/ BOM
//   { encoding: 'utf8',    bom: <Buffer EF BB BF> } -> UTF-8 w/ BOM
//   { encoding: 'utf8',    bom: null }              -> UTF-8 (new/absent/no BOM)
export function detectExistingEncoding(fullPath) {
    let fd;
    try {
        fd = openSync(fullPath, 'r');
        const head = Buffer.alloc(3);
        const bytesRead = readSync(fd, head, 0, 3, 0);
        if (bytesRead >= 2 && head[0] === 0xff && head[1] === 0xfe) {
            return { encoding: 'utf16le', bom: Buffer.from([0xff, 0xfe]) };
        }
        if (bytesRead >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
            return { encoding: 'utf8', bom: Buffer.from([0xef, 0xbb, 0xbf]) };
        }
        return { encoding: 'utf8', bom: null };
    } catch {
        // File absent or unreadable -> new file: utf-8, no BOM.
        return { encoding: 'utf8', bom: null };
    } finally {
        if (fd !== undefined) { try { closeSync(fd); } catch {} }
    }
}

export function toWriteBuffer(content, encoding = { encoding: 'utf8', bom: null }) {
    if (typeof content !== 'string') return content;
    const body = Buffer.from(content, encoding.encoding === 'utf16le' ? 'utf16le' : 'utf-8');
    return encoding.bom ? Buffer.concat([encoding.bom, body]) : body;
}

function captureTargetSnapshot(fullPath) {
    try {
        const st = statSync(fullPath);
        return {
            exists: true,
            size: st.size,
            mtimeMs: Number(st.mtimeMs),
            ctimeMs: Number(st.ctimeMs),
            ino: Number(st.ino),
        };
    } catch (err) {
        if (err && err.code === 'ENOENT') return { exists: false };
        throw err;
    }
}

/** Whole-file overwrite proof: full coverage sentinel + on-disk contentHash. */
function snapshotAllowsWholeFileOverwrite(snapshot) {
    if (!snapshot) return false;
    if (typeof snapshot.contentHash !== 'string' || !snapshot.contentHash) return false;
    return snapshotCoversFullFile(snapshot);
}

function writeUncRejectMessage(displayPath, paths, { batch = false } = {}) {
    for (const p of paths) {
        if (typeof p !== 'string') continue;
        if (typeof isUncPath === 'function' ? isUncPath(p) : (p.startsWith('\\\\') || p.startsWith('//'))) {
            return batch
                ? `FAIL ${normalizeOutputPath(displayPath)}: UNC/SMB paths are not supported (R1: NTLM-leak prevention)`
                : `Error: UNC/SMB paths are not supported (R1: NTLM-leak prevention): ${displayPath}`;
        }
    }
    return null;
}

function validateOverwriteAllowed(fullPath, displayPath, readStateScope, { batch = false, allowUnreadOverwrite = false } = {}) {
    const uncErr = writeUncRejectMessage(displayPath, [fullPath], { batch });
    if (uncErr) return uncErr;
    try {
        const existing = lstatSync(fullPath);
        if (existing.isSymbolicLink && existing.isSymbolicLink()) {
            return batch
                ? `FAIL ${normalizeOutputPath(displayPath)}: symlink targets are not supported for write (would replace the link)`
                : `Error: symlink targets are not supported for write (would replace the link): ${displayPath}`;
        }
        if (typeof isSpecialFileStat === 'function' && isSpecialFileStat(existing)) {
            return batch
                ? `FAIL ${normalizeOutputPath(displayPath)}: non-regular file (FIFO / device / socket) cannot be overwritten`
                : `Error: non-regular file (FIFO / device / socket) cannot be overwritten: ${displayPath}`;
        }
        // Opt-in fast path: skip ONLY the read-before-write / stale-snapshot
        // gate (codes 6/10/7). All other checks (symlink, special-file, UNC,
        // stat-error surfacing above/below) still apply.
        if (!allowUnreadOverwrite && existing.isFile() && !getReadSnapshot(fullPath, readStateScope)) {
            return batch
                ? `FAIL ${normalizeOutputPath(displayPath)}: file exists but has not been read yet — read before overwriting`
                : `Error [code 6]: file exists but has not been read yet — read before overwriting: ${displayPath}`;
        }
        if (!allowUnreadOverwrite && existing.isFile()) {
            const snapshot = getReadSnapshot(fullPath, readStateScope);
            if (snapshot && !snapshotAllowsWholeFileOverwrite(snapshot)) {
                const detail = snapshot.grepOnly === true
                    ? 'grep snapshot lacks full-file proof — read it in full before overwriting'
                    : 'partial-read snapshot — read it in full before overwriting';
                return batch
                    ? `FAIL ${normalizeOutputPath(displayPath)}: ${detail}`
                    : `Error [code 10]: ${detail}: ${displayPath}`;
            }
            if (snapshot && isSnapshotStale(existing, snapshot, fullPath)) {
                const hashOk = readContentIfSnapshotHashMatches(fullPath, snapshot, null, existing);
                if (hashOk === null) {
                    return batch
                        ? `FAIL ${normalizeOutputPath(displayPath)}: file modified since read — read it again before overwriting`
                        : `Error [code 7]: file modified since read — read it again before overwriting: ${displayPath}`;
                }
            }
        }
    } catch (err) {
        // Only ENOENT is "safe to create"; any other stat error (EACCES,
        // EPERM, ELOOP, ENOTDIR, …) must surface so we don't silently
        // overwrite or pretend the file is absent.
        if (err && err.code === 'ENOENT') return null;
        const reason = normalizeErrorMessage(err instanceof Error ? err.message : String(err));
        return batch
            ? `FAIL ${normalizeOutputPath(displayPath)}: stat failed before overwrite: ${reason}`
            : `Error: stat failed before overwrite: ${reason}: ${displayPath}`;
    }
    return null;
}

async function writeOneUnlocked({ filePath, content, fullPath, readStateScope, sessionId, targetSnapshot }) {
    mkdirSync(dirname(fullPath), { recursive: true });
    // Preserve the existing file's encoding (BOM invariant); new files -> utf-8.
    const writeContent = toWriteBuffer(content, detectExistingEncoding(fullPath));
    const byteLength = Buffer.isBuffer(writeContent)
        ? writeContent.length
        : Buffer.byteLength(String(writeContent ?? ''), 'utf-8');
    const oversized = byteLength > STREAMING_THRESHOLD_BYTES;
    await atomicWrite(fullPath, writeContent, {
        sessionId,
        expectedTargetSnapshot: targetSnapshot,
    });
    let writtenStat = null;
    try { writtenStat = statSync(fullPath); } catch {}
    recordReadSnapshot(fullPath, writtenStat || undefined, readStateScope, {
        source: 'write',
        contentHash: hashText(writeContent),
    });
    return {
        filePath,
        fullPath,
        content: writeContent,
        stat: writtenStat,
        oversized,
    };
}

export async function executeWriteTool(args, workDir, readStateScope, options = {}) {
    if (typeof args.file_path === 'string' && !args.path) args.path = args.file_path;
    const allowUnreadOverwrite = args.allow_unread_overwrite === true;
    if (Array.isArray(args.writes) && args.writes.length > 0) {
        const items = args.writes.map((entry) => ({
            path: normalizeInputPath(entry?.path ?? entry?.file_path),
            content: entry?.content,
        }));
        const missing = items.filter((entry) => !entry.path || entry.content === undefined);
        if (missing.length > 0) {
            return 'Error: each write entry requires path and content';
        }

        // Reject duplicate targets (same lock key) and parent/child
        // conflicts (one entry would write a file at a path another entry
        // needs as a directory ancestor, or vice versa).
        for (const entry of items) {
            if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(entry.path)) {
                return `Error: cannot write Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(entry.path)}`;
            }
            if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(entry.path)) {
                return `Error: cannot write Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(entry.path)}`;
            }
        }
        const resolvedItems = items.map((entry) => {
            const fp = resolveAgainstCwd(entry.path, workDir);
            return { entry, fullPath: fp, lockKey: pathLockKey(fp) };
        });
        for (const r of resolvedItems) {
            if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(r.fullPath)) {
                return `Error: cannot write Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(r.entry.path)}`;
            }
            if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(r.fullPath)) {
                return `Error: cannot write Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(r.entry.path)}`;
            }
        }
        const seenKeys = new Map();
        for (const r of resolvedItems) {
            if (seenKeys.has(r.lockKey)) {
                return `Error: duplicate target in batch: ${normalizeOutputPath(r.entry.path)} collides with ${normalizeOutputPath(seenKeys.get(r.lockKey))}`;
            }
            seenKeys.set(r.lockKey, r.entry.path);
        }
        const sortedKeys = [...seenKeys.keys()].sort();
        for (let i = 0; i + 1 < sortedKeys.length; i += 1) {
            const a = sortedKeys[i];
            const b = sortedKeys[i + 1];
            if (b.length > a.length && b.startsWith(a) && (b[a.length] === '/' || b[a.length] === '\\')) {
                return `Error: parent/child path conflict in batch: ${normalizeOutputPath(seenKeys.get(a))} would be a file but ${normalizeOutputPath(seenKeys.get(b))} requires it as a directory`;
            }
        }

        // ATOMIC BATCH CONTRACT: UNC + preflight before any lock acquire
        // (advisory lock mkdir must not run for rejected batches), then
        // acquire all locks in sorted order, commit with per-file snapshots.
        const allFullPaths = resolvedItems.map((r) => r.fullPath);
        for (const { entry, fullPath } of resolvedItems) {
            const uncErr = writeUncRejectMessage(entry.path, [entry.path, fullPath], { batch: true });
            if (uncErr) {
                return `Error: batch write rejected — UNC path blocked before lock; no files written\n${uncErr}`;
            }
        }
        try {
            await assertPathsReachable(allFullPaths);
        } catch (err) {
            const reason = normalizeErrorMessage(err instanceof Error ? err.message : String(err));
            return `Error: batch write rejected — path reachability preflight failed; no files written\n${reason}`;
        }
        const preflightLines = [];
        let preflightFailed = false;
        for (const { entry, fullPath } of resolvedItems) {
            const filePath = entry.path;
            if (typeof entry.content === 'string') {
                const _nulIdx = entry.content.indexOf('\u0000');
                if (_nulIdx !== -1) {
                    preflightLines.push(`FAIL ${normalizeOutputPath(filePath)}: Error [code 11]: content contains NUL byte (U+0000) at offset ${_nulIdx} — source text must not contain NUL`);
                    preflightFailed = true;
                    continue;
                }
            }
            const preflightError = validateOverwriteAllowed(fullPath, filePath, readStateScope, { batch: true, allowUnreadOverwrite });
            if (preflightError) {
                preflightLines.push(preflightError);
                preflightFailed = true;
            }
        }
        if (preflightFailed) {
            return `Error: batch write rejected — preflight failed (${preflightLines.length} of ${resolvedItems.length}); no files written\n${preflightLines.join('\n')}`;
        }

        return withBuiltinPathLocks(allFullPaths, () =>
            withAdvisoryLocks(allFullPaths, async () => {
                // Commit phase: preflight already passed. Per-file failure
                // here is still possible (mid-flight disk error, TOCTOU
                // detection), but is uncommon and reported per entry.
                const results = [];
                const dirtyPaths = [];
                const successfulWrites = [];
                let commitFailed = 0;
                for (const { entry, fullPath } of resolvedItems) {
                    const filePath = entry.path;
                    const content = entry.content;
                    try {
                        const targetSnapshot = captureTargetSnapshot(fullPath);
                        const written = await writeOneUnlocked({
                            filePath,
                            content,
                            fullPath,
                            readStateScope,
                            sessionId: options?.sessionId,
                            targetSnapshot,
                        });
                        successfulWrites.push(written);
                        dirtyPaths.push(fullPath);
                        results.push(`OK ${normalizeOutputPath(filePath)}`);
                    } catch (err) {
                        commitFailed += 1;
                        results.push(`FAIL ${normalizeOutputPath(filePath)}: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`);
                    }
                }

                if (dirtyPaths.length > 0) {
                    invalidateBuiltinResultCache(dirtyPaths);
                    for (const seed of successfulWrites) {
                        // Skip raw-content cache seeding for oversized
                        // writes — keeping a multi-megabyte payload in
                        // memory after rename defeats the streaming win.
                        if (seed.oversized) continue;
                        seedRawContentCacheAfterWrite(seed.fullPath, seed.content, seed.stat);
                    }
                    markCodeGraphDirtyPaths(dirtyPaths);
                }
                if (commitFailed > 0) {
                    return `Error: batch write failed during commit (${commitFailed} of ${resolvedItems.length}); preflight passed but some renames failed\n${results.join('\n')}`;
                }
                // ② completion progress (claude "Found N" parity). Best-effort,
                // no-op when onProgress is absent (no progressToken).
                if (typeof options?.onProgress === 'function') {
                    try { options.onProgress(`wrote ${successfulWrites.length} files`); } catch { /* best-effort */ }
                }
                return results.join('\n');
            })
        );
    }

    args.path = normalizeInputPath(args.path);
    const filePath = args.path;
    const content = args.content;
    if (!filePath) return 'Error: path is required';
    if (content === undefined) return 'Error: content is required';
    if (typeof content === 'string') {
        const _nulIdx = content.indexOf('\u0000');
        if (_nulIdx !== -1) return `Error [code 11]: content contains NUL byte (U+0000) at offset ${_nulIdx} — source text must not contain NUL: ${filePath}`;
    }
    // R12: Win32 component guard — reject trailing dot/space or NTFS ADS
    // suffix (foo.txt:ads) and reserved device names (NUL, CON, …) before
    // resolve so a relative path can't be coerced into a device alias.
    if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(filePath)) {
        return `Error: cannot write Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(filePath)}`;
    }
    if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(filePath)) {
        return `Error: cannot write Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(filePath)}`;
    }

    const fullPath = resolveAgainstCwd(filePath, workDir);
    const uncErr = writeUncRejectMessage(filePath, [filePath, fullPath], { batch: false });
    if (uncErr) return uncErr;
    if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(fullPath)) {
        return `Error: cannot write Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(filePath)}`;
    }
    if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(fullPath)) {
        return `Error: cannot write Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(filePath)}`;
    }
    try {
        await assertPathReachable(fullPath);
    } catch (err) {
        return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
    }
    const preflightError = validateOverwriteAllowed(fullPath, filePath, readStateScope, { allowUnreadOverwrite });
    if (preflightError) return preflightError;
    return withPathLock(fullPath, () =>
        withAdvisoryLocks([fullPath], async () => {
            let targetSnapshot;
            try {
                targetSnapshot = captureTargetSnapshot(fullPath);
            } catch (err) {
                return `Error: snapshot capture failed: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}: ${filePath}`;
            }
            try {
                const written = await writeOneUnlocked({
                    filePath,
                    content,
                    fullPath,
                    readStateScope,
                    sessionId: options?.sessionId,
                    targetSnapshot,
                });
                invalidateBuiltinResultCache([fullPath]);
                if (!written.oversized) {
                    seedRawContentCacheAfterWrite(fullPath, written.content, written.stat);
                }
                markCodeGraphDirtyPaths([fullPath]);
                // ② completion progress (claude "Found N" parity). Best-effort,
                // no-op when onProgress is absent (no progressToken).
                if (typeof options?.onProgress === 'function') {
                    try { options.onProgress(`wrote ${normalizeOutputPath(filePath)}`); } catch { /* best-effort */ }
                }
                return `Written: ${normalizeOutputPath(filePath)}`;
            }
            catch (err) {
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
            }
        })
    );
}
