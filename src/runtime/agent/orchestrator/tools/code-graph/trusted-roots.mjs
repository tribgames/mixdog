import { statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { listProjects } from '../../../../../standalone/projects.mjs';
import {
  explicitSessionCwd,
  readLastSessionCwd,
} from '../../../../shared/user-cwd.mjs';
import { listCachedCodeGraphRoots } from './disk-cache.mjs';
import { _findDirProjectRoot } from './project-root.mjs';

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function _isFilesystemRootPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  // A bare drive designator is drive-relative on Windows. Guard it before
  // resolve(), which may expand C: to that drive's active directory (even C:\).
  if (/^[a-zA-Z]:$/.test(raw)) return false;
  // Keep this platform-neutral so Windows drive-root semantics can also be
  // regression-tested on Unix hosts.
  if (/^[a-zA-Z]:[\\/]$/.test(raw)) return true;
  try {
    const abs = resolve(raw);
    return dirname(abs) === abs;
  } catch {
    return false;
  }
}

function pathKey(path) {
  const abs = resolve(path);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function _pathIsWithin(root, candidate) {
  try {
    const rel = relative(resolve(root), resolve(candidate));
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

/**
 * Return live, non-root graph targets from explicit registrations, current /
 * recent session selection, and cache manifests. Dependencies are injectable
 * to keep trust-source and Windows/Unix semantics tests hermetic.
 */
export function collectTrustedCodeGraphRoots(filesystemRoot, {
  registered = () => listProjects().map((entry) => entry.path),
  selected = () => [
    explicitSessionCwd(),
    readLastSessionCwd(),
  ],
  cached = listCachedCodeGraphRoots,
  directory = isDirectory,
  projectRoot = _findDirProjectRoot,
} = {}) {
  const root = resolve(filesystemRoot);
  const rows = [
    ...registered().map((path) => ({ path, detect: false })),
    ...selected().map((path) => ({ path, detect: true })),
    ...cached().map((path) => ({ path, detect: false })),
  ];
  const found = new Map();
  for (const row of rows) {
    if (!row.path) continue;
    let candidate;
    try { candidate = resolve(row.path); } catch { continue; }
    if (!directory(candidate) || _isFilesystemRootPath(candidate) || !_pathIsWithin(root, candidate)) continue;
    // A selected directory inside a sentinel project belongs to the nearest
    // project graph. Explicit registrations and cache keys remain exact roots
    // so registered non-sentinel projects are retained.
    const detected = row.detect ? projectRoot(candidate) : null;
    if (detected) candidate = resolve(detected);
    if (_isFilesystemRootPath(candidate) || !directory(candidate) || !_pathIsWithin(root, candidate)) continue;
    const key = pathKey(candidate);
    if (!found.has(key)) found.set(key, candidate);
  }
  return [...found.values()].sort((a, b) => a.localeCompare(b));
}

export function owningTrustedCodeGraphRoot(file, roots) {
  const matches = (roots || []).filter((root) => _pathIsWithin(root, file));
  matches.sort((a, b) => resolve(b).length - resolve(a).length);
  return matches[0] || null;
}

export function formatFederatedProjectLabel(root) {
  return `${basename(root) || root} [${root}]`;
}
