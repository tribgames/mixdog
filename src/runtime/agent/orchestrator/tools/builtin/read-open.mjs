import { lstat, open, readFile, realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeOutputPath, resolveAgainstCwd } from './path-utils.mjs';
import { findSimilarFileAsync, listSiblingsAsync, normalizeErrorMessage } from './path-diagnostics.mjs';
import { inspectBinaryFile } from './binary-file.mjs';
import { READ_MAX_SIZE_BYTES } from './read-constants.mjs';
import { normalizePathAndStripLineCoordinate } from './read-args.mjs';
import {
  isBlockedDevicePath,
  isSpecialFileStat,
  isUncPath,
  isWindowsDevicePath,
  hasUnsafeWin32Component,
} from './device-paths.mjs';
import { decodeUtf16Body, detectReadEncodingFromBuffer, isUtf16Encoding } from './snapshot-helpers.mjs';

export async function detectReadEncoding(fullPath) {
  let fh;
  try {
    fh = await open(fullPath, 'r');
    const head = Buffer.alloc(3);
    const { bytesRead } = await fh.read(head, 0, 3, 0);
    return detectReadEncodingFromBuffer(head.subarray(0, bytesRead));
  } catch {
    return { encoding: 'utf8', bomLen: 0 };
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {}
    }
  }
}

function decodeReadBuffer(buf, enc) {
  if (isUtf16Encoding(enc)) return decodeUtf16Body(buf, enc);
  const slice = enc.bomLen ? buf.subarray(enc.bomLen) : buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(slice);
  } catch (err) {
    const e = new Error(`invalid UTF-8 in text file: ${err instanceof Error ? err.message : String(err)}`);
    e.code = 'EUTF8';
    throw e;
  }
}

function readStringGuardMessage(p) {
  if (isUncPath(p)) {
    return `cannot read UNC / SMB path (network credential leak risk): ${normalizeOutputPath(p)}`;
  }
  if (isWindowsDevicePath(p)) {
    return `cannot read Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(p)}`;
  }
  if (hasUnsafeWin32Component(p)) {
    return `cannot read Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(p)}`;
  }
  if (isBlockedDevicePath(p)) {
    return `cannot read device file (would block or produce infinite output): ${normalizeOutputPath(p)}`;
  }
  return null;
}

/** String-phase guards shared by full read and mode reads. Returns error message or null. */
export function readPathStringGuardError(filePath, workDir) {
  if (typeof filePath !== 'string' || !filePath) {
    return 'path is required';
  }
  // The path as written, then as resolved against workDir.
  const guardedPath = normalizePathAndStripLineCoordinate(filePath, workDir);
  return readStringGuardMessage(guardedPath) ?? readStringGuardMessage(resolveAgainstCwd(guardedPath, workDir));
}

/** Post-stat / symlink guards. Returns error message or null. */
async function readPathStatGuardError(userPath, fullPath, st) {
  if (isSpecialFileStat(st)) {
    return `cannot read special file (FIFO / character / block device / socket): ${normalizeOutputPath(userPath)}`;
  }
  try {
    const lst = await lstat(fullPath);
    if (lst?.isSymbolicLink?.()) {
      let realTarget = null;
      try {
        realTarget = await realpath(fullPath);
      } catch {
        realTarget = null;
      }
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
          const rst = await stat(realTarget);
          if (isSpecialFileStat(rst)) {
            return `cannot read special file via symlink (FIFO / character / block device / socket): ${normalizeOutputPath(userPath)} → ${normalizeOutputPath(realTarget)}`;
          }
        } catch {
          /* ENOENT surfaces later */
        }
      }
    }
  } catch {
    /* best-effort */
  }
  return null;
}

// Shared file-open prologue for read-flavoured tools (tail / wc / diff / modes).
export async function openTextPathForReadMeta(filePath, workDir, opts = {}) {
  const guardErr = readPathStringGuardError(filePath, workDir);
  if (guardErr) {
    throw Object.assign(new Error(guardErr), { code: 'EARG' });
  }
  const norm = normalizePathAndStripLineCoordinate(filePath, workDir);
  const fullPath = resolveAgainstCwd(norm, workDir);
  let st;
  try {
    st = await stat(fullPath);
  } catch (err) {
    const [similar, siblings] = await Promise.all([
      findSimilarFileAsync(fullPath),
      listSiblingsAsync(dirname(fullPath)),
    ]);
    const hint = `${similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : ''} Siblings: [${siblings.join(', ')}].`;
    const msg = normalizeErrorMessage(err instanceof Error ? err.message : String(err)) + hint;
    throw Object.assign(new Error(msg), { code: 'ENOENT' });
  }
  const statGuard = await readPathStatGuardError(filePath, fullPath, st);
  if (statGuard) {
    throw Object.assign(new Error(statGuard), { code: 'ESPECIAL' });
  }
  if (opts.enforceSizeCap !== false && st.size > READ_MAX_SIZE_BYTES) {
    throw Object.assign(new Error(`file size ${st.size} bytes exceeds ${READ_MAX_SIZE_BYTES}-byte cap`), {
      code: 'ETOOBIG',
      size: st.size,
      fullPath,
      st,
    });
  }
  if (opts.skipBinary !== true && (await inspectBinaryFile(fullPath, st.size)).isBinary) {
    throw Object.assign(new Error(`file appears to be binary (contains null bytes): ${normalizeOutputPath(norm)}`), {
      code: 'EBINARY',
    });
  }
  return { fullPath, displayPath: normalizeOutputPath(norm), st, size: st.size };
}

export async function openForRead(filePath, workDir, opts = {}) {
  const meta = await openTextPathForReadMeta(filePath, workDir, opts);
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
