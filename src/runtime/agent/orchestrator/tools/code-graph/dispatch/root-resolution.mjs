/**
 * root-resolution.mjs — which project root a single-project call indexes:
 * from its aggregate file anchors, from its one `file` anchor, or from the
 * cwd itself — refusing unbounded or ambiguous trees.
 */
import { resolve as pathResolve, isAbsolute, relative as pathRelative, basename as pathBasename } from 'node:path';
import { homedir as osHomedir } from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { toDisplayPath } from '../../builtin/path-utils.mjs';
import { findFileByBasename } from '../../builtin/path-diagnostics.mjs';
import {
  _PROJECT_ROOT_SENTINELS,
  _resolveFileProjectRoot,
  _findDirProjectRoot,
  _childProjectRoots,
} from '../project-root.mjs';
import { _isFilesystemRootPath } from '../trusted-roots.mjs';
import {
  _resolveAggregateFileProjectRoot,
  _boundedExactFileRoot,
  _boundedExactFileAggregateRoot,
  _relocateAggregateAnchorsUnderChildProject,
  _resolveBoundedSentinelFreeAggregateRootForTest,
  _absolutizeAggregateFileArgs,
} from '../aggregate-roots.mjs';
import { _absFrom } from './federation.mjs';

export function _isExistingDirectory(abs) {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

export const hasExplicitCwdArg = (args) => !!(args && typeof args.cwd === 'string' && args.cwd.trim());

/**
 * Aggregate anchors outside any project: the root every anchor shares, a
 * bounded sentinel-free tree, or the child project the anchors relocate into.
 * The bounded sentinel-free fallback is NOT conditioned on an explicit `cwd`
 * argument. The directory path already adopts a sentinel-free SINGLE tree as
 * its own root under exactly these bounds (not a filesystem root, not home, no
 * child project roots), so gating the files[] path on how the cwd arrived made
 * the stricter branch the one callers hit first: a working tree that is not a
 * repo (measured: `/app`) refused every files[]-anchored call while the same
 * tree indexed fine without anchors. The fallback itself still verifies every
 * anchor exists inside the base. An implicit cwd walks under the same
 * home/temp boundary the base-root resolution already uses; only an explicit
 * `cwd` may adopt a sentinel found there.
 */
export function resolveAggregateAnchorRoot(name, args, baseCwd, { explicitCwdArg }) {
  const aggregateRoot =
    _resolveAggregateFileProjectRoot(args, baseCwd, { stopAtUserBoundary: !explicitCwdArg }) ||
    _resolveBoundedSentinelFreeAggregateRootForTest(args, baseCwd) ||
    _boundedExactFileAggregateRoot(args, baseCwd);
  const relocated = aggregateRoot ? null : _relocateAggregateAnchorsUnderChildProject(args, baseCwd);
  if (!aggregateRoot && !relocated) {
    // Name the projects that DO sit under this cwd: the refusal is only
    // actionable if the caller learns where to anchor instead.
    const candidates = _childProjectRoots(baseCwd, { cap: 5 })
      .filter((root) => pathResolve(root) !== pathResolve(baseCwd))
      .map((root) => `"${pathBasename(root)}"`);
    throw new Error(
      `${name}: cwd '${baseCwd}' is not inside a project and aggregate file anchors do not all ` +
        `exist under exactly one detectable project root. Refusing to index an arbitrary tree.` +
        (candidates.length
          ? ` Project roots under this cwd: ${candidates.join(', ')} — anchor the call inside one of them.`
          : '')
    );
  }
  return {
    effectiveCwd: relocated ? relocated.root : aggregateRoot,
    args: _absolutizeAggregateFileArgs(relocated ? relocated.args : args, baseCwd),
  };
}

/**
 * One `file` anchor: an error string when it does not exist, otherwise the
 * root it re-homes the call to (null keeps the current cwd).
 */
export function resolveFileAnchorRoot(name, args, fileArg, baseCwd) {
  const abs = _absFrom(baseCwd, fileArg);
  if (!existsSync(abs)) {
    const elsewhere = findFileByBasename(pathResolve(baseCwd), abs);
    const hint = elsewhere.length
      ? ` Same filename exists at: ${elsewhere.map((p) => `"${toDisplayPath(p, baseCwd).replace(/\\/g, '/')}"`).join(', ')}. Use that path.`
      : '';
    return { error: `Error: ${name}: file not found: ${fileArg}${hint}` };
  }
  const rel = pathRelative(pathResolve(baseCwd), abs);
  const insideCwd = rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
  if (insideCwd || hasExplicitCwdArg(args)) return { root: null };
  // Implicit walk, so it stops at the home/temp boundary like every other
  // guessed root: without that, a loose file under %TEMP% adopts a stray
  // home-directory package.json and indexes the whole user profile.
  const fileArgIsDirectory = _isExistingDirectory(abs);
  const fileRoot =
    (fileArgIsDirectory
      ? _findDirProjectRoot(abs, { stopAtUserBoundary: true })
      : _resolveFileProjectRoot(abs, { stopAtUserBoundary: true })) ||
    (fileArgIsDirectory ? null : _boundedExactFileRoot(abs));
  if (!fileRoot) {
    throw new Error(
      `find_symbol: file '${fileArg}' is outside cwd '${baseCwd}' and has no detectable project root (no package.json/.git ancestor). Provide an explicit cwd.`
    );
  }
  return { root: fileRoot };
}

/**
 * No anchor and no explicit cwd: the enclosing project root, or the cwd
 * itself when it is a bounded sentinel-free single tree. A sentinel-free
 * SINGLE tree (vendored reference checkout, script folder) indexes as its own
 * root — the same treatment an explicit 'cwd' argument already gets. Only
 * genuinely unbounded or ambiguous targets stay refused: a filesystem root,
 * the home directory, or a parent holding several separate repositories.
 */
export function resolveDirectoryRoot(name, effectiveCwd, { filesystemRootCwd }) {
  const projectRoot = _findDirProjectRoot(effectiveCwd, { stopAtUserBoundary: true });
  if (projectRoot) return projectRoot;
  const childRoots = _childProjectRoots(effectiveCwd);
  // Non-null only when the sole sentinel sits at/above the home or temp
  // boundary — name it, so the refusal reads as a deliberate rule rather
  // than a missing project.
  const boundaryRoot = _findDirProjectRoot(effectiveCwd);
  const unbounded =
    filesystemRootCwd || _isFilesystemRootPath(effectiveCwd) || pathResolve(effectiveCwd) === pathResolve(osHomedir());
  if (!unbounded && childRoots.length <= 1) return effectiveCwd;
  const listed = childRoots
    .slice(0, 5)
    .map((root) => `"${pathBasename(root)}"`)
    .join(', ');
  throw new Error(
    `${name}: cwd '${effectiveCwd}' is not inside a project (no ` +
      `${_PROJECT_ROOT_SENTINELS.join('/')} at it or any ancestor)` +
      `${childRoots.length > 1 ? ` and holds ${childRoots.length} separate project roots (${listed})` : ''}. ` +
      `${boundaryRoot ? `The nearest sentinel is at '${boundaryRoot}' (home/temp), which is never auto-adopted. ` : ''}` +
      `Refusing to index an arbitrary tree. Run 'cwd set <repo>', or pass an explicit ` +
      `'cwd' (repo root) or a 'file' anchor.`
  );
}
