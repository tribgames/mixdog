import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname } from 'path';
import {
    normalizeOutputPath,
    resolveAgainstCwd,
} from './path-utils.mjs';
import {
    findSimilarFile,
    listSiblings,
    normalizeErrorMessage,
} from './path-diagnostics.mjs';
import { isBinaryFile } from './binary-file.mjs';
import { READ_MAX_SIZE_BYTES } from './read-constants.mjs';
import { normalizePathAndStripLineCoordinate } from './read-args.mjs';
import {
    isBlockedDevicePath,
    isSpecialFileStat,
    isUncPath,
    isWindowsDevicePath,
    hasUnsafeWin32Component,
} from './device-paths.mjs';

function detectReadEncodingFromBuffer(head) {
    const n = head.length;
    if (n >= 2 && head[0] === 0xff && head[1] === 0xfe) {
        return { encoding: 'utf16le', bomLen: 2 };
    }
    if (n >= 2 && head[0] === 0xfe && head[1] === 0xff) {
        return { encoding: 'utf16be', bomLen: 2 };
    }
    if (n >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
        return { encoding: 'utf8', bomLen: 3 };
    }
    return { encoding: 'utf8', bomLen: 0 };
}

export function detectReadEncoding(fullPath) {
    let fd;
    try {
        fd = openSync(fullPath, 'r');
        const head = Buffer.alloc(3);
        const n = readSync(fd, head, 0, 3, 0);
        return detectReadEncodingFromBuffer(head.subarray(0, n));
    } catch {
        return { encoding: 'utf8', bomLen: 0 };
    } finally {
        if (fd !== undefined) { try { closeSync(fd); } catch {} }
    }
}

function decodeReadBuffer(buf, enc) {
    if (enc.encoding === 'utf16le') {
        return buf.subarray(enc.bomLen).toString('utf16le');
    }
    if (enc.encoding === 'utf16be') {
        // Node has no 'utf16be' string encoding; swap byte pairs to LE in a
        // copy, then decode as utf16le. swap16 needs an even length, so drop a
        // trailing odd byte before swapping.
        const body = buf.subarray(enc.bomLen);
        const even = body.length & ~1;
        return Buffer.from(body.subarray(0, even)).swap16().toString('utf16le');
    }
    const slice = enc.bomLen ? buf.subarray(enc.bomLen) : buf;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(slice);
    } catch (err) {
        const e = new Error(`invalid UTF-8 in text file: ${err instanceof Error ? err.message : String(err)}`);
        e.code = 'EUTF8';
        throw e;
    }
}

/** String-phase guards shared by full read and mode reads. Returns error message or null. */
export function readPathStringGuardError(filePath, workDir) {
    if (typeof filePath !== 'string' || !filePath) {
        return 'path is required';
    }
    const guardedPath = normalizePathAndStripLineCoordinate(filePath, workDir);
    if (isUncPath(guardedPath)) {
        return `cannot read UNC / SMB path (network credential leak risk): ${normalizeOutputPath(guardedPath)}`;
    }
    if (isWindowsDevicePath(guardedPath)) {
        return `cannot read Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(guardedPath)}`;
    }
    if (hasUnsafeWin32Component(guardedPath)) {
        return `cannot read Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(guardedPath)}`;
    }
    if (isBlockedDevicePath(guardedPath)) {
        return `cannot read device file (would block or produce infinite output): ${normalizeOutputPath(guardedPath)}`;
    }
    const fullPath = resolveAgainstCwd(guardedPath, workDir);
    if (isUncPath(fullPath)) {
        return `cannot read UNC / SMB path (network credential leak risk): ${normalizeOutputPath(fullPath)}`;
    }
    if (isWindowsDevicePath(fullPath)) {
        return `cannot read Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(fullPath)}`;
    }
    if (hasUnsafeWin32Component(fullPath)) {
        return `cannot read Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(fullPath)}`;
    }
    if (isBlockedDevicePath(fullPath)) {
        return `cannot read device file (would block or produce infinite output): ${normalizeOutputPath(fullPath)}`;
    }
    return null;
}

/** Post-stat / symlink guards. Returns error message or null. */
function readPathStatGuardError(userPath, fullPath, st) {
    if (isSpecialFileStat(st)) {
        return `cannot read special file (FIFO / character / block device / socket): ${normalizeOutputPath(userPath)}`;
    }
    try {
        const lst = lstatSync(fullPath);
        if (lst?.isSymbolicLink?.()) {
            let realTarget = null;
            try { realTarget = realpathSync(fullPath); } catch { realTarget = null; }
            if (realTarget && realTarget !== fullPath) {
                if (isBlockedDevicePath(realTarget)) {
                    return `cannot read device file via symlink (would block or produce infinite output): ${normalizeOutputPath(userPath)} → ${normalizeOutputPath(realTarget)}`;
                }
                if (isUncPath(realTarget)) {
                    return `cannot read UNC / SMB path via symlink (network credential leak risk): ${normalizeOutputPath(userPath)} → ${normalizeOutputPath(realTarget)}`;
                }
                if (isWindowsDevicePath(realTarget)) {
                    return `cannot read Windows device path via symlink (reserved name or raw-device namespace): ${normalizeOutputPath(userPath)} → ${normalizeOutputPath(realTarget)}`;
                }
                try {
                    const rst = statSync(realTarget);
                    if (isSpecialFileStat(rst)) {
                        return `cannot read special file via symlink (FIFO / character / block device / socket): ${normalizeOutputPath(userPath)} → ${normalizeOutputPath(realTarget)}`;
                    }
                } catch { /* ENOENT surfaces later */ }
            }
        }
    } catch { /* best-effort */ }
    return null;
}

// Shared file-open prologue for read-flavoured tools (tail / wc / diff / modes).
export function openTextPathForReadMeta(filePath, workDir, opts = {}) {
    const guardErr = readPathStringGuardError(filePath, workDir);
    if (guardErr) {
        throw Object.assign(new Error(guardErr), { code: 'EARG' });
    }
    const norm = normalizePathAndStripLineCoordinate(filePath, workDir);
    const fullPath = resolveAgainstCwd(norm, workDir);
    let st;
    try { st = statSync(fullPath); }
    catch (err) {
        const similar = findSimilarFile(fullPath);
        const siblings = listSiblings(dirname(fullPath));
        const hint = (similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '')
                   + ` Siblings: [${siblings.join(', ')}].`;
        const msg = normalizeErrorMessage(err instanceof Error ? err.message : String(err)) + hint;
        throw Object.assign(new Error(msg), { code: 'ENOENT' });
    }
    const statGuard = readPathStatGuardError(filePath, fullPath, st);
    if (statGuard) {
        throw Object.assign(new Error(statGuard), { code: 'ESPECIAL' });
    }
    if (opts.enforceSizeCap !== false && st.size > READ_MAX_SIZE_BYTES) {
        throw Object.assign(
            new Error(`file size ${st.size} bytes exceeds ${READ_MAX_SIZE_BYTES}-byte cap`),
            { code: 'ETOOBIG', size: st.size, fullPath, st });
    }
    if (opts.skipBinary !== true && isBinaryFile(fullPath, st.size)) {
        throw Object.assign(
            new Error(`file appears to be binary (contains null bytes): ${normalizeOutputPath(norm)}`),
            { code: 'EBINARY' });
    }
    return { fullPath, displayPath: normalizeOutputPath(norm), st, size: st.size };
}

export async function openForRead(filePath, workDir, opts = {}) {
    const meta = openTextPathForReadMeta(filePath, workDir, opts);
    const rawBuf = await readFile(meta.fullPath);
    const enc = detectReadEncodingFromBuffer(rawBuf.subarray(0, Math.min(rawBuf.length, 3)));
    let content;
    try {
        content = decodeReadBuffer(rawBuf, enc);
    } catch (err) {
        if (err?.code === 'EUTF8' && opts.routeInvalidUtf8ToHex === true) {
            throw Object.assign(new Error(err.message), { code: 'EUTF8', fullPath: meta.fullPath, st: meta.st });
        }
        throw err;
    }
    return { ...meta, content, readEncoding: enc };
}