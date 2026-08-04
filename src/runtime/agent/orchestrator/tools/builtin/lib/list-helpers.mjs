import {
    buildNotFoundHint,
    finalizeReadFamilyEnoentTail,
    tryReadFamilyEnoentRedirect,
} from '../search-path-diagnostics.mjs';
import { normalizeErrorMessage } from '../path-diagnostics.mjs';
import { isUncPath, isWindowsDevicePath, hasUnsafeWin32Component } from '../device-paths.mjs';
import { normalizeOutputPath } from '../path-utils.mjs';

/** undefined / invalid / negative → defaultCap; 0 = no page cap (absolute caps still apply). */
export async function readFamilyPathEnoentOrError(workDir, fullPath, inputPath, args, options, err, rerunTool) {
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
export function listGuardPath(p) {
    if (typeof isUncPath === 'function' && isUncPath(p))
        return `Error: cannot walk UNC / SMB path (network credential leak risk): ${normalizeOutputPath(p)}`;
    if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(p))
        return `Error: cannot walk Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(p)}`;
    if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(p))
        return `Error: cannot walk Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(p)}`;
    return null;
}
