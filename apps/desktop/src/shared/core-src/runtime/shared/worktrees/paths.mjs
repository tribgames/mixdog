/**
 * Canonical path helpers for managed worktrees. Git reports paths with forward
 * slashes, long names and resolved symlinks while callers may hold 8.3 short
 * names, other casing (Windows) or symlinked parents (macOS /var). Every
 * comparison and every lock key goes through these.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** `resolve` plus the real path of the nearest existing ancestor. */
export function canonicalPath(value) {
  const full = resolve(String(value || '.'));
  let head = full;
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return full;
    head = parent;
  }
  let real;
  try {
    real = realpathSync.native(head);
  } catch {
    return full;
  }
  const rest = relative(head, full);
  return rest ? join(real, rest) : real;
}

/** Comparison key: canonical, case-insensitive on Windows. */
export function pathKey(value, platform = process.platform) {
  const path = canonicalPath(value).replace(/[\\/]+$/, '') || sep;
  return platform === 'win32' ? path.toLowerCase() : path;
}

export function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

/** True when `child` is `parent` itself or lies inside it (canonical). */
export function isWithin(parent, child) {
  const base = pathKey(parent);
  const target = pathKey(child);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Repository-relative folder of a Project registered below the repository
 * root ('' for the root itself or anything outside it), with forward slashes.
 * A session of that Project executes in the same folder of its worktree.
 * @param {string|null|undefined} topLevel
 * @param {string|null|undefined} projectPath
 */
export function projectSubdirOf(topLevel, projectPath) {
  if (!topLevel || !projectPath || !isWithin(topLevel, projectPath)) return '';
  const rel = relative(canonicalPath(topLevel), canonicalPath(projectPath));
  return !rel || rel.startsWith('..') || isAbsolute(rel) ? '' : rel.split(sep).join('/');
}

/** `subdir` (forward slashes, from projectSubdirOf) inside `root`. */
export function checkoutFolder(root, subdir) {
  return subdir ? join(root, ...subdir.split('/')) : root;
}
