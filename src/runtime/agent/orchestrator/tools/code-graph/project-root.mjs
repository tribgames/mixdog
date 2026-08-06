// Project-root sentinel resolution + empty-arg stripping. Extracted verbatim
// from code-graph.mjs. Used by the dispatcher to re-root file/dir queries.
import { resolve as pathResolve, dirname, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

// P1: project-root sentinels. A directory containing any of these (or with one
// at an ancestor) is treated as a real project we may index.
export const _PROJECT_ROOT_SENTINELS = ['package.json', '.git', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'build.sbt', 'Package.swift'];

// Directories an IMPLICIT ancestor walk must never cross. A stray npm
// `package.json` in the home directory (or in the temp root) would otherwise
// promote "index this folder" into "index the whole user profile" — observed
// as a 20s graph-binary timeout on a `%TEMP%` path. Explicit targets (a `cwd`
// argument, `cwd set`, a registered project) are unaffected: only the walk
// that guesses a root for the caller stops here.
function _userBoundaryDirs() {
  const dirs = [];
  try { dirs.push(homedir()); } catch { /* no home — nothing to guard */ }
  try { dirs.push(tmpdir()); } catch { /* no temp — nothing to guard */ }
  return dirs.filter(Boolean);
}

function _dirKey(dir) {
  const resolved = pathResolve(dir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// P1: resolve a file to its nearest project root (sentinel ancestor).
// Returns null when no root found; caller throws rather than falling back.
export function _resolveFileProjectRoot(file) {
  if (!file) return null;
  const abs = pathResolve(file);
  let dir = dirname(abs);
  while (dir && dir !== dirname(dir)) {
    if (_PROJECT_ROOT_SENTINELS.some((s) => existsSync(join(dir, s)))) return dir;
    dir = dirname(dir);
  }
  return null;
}

// P1: nearest project root for a DIRECTORY (the dir itself or any ancestor).
// Returns null when the dir sits in no project.
// `stopAtUserBoundary` marks the walk as implicit: it then returns null at the
// home/temp boundary instead of adopting whatever sentinel happens to sit
// there. `boundaries` is injectable so the boundary rule stays testable.
export function _findDirProjectRoot(dir, { stopAtUserBoundary = false, boundaries = null } = {}) {
  if (!dir) return null;
  const stops = stopAtUserBoundary
    ? new Set((boundaries || _userBoundaryDirs()).map(_dirKey))
    : null;
  let d = pathResolve(dir);
  while (d && d !== dirname(d)) {
    if (stops && stops.has(_dirKey(d))) return null;
    if (_PROJECT_ROOT_SENTINELS.some((s) => existsSync(join(d, s)))) return d;
    d = dirname(d);
  }
  return null;
}

// Immediate child directories that are themselves project roots. Separates a
// sentinel-free SINGLE tree (a vendored reference checkout — indexable as its
// own root) from a multi-repo PARENT (ambiguous — indexing it would walk
// unrelated trees). Capped: the caller only needs "none/one" vs "many".
export function _childProjectRoots(dir, { cap = 32 } = {}) {
  if (!dir) return [];
  let entries;
  try { entries = readdirSync(pathResolve(dir), { withFileTypes: true }); }
  catch { return []; }
  const roots = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const child = join(pathResolve(dir), entry.name);
    if (_PROJECT_ROOT_SENTINELS.some((s) => existsSync(join(child, s)))) roots.push(child);
    if (roots.length >= cap) break;
  }
  return roots;
}

// MCP clients sometimes inject empty-string defaults for optional schema
// fields (e.g. `file: ""`). Strip empty/null optional path-like fields before
// dispatch so a literal "" doesn't trip the "file not found in graph" path.
export function _stripEmptyArgs(args) {
  const a = { ...(args || {}) };
  for (const k of ['file', 'language']) {
    if (a[k] === '' || a[k] === null) delete a[k];
  }
  return a;
}
