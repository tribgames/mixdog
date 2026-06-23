import { statSync, readdirSync } from 'fs';

/**
 * Return the maximum mtimeMs across all given paths.
 * Missing / unreadable paths are silently skipped (treated as mtime 0).
 * Pass file paths or directory paths; statSync on a directory returns the
 * mtime of the directory entry itself (updated when children are
 * added/removed), while file mtime covers content changes.
 * Use maxMtimeRecursive for cases where file-content edits within a
 * directory must also invalidate the cache (parent dir mtime is unchanged
 * on Linux/macOS when only a file's content changes).
 *
 * @param {string[]} paths
 * @returns {number}
 */
export function maxMtime(paths) {
    let max = 0;
    for (const p of paths) {
        try { const m = statSync(p).mtimeMs; if (m > max) max = m; } catch { /* missing — skip */ }
    }
    return max;
}

/**
 * Return the maximum mtimeMs across all given paths, recursing into
 * directories up to `depth` levels.  Only .md and .json files inside
 * directories contribute their own mtime (not the parent dir entry).
 * Plain file paths are stat'd directly regardless of extension.
 * Missing / unreadable paths are silently skipped.
 *
 * @param {string[]} paths
 * @param {number}   [depth=3]
 * @returns {number}
 */
export function maxMtimeRecursive(paths, depth = 3) {
    let max = 0;
    function walk(p, d) {
        let st;
        try { st = statSync(p); } catch { return; }
        if (st.isDirectory()) {
            if (d <= 0) return;
            let entries;
            try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const child = p + '/' + e.name;
                if (e.isDirectory()) {
                    walk(child, d - 1);
                } else if (e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.json'))) {
                    try { const m = statSync(child).mtimeMs; if (m > max) max = m; } catch {}
                }
            }
        } else {
            if (st.mtimeMs > max) max = st.mtimeMs;
        }
    }
    for (const p of paths) walk(p, depth);
    return max;
}
