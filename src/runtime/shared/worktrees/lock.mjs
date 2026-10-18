/**
 * Repository mutation lock for managed worktree operations (create, checkout,
 * merge, remove, reconcile). Keyed by the canonical git common dir so the
 * main checkout and every linked worktree serialize:
 *   - in-process: the git tool's write lock on the whole repository, so no
 *     agent git write interleaves with a managed mutation (agent reads take no
 *     lock, so they neither wait for it nor delay it);
 *   - cross-process: a file lock under <dataDir>/worktrees-v1/<repoHash>.lock,
 *     shared by the runtime daemon and the desktop main process.
 * Re-entrant within one async call chain.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { withGitRepoWriteLock } from '../../agent/orchestrator/tools/builtin/git-repo-rw-lock.mjs';
import { withFileLock } from '../file-lock.mjs';
import { resolvePluginData } from '../plugin-paths.mjs';
import { repoHash, WORKTREE_STORE_DIR } from './contract.mjs';
import { canonicalPath, pathKey } from './paths.mjs';

const REPO_LOCK_TIMEOUT_MS = 120_000;
const heldRepoLocks = new AsyncLocalStorage();

/** Cross-process lock file for one repository (outside the removable root). */
function repoLockPath(repoCommonDir, { dataDir = resolvePluginData() } = {}) {
  return join(dataDir, WORKTREE_STORE_DIR, `${repoHash(canonicalPath(repoCommonDir))}.lock`);
}

/**
 * Run `fn` holding the repository's in-process and cross-process locks.
 * @template T
 * @param {string} repoCommonDir
 * @param {() => Promise<T>|T} fn
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withRepoLock(repoCommonDir, fn, { signal, timeoutMs = REPO_LOCK_TIMEOUT_MS } = {}) {
  const key = pathKey(repoCommonDir);
  const held = heldRepoLocks.getStore();
  if (held?.has(key)) return fn();
  const next = new Set(held || []);
  next.add(key);
  return withGitRepoWriteLock(
    key,
    () => withFileLock(repoLockPath(repoCommonDir), () => heldRepoLocks.run(next, fn), { timeoutMs }),
    { signal }
  );
}
