/**
 * read-single-guards.mjs — what a single Read may open. The string-based
 * path guards (UNC / Windows device / NTFS ADS / blocked device), the
 * stat-time guards (directory, special inode, symlink target) and the
 * not-found answer. Every guard yields the exact tool response or null;
 * none of them opens a body.
 */
import * as fsPromises from 'node:fs/promises';
import { buildNotFoundHint, finalizeReadFamilyEnoentTail } from './search-path-diagnostics.mjs';

const GUARD_REASON = {
  // R1: UNC / SMB share (\\server\share, //server/share). Reading these on
  // Windows auto-authenticates to the remote host and leaks the NTLM hash of
  // the current user to any attacker-controlled SMB target.
  unc: (via) => `cannot read UNC / SMB path${via} (network credential leak risk)`,
  // R2: Windows reserved device names (CON / NUL / PRN / AUX / COM[0-9] /
  // LPT[0-9]) and raw-device namespaces (\\.\ and \\?\) — kernel aliases that
  // never resolve to real files and can hang or grant raw device access.
  device: (via) => `cannot read Windows device path${via} (reserved name or raw-device namespace)`,
  // R12: a trailing dot/space or embedded ':' in any component lets Win32
  // silently resolve to a different file or an NTFS Alternate Data Stream,
  // bypassing the string-based device/UNC checks.
  ads: () => 'cannot read Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard)',
  // G6: device pseudo-files would hang / produce infinite output.
  blocked: (via) => `cannot read device file${via} (would block or produce infinite output)`,
  // R2: FIFOs, char/block devices and sockets pass a normal stat but reading
  // them hangs (FIFO with no writer, socket) or never ends (/dev/zero).
  special: (via) => `cannot read special file${via} (FIFO / character / block device / socket)`,
};

function guardResponse(kind, helpers, shownPath, symlinkTarget) {
  const { normalizeOutputPath } = helpers;
  const shown = symlinkTarget
    ? `${normalizeOutputPath(shownPath)} → ${normalizeOutputPath(symlinkTarget)}`
    : normalizeOutputPath(shownPath);
  return `Error: ${GUARD_REASON[kind](symlinkTarget ? ' via symlink' : '')}: ${shown}`;
}

// Shared by the caller-supplied and the cwd-resolved path; order is UNC,
// device, ADS. Optional helpers are skipped when the caller did not wire them.
function stringPathGuard(path, helpers) {
  const { isUncPath, isWindowsDevicePath, hasUnsafeWin32Component } = helpers;
  if (typeof isUncPath === 'function' && isUncPath(path)) return guardResponse('unc', helpers, path);
  if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(path)) {
    return guardResponse('device', helpers, path);
  }
  if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(path)) {
    return guardResponse('ads', helpers, path);
  }
  return null;
}

/**
 * Caller-supplied path, checked before resolveAgainstCwd so a relative path
 * can't be coerced into a UNC share by the cwd resolution.
 */
export function readInputPathGuard(filePath, helpers) {
  const rejected = stringPathGuard(filePath, helpers);
  if (rejected) return rejected;
  return helpers.isBlockedDevicePath(filePath) ? guardResponse('blocked', helpers, filePath) : null;
}

/**
 * Re-check the resolved path: resolveAgainstCwd could have produced a UNC /
 * Windows device path even when the user-supplied string did not (rare, but
 * possible with a custom cwd containing a UNC root).
 */
export function readResolvedPathGuard(fullPath, helpers) {
  return stringPathGuard(fullPath, helpers);
}

async function directoryResponse(fullPath, filePath, helpers) {
  let entries = [];
  try {
    entries = (await fsPromises.readdir(fullPath, { withFileTypes: true }))
      .slice(0, 20)
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`);
  } catch {
    /* best-effort preview */
  }
  const preview = entries.length ? `\nentries:\n${entries.map((entry) => `- ${entry}`).join('\n')}` : '';
  return `Error: Directory: ${helpers.normalizeOutputPath(filePath)}. Use list/glob to inspect directories; read expects a file.${preview}`;
}

// A symlink → /dev/zero (or any other blocked device, UNC, or Windows
// reserved name) is caught on the REAL target, not the symlink name.
async function symlinkTargetGuard(fullPath, filePath, helpers) {
  const { isBlockedDevicePath, isUncPath, isWindowsDevicePath, isSpecialFileStat } = helpers;
  let realTarget = null;
  try {
    realTarget = await fsPromises.realpath(fullPath);
  } catch {
    realTarget = null;
  }
  if (!realTarget || realTarget === fullPath) return null;
  if (isBlockedDevicePath(realTarget)) return guardResponse('blocked', helpers, filePath, realTarget);
  if (typeof isUncPath === 'function' && isUncPath(realTarget)) {
    return guardResponse('unc', helpers, filePath, realTarget);
  }
  if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(realTarget)) {
    return guardResponse('device', helpers, filePath, realTarget);
  }
  // Re-run the special-file stat on the real target — the link stat was
  // already checked, but the target stat could differ in pathological cases
  // (replaced under us). A vanished target lets the normal path surface ENOENT.
  try {
    const targetStat = await fsPromises.stat(realTarget);
    if (typeof isSpecialFileStat === 'function' && isSpecialFileStat(targetStat)) {
      return guardResponse('special', helpers, filePath, realTarget);
    }
  } catch {}
  return null;
}

/**
 * Stat the resolved path and run every stat-time guard.
 * @returns {Promise<{ st: object } | { st: object, error: string } | { st: null, statErr: Error }>}
 *   `error` is the tool response that answers the read; `statErr` hands the
 *   similar-file / not-found answer to the caller.
 */
export async function statReadTarget(fullPath, filePath, options, helpers) {
  let st;
  try {
    st = options?._preflightStats?.get?.(fullPath) || (await fsPromises.stat(fullPath));
  } catch (statErr) {
    return { st: null, statErr };
  }
  if (st.isDirectory()) return { st, error: await directoryResponse(fullPath, filePath, helpers) };
  if (typeof helpers.isSpecialFileStat === 'function' && helpers.isSpecialFileStat(st)) {
    return { st, error: guardResponse('special', helpers, filePath) };
  }
  // lstat detects whether the entry IS a symlink first so realpath is only
  // called when it would actually differ — saves a syscall on the common
  // case. lstat failure is non-fatal; `st` stays authoritative.
  try {
    const lst = await fsPromises.lstat(fullPath);
    if (lst && typeof lst.isSymbolicLink === 'function' && lst.isSymbolicLink()) {
      const error = await symlinkTargetGuard(fullPath, filePath, helpers);
      if (error) return { st, error };
    }
  } catch {}
  return { st };
}

/**
 * A conclusive "no such path" is the ANSWER to the read, not a tool failure
 * (same policy as git's `repo:false`): the error envelope routed callers into
 * recovery mode for an ordinary absence probe. Genuine not-found only —
 * EACCES/EPERM etc. keep failure semantics.
 */
export function readNotFoundResponse(err, { fullPath, filePath, workDir }, helpers) {
  const { findSimilarFile, normalizeErrorMessage, normalizeOutputPath } = helpers;
  const similar = findSimilarFile(fullPath);
  let hint = similar
    ? ` Did you mean "${normalizeOutputPath(similar)}"?`
    : buildNotFoundHint(workDir, fullPath, 'Read', err?.code);
  hint = finalizeReadFamilyEnoentTail(hint, filePath, err?.code);
  const safeMsg = normalizeErrorMessage(err instanceof Error ? err.message : String(err), workDir);
  if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return `[path absent] ${safeMsg}${hint}`;
  return `Error: ${safeMsg}${hint}`;
}
