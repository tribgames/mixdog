/**
 * Root cleanups for Mixdog's path-keyed caches: when a managed worktree is
 * removed these drop everything the runtime cached under that exact root, so
 * the removal leaves no turn snapshots, snapshot-store scopes or code-graph
 * state behind. Each returns `{ removed, kept }` and never touches other roots.
 * Modules load lazily: registering costs nothing until a worktree is removed.
 */
import { registerRootCleanup } from './contract.mjs';

const merge = (target, part) => {
  target.removed.push(...part.removed);
  target.kept.push(...part.kept);
};

/** @type {Record<string, (root: string) => Promise<{removed: string[], kept: string[]}>>} */
export const WORKTREE_CACHE_CLEANUPS = Object.freeze({
  'turn-worktree-snapshots': async (root) => {
    const { forgetTurnWorktreeRoot } = await import('../turn-worktree-snapshot.mjs');
    return await forgetTurnWorktreeRoot(root);
  },
  'turn-snapshot-store': async (root) => {
    const { forgetTurnSnapshotRoot } = await import('../turn-snapshot-store.mjs');
    return await forgetTurnSnapshotRoot(root);
  },
  'code-graph': async (root) => {
    const [state, disk, trusted] = await Promise.all([
      import('../code-graph-state.mjs'),
      import('../../agent/orchestrator/tools/code-graph/disk-cache.mjs'),
      import('../../agent/orchestrator/tools/code-graph/trusted-roots.mjs'),
    ]);
    const result = { removed: state.forgetCodeGraphStateRoot(root).map((name) => `${name}:${root}`), kept: [] };
    merge(result, disk.forgetDiskCodeGraphRoot(root));
    merge(result, trusted.forgetTrustedCodeGraphRoot(root));
    return result;
  },
});

const registrations = new WeakSet();

/**
 * Register every cache cleanup once per registry function. Idempotent: calling
 * it again (or from several hosts) neither throws nor registers duplicates.
 * @param {typeof registerRootCleanup} [register] Defaults to the process registry.
 * @returns {string[]} Cleanup names.
 */
export function registerWorktreeCacheCleanups(register = registerRootCleanup) {
  if (!registrations.has(register)) {
    registrations.add(register);
    for (const [name, cleanup] of Object.entries(WORKTREE_CACHE_CLEANUPS)) register(name, cleanup);
  }
  return Object.keys(WORKTREE_CACHE_CLEANUPS);
}
