import { existsSync } from 'node:fs';
import { dirname, join, resolve as pathResolve } from 'node:path';

export const codeGraphCache = new Map();
export const codeGraphDirtyPaths = new Map();

const codeGraphDirtyGen = new Map();
let drainCodeGraphCacheFn = null;

export function canonicalGraphCwd(cwd) {
  if (!cwd) throw new Error('code_graph requires cwd - caller did not provide a working directory');
  const full = pathResolve(cwd);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

export function canonicalGraphPath(p) {
  const full = pathResolve(String(p || ''));
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

export function getCodeGraphGen(graphCwd) {
  return codeGraphDirtyGen.get(graphCwd) || 0;
}

export function bumpCodeGraphGen(graphCwd) {
  codeGraphDirtyGen.set(graphCwd, (codeGraphDirtyGen.get(graphCwd) || 0) + 1);
}

export function consumeCodeGraphDirtyPaths(cwd) {
  const key = canonicalGraphCwd(cwd);
  const set = codeGraphDirtyPaths.get(key);
  if (!set || set.size === 0) return [];
  codeGraphDirtyPaths.delete(key);
  return [...set];
}

// Accept absolute written paths only; resolve affected indexed roots centrally.
export function markCodeGraphDirtyPaths(paths) {
  const values = Array.isArray(paths) ? paths : [paths];
  const cleaned = values
    .filter(Boolean)
    .map((p) => canonicalGraphPath(p));
  if (cleaned.length === 0) return;

  const knownRoots = new Set([...codeGraphDirtyPaths.keys(), ...codeGraphCache.keys()]);
  const affectedRoots = new Set();
  for (const absPath of cleaned) {
    let matchedThisPath = false;
    for (const root of knownRoots) {
      const canonRoot = canonicalGraphPath(root);
      if (absPath.startsWith(canonRoot + '/') || absPath.startsWith(canonRoot + '\\') || absPath === canonRoot) {
        affectedRoots.add(root);
        matchedThisPath = true;
      }
    }
    if (!matchedThisPath) {
      let dir = dirname(absPath);
      while (dir && dir !== dirname(dir)) {
        if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, '.git'))) {
          affectedRoots.add(canonicalGraphCwd(dir));
          break;
        }
        dir = dirname(dir);
      }
    }
  }

  for (const root of affectedRoots) {
    if (!codeGraphDirtyPaths.has(root)) codeGraphDirtyPaths.set(root, new Set());
    const set = codeGraphDirtyPaths.get(root);
    for (const p of cleaned) set.add(p);

    const canonRoot = canonicalGraphCwd(root);
    codeGraphCache.delete(canonRoot);
    bumpCodeGraphGen(canonRoot);
  }
}

export function registerCodeGraphDrain(fn) {
  drainCodeGraphCacheFn = typeof fn === 'function' ? fn : null;
}

export function drainCodeGraphCache() {
  if (!drainCodeGraphCacheFn) return;
  drainCodeGraphCacheFn();
}
