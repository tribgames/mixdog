import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';

export const comparablePath = (path: string): string =>
  process.platform === 'win32' ? path.toLocaleLowerCase() : path;

function canonicalPathThroughExistingAncestor(path: string): string {
  let existing = path;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing);
}

/** `path` is `root` or under it. A drive or filesystem root already ends in a
 *  separator, so none is appended to it. */
function isWithinRoot(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Traversal- and symlink-guarded absolute path for a project-relative entry. */
export function projectEntryPathIn(root: string, relPath: string): string {
  const absoluteRoot = resolve(root);
  const rel = String(relPath || '').replace(/\\/g, '/');
  const target = resolve(absoluteRoot, rel);
  if (!isWithinRoot(absoluteRoot, target)) {
    throw new Error('Path is outside the project.');
  }
  const canonicalRoot = realpathSync(absoluteRoot);
  const canonicalTarget = canonicalPathThroughExistingAncestor(target);
  if (!isWithinRoot(comparablePath(canonicalRoot), comparablePath(canonicalTarget))) {
    throw new Error('Path resolves outside the project.');
  }
  return target;
}
