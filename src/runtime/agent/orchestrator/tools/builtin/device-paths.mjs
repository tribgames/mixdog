// G6: device path block list (Claude Code parity). Reading these paths
// would either hang (waiting for stdin / tty) or produce infinite output
// (/dev/zero, /dev/random). The device block list catches pseudo-files on
// POSIX hosts that a user-allowed path can still hit.
const BLOCKED_DEVICE_PATHS = new Set([
    '/dev/zero', '/dev/random', '/dev/urandom', '/dev/full',
    '/dev/stdin', '/dev/tty', '/dev/console',
    '/dev/stdout', '/dev/stderr',
    '/dev/fd/0', '/dev/fd/1', '/dev/fd/2',
]);

export function isBlockedDevicePath(p) {
    if (BLOCKED_DEVICE_PATHS.has(p)) return true;
    // /proc/self/fd/0-2 and /proc/<pid>/fd/0-2 are Linux aliases for stdio.
    if (typeof p === 'string' && p.startsWith('/proc/')
        && (p.endsWith('/fd/0') || p.endsWith('/fd/1') || p.endsWith('/fd/2'))) return true;
    return false;
}

// R1: UNC / SMB share paths (\\server\share or //server/share). Reading these
// causes Windows to auto-authenticate to the remote host, leaking the NTLM
// hash of the current user to any attacker-controlled SMB target. CC parity:
// FileReadTool.ts:461 rejects the same prefix before stat. Accepts both
// backslash and forward-slash leaders so a normalize that picked either form
// is caught.
export function isUncPath(p) {
    if (typeof p !== 'string' || p.length < 2) return false;
    return (p[0] === '\\' && p[1] === '\\') || (p[0] === '/' && p[1] === '/');
}

// R2: Windows reserved device basenames (CON, NUL, PRN, AUX, COM0-9, LPT0-9)
// and raw-device namespace prefixes (\\.\ DosDevices, \\?\ NT namespace).
// CON/NUL etc. are kernel-level aliases that never resolve to real files
// when used as bare names; \\.\PhysicalDrive0 / \\.\CON allow raw device
// access. Basenames with a real extension (nul.bin) are ordinary files.
const WIN_RESERVED_BASENAMES = new Set([
    'CON', 'NUL', 'PRN', 'AUX',
    // CONIN$ / CONOUT$ are the console input/output device aliases; the
    // trailing '$' is part of the name and survives stem extraction
    // (cut happens at the first '.'/':' only).
    'CONIN$', 'CONOUT$',
    'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
    // Win32 normalizes the Latin-1 superscript digits ¹ (U+00B9), ²
    // (U+00B2), ³ (U+00B3) to 1/2/3 when resolving device names, so
    // COM¹/COM²/COM³ and LPT¹/LPT²/LPT³ open the real COM1-3/LPT1-3
    // devices. toUpperCase() leaves these codepoints unchanged, so they
    // must be listed literally.
    'COM\u00B9', 'COM\u00B2', 'COM\u00B3',
    'LPT\u00B9', 'LPT\u00B2', 'LPT\u00B3',
]);
export function isWindowsDevicePath(p) {
    if (typeof p !== 'string' || p.length === 0) return false;
    // \\.\ and \\?\ raw-device / DOS-device namespace (both slash forms).
    if (p.startsWith('\\\\.\\') || p.startsWith('\\\\?\\')) return true;
    if (p.startsWith('//./') || p.startsWith('//?/')) return true;
    // Reserved basenames (CON/NUL/PRN/AUX/COM*/LPT*) are device aliases ONLY on
    // Windows; on POSIX a file literally named `con.txt` is a normal regular
    // file. Gate the basename check to win32 so non-Windows reads of such names
    // aren't false-rejected (the \\.\ / \\?\ namespace checks above stay
    // unconditional). reviewer-flagged false positive.
    if (process.platform !== 'win32') return false;
    // Basename match, case-insensitive, extension-stripped. R12: splitting
    // on '.' alone missed NTFS ADS suffixes (NUL:stream, CON:stream) and
    // trailing Win32-ignored dots/spaces ("CON. ", "NUL. ") that the
    // kernel still resolves to the reserved device. Compute the stem by
    // cutting at the FIRST '.' or ':' in the basename, then stripping
    // any trailing dots/spaces that Win32 silently drops.
    const lastSep = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    const base = lastSep >= 0 ? p.slice(lastSep + 1) : p;
    let cut = base.length;
    for (let i = 0; i < base.length; i += 1) {
        const ch = base.charCodeAt(i);
        if (ch === 0x2E /* . */ || ch === 0x3A /* : */) { cut = i; break; }
    }
    let stem = base.slice(0, cut);
    // R14: strip Unicode invisibles (BOM, zero-width joiners, bidi controls)
    // BEFORE the trailing-dot / reserved-name checks. Win32 GetFinalPathName
    // and a number of file APIs collapse / ignore these characters when
    // opening, so "CON\u200B" or "\uFEFFCON" can resolve to the CON device
    // even though byte-comparison says "not reserved". Drop them defensively.
    stem = stem.replace(/[\uFEFF\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '');
    // Strip trailing dots / spaces — Win32 ignores them when opening a
    // file, so "CON. " and "CON " resolve to CON. Loop instead of regex
    // to keep allocation-free hot path.
    let end = stem.length;
    while (end > 0) {
        const ch = stem.charCodeAt(end - 1);
        if (ch === 0x2E /* . */ || ch === 0x20 /* SP */) { end -= 1; continue; }
        break;
    }
    stem = stem.slice(0, end).toUpperCase();
    if (!WIN_RESERVED_BASENAMES.has(stem)) return false;
    // Bare device alias only (NUL, CON, …). A dotted extension means a normal
    // file even when the stem matches a reserved name (dir/nul.bin).
    return cut >= base.length;
}

// R12: Win32 path-component guard. Rejects any path component that
// (a) ends in '.' or ' ' — Win32 silently strips trailing dots/spaces
// when opening, so the kernel resolves a DIFFERENT path than the one
// the guard sees, bypassing string-based device/UNC checks; or
// (b) contains ':' after the optional `<drive>:` prefix — colon inside
// a component names an NTFS Alternate Data Stream (e.g. `file.txt:hidden`),
// which is a hidden writable channel attached to another file.
// Legitimate Windows filenames never have trailing dot/space or embedded
// ':' in any component, so unconditional rejection is safe.
export function hasUnsafeWin32Component(p) {
    if (process.platform !== 'win32') return false;
    if (typeof p !== 'string' || p.length === 0) return false;
    // Strip optional drive prefix (`C:` / `c:`) so the drive colon is not
    // mistaken for an ADS marker. \\.\ / \\?\ raw-device prefixes are
    // already rejected by isWindowsDevicePath; treat their bytes as
    // ordinary components here so a `\\?\C:\foo:stream` still trips.
    let rest = p;
    if (rest.length >= 2 && rest.charCodeAt(1) === 0x3A /* : */
        && ((rest.charCodeAt(0) >= 0x41 && rest.charCodeAt(0) <= 0x5A)
            || (rest.charCodeAt(0) >= 0x61 && rest.charCodeAt(0) <= 0x7A))) {
        rest = rest.slice(2);
    }
    // Split on both Win32 separators.
    const parts = rest.split(/[\\/]+/);
    for (const rawPart of parts) {
        if (!rawPart) continue;
        // R14: strip Unicode invisibles (BOM, zero-width joiners, bidi controls)
        // BEFORE the trailing-dot / ADS-colon checks. Win32 ignores these
        // characters in many path-open codepaths, so "foo \u200B" (trailing
        // space + ZWSP) or "name\uFEFF:stream" must still trip the guard.
        const part = rawPart.replace(/[\uFEFF\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '');
        if (!part) continue;
        // `.` and `..` are the standard current/parent-dir components — they end
        // in '.' but are NOT a trailing-dot bypass, so exempt them (without this
        // a default relative path like "." or "src/.." is rejected on Windows).
        // Any other trailing dot/space is still unsafe.
        if (part === '.' || part === '..') continue;
        const last = part.charCodeAt(part.length - 1);
        if (last === 0x2E /* . */ || last === 0x20 /* SP */) return true;
        if (part.indexOf(':') >= 0) return true;
    }
    return false;
}

// R2: Stat-based special-file reject. FIFOs, character devices, block devices,
// and sockets pass a normal statSync but reading them either hangs (FIFO with
// no writer, socket) or produces unbounded output (/dev/zero, /dev/random).
// Must be called AFTER statSync (or fstatSync) — the string-based device
// guard catches well-known paths, this catches arbitrary user paths that
// happen to point at a special inode (custom mknod, symlink targets, etc.).
export function isSpecialFileStat(st) {
    if (!st || typeof st !== 'object') return false;
    try {
        return st.isFIFO() || st.isCharacterDevice() || st.isBlockDevice() || st.isSocket();
    } catch { return false; }
}
