// Root handling shared by the list/tree and find tools: the root stat and
// root-relative entry path rendering.
import { stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { normalizeOutputPath } from './path-utils.mjs';
import { normalizeErrorMessage } from './path-diagnostics.mjs';
import { statCacheSet } from './cache-layers.mjs';
import { assertPathReachable } from './fs-reachability.mjs';
import { readFamilyPathEnoentOrError } from './lib/list-helpers.mjs';

export function toolErrorText(error) {
  return `Error: ${normalizeErrorMessage(error instanceof Error ? error.message : String(error))}`;
}

// The root of a walk: reachable, then stat'd once — the reachability
// preflight's stat feeds the cache so the root is not immediately re-stat'd
// by getCachedReadOnlyStat. A missing or unreadable root is the tool's
// answer (`error`), not an exception.
export async function statWalkRoot(fullPath, workDir, inputPath) {
  let preStat;
  try {
    preStat = await assertPathReachable(fullPath);
  } catch (error) {
    return { error: toolErrorText(error) };
  }
  if (preStat) statCacheSet(fullPath, preStat);
  try {
    const rootStat = preStat || (await stat(fullPath));
    if (!preStat) statCacheSet(fullPath, rootStat);
    return { stat: rootStat };
  } catch (error) {
    return { error: await readFamilyPathEnoentOrError(workDir, fullPath, inputPath, error) };
  }
}

// Entry paths render relative to the listed root — the caller supplied the
// base via `path`, so repeating the absolute prefix on every row is pure
// duplication (~2KB per 80 rows). Falls back to the absolute form when the
// entry escapes the root (drive change / `..`), where a relative form would
// be ambiguous. Cache-safe: keys already include the absolute root, and the
// rendered rows no longer depend on the session workDir.
export function displayRelPath(entPath, rootPath) {
  const rel = relative(rootPath, entPath);
  if (!rel || rel === '.' || rel.startsWith('..') || /^[A-Za-z]:/.test(rel)) {
    return normalizeOutputPath(entPath);
  }
  return normalizeOutputPath(rel);
}
