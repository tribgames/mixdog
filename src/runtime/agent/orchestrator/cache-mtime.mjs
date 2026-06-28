import { statSync, readdirSync } from 'fs';

/**
 * Return the maximum mtimeMs across all given paths, recursing into
 * directories up to `depth` levels. Directory entries contribute their own
 * mtime so child add/remove events invalidate caches. Only .md and .json files
 * inside directories contribute file mtimes.
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
            if (st.mtimeMs > max) max = st.mtimeMs;
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
