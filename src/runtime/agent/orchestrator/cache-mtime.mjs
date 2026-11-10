import { createHash } from 'node:crypto';
import { statSync, readdirSync } from 'node:fs';

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
  walkMtimes(paths, depth, (_p, m) => {
    if (m > max) max = m;
  });
  return max;
}

/**
 * Exact change signature over the same walk as maxMtimeRecursive: every
 * stat'ed path with its own mtime, so any single path changing (even to an
 * older time) changes the result. Compare for equality only.
 *
 * @param {string[]} paths
 * @param {number}   [depth=3]
 * @returns {string}
 */
export function mtimeSignatureRecursive(paths, depth = 3) {
  return createHash('sha1').update(mtimeSignatureText(paths, depth)).digest('hex');
}

/**
 * The raw text mtimeSignatureRecursive hashes (`path:mtime` lines). Texts of
 * consecutive path groups joined with '\n' hash to the same signature as one
 * call over all of them, so a caller can reuse an unchanged group's text.
 */
export function mtimeSignatureText(paths, depth = 3) {
  const parts = [];
  walkMtimes(paths, depth, (p, m) => parts.push(`${p}:${m}`));
  return parts.join('\n');
}

function walkMtimes(paths, depth, visit) {
  function walk(p, d) {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      visit(p, st.mtimeMs);
      if (d <= 0) return;
      let entries;
      try {
        entries = readdirSync(p, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const child = `${p}/${e.name}`;
        if (e.isDirectory()) {
          walk(child, d - 1);
        } else if (e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.json'))) {
          try {
            visit(child, statSync(child).mtimeMs);
          } catch {
            /* unreadable entry: skipped like a missing path */
          }
        }
      }
    } else {
      visit(p, st.mtimeMs);
    }
  }
  for (const p of paths) walk(p, depth);
}
