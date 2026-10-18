import { buildNotFoundHint, finalizeReadFamilyEnoentTail } from '../search-path-diagnostics.mjs';
import { open } from 'node:fs/promises';
import { normalizeErrorMessage } from '../path-diagnostics.mjs';
import { isBinaryBuffer } from '../binary-file.mjs';
import { isUncPath, isWindowsDevicePath, hasUnsafeWin32Component } from '../device-paths.mjs';
import { normalizeOutputPath, resolveAgainstCwd } from '../path-utils.mjs';
import { windowMarker } from '../tool-output-limit.mjs';

/** Report the requested path's result; suggestions never retarget the operation. */
export async function readFamilyPathEnoentOrError(workDir, fullPath, inputPath, err) {
  const safeMsg = normalizeErrorMessage(err instanceof Error ? err.message : String(err));
  const hint = await buildNotFoundHint(workDir, fullPath, 'List', err?.code);
  const tail = finalizeReadFamilyEnoentTail(hint, inputPath, err?.code);
  // Conclusive absence is the list's ANSWER, not a tool failure (matches
  // read's `[path absent]` and git's `repo:false` policy). Genuine
  // not-found only — EACCES/EPERM etc. keep failure semantics.
  if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
    return `[path absent] ${safeMsg}${tail}`;
  }
  return `Error: ${safeMsg}${tail}`;
}

export function normalizeListHeadLimit(raw, defaultCap) {
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
  if (isUncPath(p))
    return `Error: cannot walk UNC / SMB path (network credential leak risk): ${normalizeOutputPath(p)}`;
  if (isWindowsDevicePath(p))
    return `Error: cannot walk Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(p)}`;
  if (hasUnsafeWin32Component(p))
    return `Error: cannot walk Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(p)}`;
  return null;
}

// The walk root for `inputPath`, guarded both as written and once resolved
// against workDir: `{ fullPath }`, or `{ error }` when either form is blocked.
export function guardedWalkRoot(inputPath, workDir) {
  const guard = listGuardPath(inputPath);
  if (guard) return { error: guard };
  const fullPath = resolveAgainstCwd(inputPath, workDir);
  const guardFull = listGuardPath(fullPath);
  if (guardFull) return { error: guardFull };
  return { fullPath };
}

// Code-unit path order: the tiebreak that makes a size/mtime sort total, so
// equal keys cannot reorder with the walk (and shift across offset pages).
export function comparePathsStable(a, b) {
  const x = String(a);
  const y = String(b);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

export function pageContinuationLine(offset, shown, total) {
  return windowMarker({
    unit: 'entries',
    from: offset + 1,
    to: offset + shown,
    total,
    nextOffset: offset + shown,
  });
}

const LINE_COUNT_MAX_BYTES = 2 * 1024 * 1024;

/** Line count of a text file for list meta rows; null for binaries, files over
 *  the size cap, and anything unreadable. */
export async function countTextFileLines(fullPath, size) {
  if (!(size <= LINE_COUNT_MAX_BYTES)) return null;
  let handle;
  try {
    handle = await open(fullPath, 'r');
    const buf = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buf, 0, size, 0);
    const data = buf.subarray(0, bytesRead);
    if (bytesRead === 0) return 0;
    if (isBinaryBuffer(data, bytesRead)) return null;
    let lines = 0;
    for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, i + 1)) lines += 1;
    return data[bytesRead - 1] === 10 ? lines : lines + 1;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
