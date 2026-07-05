// Shared stat-tuple helpers used by all cache modules.
import { statSync } from 'node:fs';
import { resolve as resolvePath, isAbsolute, normalize } from 'node:path';

export function _normalizeAbs(path, cwd) {
    if (typeof path !== 'string' || path.length === 0) return null;
    const base = cwd && typeof cwd === 'string' ? cwd : process.cwd();
    const abs = isAbsolute(path) ? path : resolvePath(base, path);
    return _normalizeCacheKey(normalize(abs));
}

/**
 * Normalise a path string to a stable cache key:
 *   - Forward-slashes only (Windows backslash → /)
 *   - Strip trailing slash (except lone root "/")
 *   - Lowercase the drive letter on Windows ("C:/" → "c:/")
 * No realpath — symlinks are intentionally treated as distinct keys.
 */
export function _normalizeCacheKey(p) {
    if (typeof p !== 'string' || p.length === 0) return p;
    let s = p.replace(/\\/g, '/');
    // Lowercase Windows drive letter (e.g. "C:/" → "c:/")
    if (/^[A-Z]:\//.test(s)) s = s[0].toLowerCase() + s.slice(1);
    // Strip trailing slash unless it is the root itself
    if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
    return s;
}

export function _statTuple(absPath) {
    try {
        const st = statSync(absPath);
        return {
            mtimeMs: st.mtimeMs,
            size: st.size,
            ino: typeof st.ino === 'number' ? st.ino : Number(st.ino) || 0,
            dev: typeof st.dev === 'number' ? st.dev : Number(st.dev) || 0,
        };
    } catch {
        return null;
    }
}

export function _statEqual(a, b) {
    return !!a && !!b
        && a.mtimeMs === b.mtimeMs
        && a.size === b.size
        && a.ino === b.ino
        && a.dev === b.dev;
}
