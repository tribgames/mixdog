// One ranking rule for project paths, used by the main-process file search and
// by the renderer (Recent rows, matched-character highlighting). Folders are
// paths ending in `/`; they rank exactly like files.

export interface FileMatch {
  /** 0 is the best match. */
  tier: number;
  /** The matched characters are `path.slice(start, end)`. */
  start: number;
  end: number;
}

/** Case-insensitive, `/`-separated form of what the user typed. */
export function normalizeFileQuery(query: string): string {
  return query.trim().replace(/\\/g, '/').toLowerCase();
}

function startsWord(entry: string, index: number): boolean {
  const before = entry[index - 1];
  if (before === '-' || before === '_' || before === '.' || before === ' ') return true;
  // A camelCase hump: an upper-case letter right after a lower-case one.
  const character = entry[index];
  return character !== character.toLowerCase() && before !== before.toUpperCase();
}

/** Best tier first:
 *  0 the name equals the query (or does without its extension),
 *  1 the name starts with it,
 *  2 it starts a word inside the name (after `-` `_` `.` space, or a camelCase hump),
 *  3 the name contains it,
 *  4 a path segment starts with it,
 *  5 the path contains it.
 *  Scattered letters never match. An empty query matches everything at tier 0. */
export function matchFile(path: string, query: string): FileMatch | null {
  const needle = normalizeFileQuery(query);
  if (!needle) return { tier: 0, start: 0, end: 0 };
  const entry = path.endsWith('/') ? path.slice(0, -1) : path;
  const lower = entry.toLowerCase();
  const base = entry.lastIndexOf('/') + 1;
  const name = lower.slice(base);
  const hit = (tier: number, start: number): FileMatch => ({ tier, start, end: start + needle.length });

  const dot = name.lastIndexOf('.');
  if (name === needle || (dot > 0 && name.slice(0, dot) === needle)) return hit(0, base);
  if (name.startsWith(needle)) return hit(1, base);
  for (let index = 1; index < name.length; index += 1) {
    if (name.startsWith(needle, index) && startsWord(entry, base + index)) return hit(2, base + index);
  }
  const inName = name.indexOf(needle);
  if (inName >= 0) return hit(3, base + inName);
  for (let index = 0; index < lower.length; index += 1) {
    if ((index === 0 || lower[index - 1] === '/') && lower.startsWith(needle, index)) return hit(4, index);
  }
  const inPath = lower.indexOf(needle);
  return inPath >= 0 ? hit(5, inPath) : null;
}

function segmentCount(path: string): number {
  return path.split('/').length - (path.endsWith('/') ? 1 : 0);
}

/** Sort order of matches: tier, then fewer path segments, then the shorter
 *  path, then alphabetical. */
export function compareFileMatches(
  left: { path: string; match: FileMatch },
  right: { path: string; match: FileMatch }
): number {
  return (
    left.match.tier - right.match.tier ||
    segmentCount(left.path) - segmentCount(right.path) ||
    left.path.length - right.path.length ||
    left.path.localeCompare(right.path)
  );
}
