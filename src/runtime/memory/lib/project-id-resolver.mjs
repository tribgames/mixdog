import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { explicitSessionCwd } from '../../shared/user-cwd.mjs';

/** @type {Map<string, string|null>} */
const cache = new Map();

/**
 * Walk up from `start`, returning the first directory whose
 * `.mixdog/project.id` file exists. Returns null if no ancestor has one.
 * Skips intermediate `.mixdog` directories that lack `project.id` so an
 * inner empty marker does not mask an outer valid one.
 * @param {string} start - absolute directory path
 * @returns {string|null} absolute path of the containing directory
 */
function findProjectIdRoot(start) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, '.mixdog', 'project.id'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/**
 * Resolve a project_id for the given working directory.
 *
 * Single source: .mixdog/project.id file in cwd or any ancestor directory.
 * Returns the file content (trimmed), or null if no file is found or the
 * content is "common" (case-insensitive).
 *
 * Removed: git origin parsing, gh CLI permission check, owner whitelist
 * branch, lazy .mixdog/project.id write. Those were multi-step heuristics
 * with no objective signal — project membership must be declared explicitly
 * via a .mixdog/project.id file.
 *
 * Result is memoized by the .mixdog root directory path.
 *
 * @param {string} cwd - absolute or relative working directory
 * @returns {string|null}
 */
export function resolveProjectId(cwd) {
  const absCwd = resolve(cwd);

  const mixdogRoot = findProjectIdRoot(absCwd);
  if (!mixdogRoot) return null;

  if (cache.has(mixdogRoot)) return cache.get(mixdogRoot);

  const idFile = join(mixdogRoot, '.mixdog', 'project.id');
  let content;
  try {
    content = readFileSync(idFile, 'utf8').trim();
  } catch {
    // TOCTOU: the file vanished between findProjectIdRoot's existsSync and
    // this read. Treat as no marker; do not cache so a transient miss can
    // recover on a later call.
    return null;
  }
  // "common" (case-insensitive) → forced COMMON
  if (content.toLowerCase() === 'common' || !content) {
    cache.set(mixdogRoot, null);
    return null;
  }

  cache.set(mixdogRoot, content);
  return content;
}

/**
 * Resolve a project_id for PROJECT CLASSIFICATION.
 *
 * Uses the explicitly-supplied cwd when provided; otherwise the explicit
 * session cwd (MIXDOG_SESSION_CWD / user-cwd.txt) via explicitSessionCwd().
 * Returns null (-> COMMON scope) when no explicit cwd exists. Never consults
 * process.cwd(): the server's launch dir is not a project signal and would
 * misclassify rows stored under the service/plugin cwd.
 *
 * @param {string|null|undefined} explicitCwd - caller-supplied cwd, if any
 * @returns {string|null}
 */
export function resolveProjectScope(explicitCwd) {
  const cwd = (typeof explicitCwd === 'string' && explicitCwd) ? explicitCwd : explicitSessionCwd();
  return cwd ? resolveProjectId(cwd) : null;
}
