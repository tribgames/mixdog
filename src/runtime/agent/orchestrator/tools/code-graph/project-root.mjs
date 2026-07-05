// Project-root sentinel resolution + empty-arg stripping. Extracted verbatim
// from code-graph.mjs. Used by the dispatcher to re-root file/dir queries.
import { resolve as pathResolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

// P1: project-root sentinels. A directory containing any of these (or with one
// at an ancestor) is treated as a real project we may index.
export const _PROJECT_ROOT_SENTINELS = ['package.json', '.git', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'build.sbt', 'Package.swift'];

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
export function _findDirProjectRoot(dir) {
  if (!dir) return null;
  let d = pathResolve(dir);
  while (d && d !== dirname(d)) {
    if (_PROJECT_ROOT_SENTINELS.some((s) => existsSync(join(d, s)))) return d;
    d = dirname(d);
  }
  return null;
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
