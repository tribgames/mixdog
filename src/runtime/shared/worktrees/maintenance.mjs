/**
 * Session-aware worktree maintenance: the daemon-startup reconcile, the
 * manual list/prune (Lead tool, desktop) and the cleanup after a session is
 * deleted. A worktree whose session is still in the session store is never
 * removed by any of them; only explicit removal (removeWorktree) does that.
 */
import { readdir } from 'node:fs/promises';
import { isWorktreeError } from './contract.mjs';

const loadManager = () => import('./manager.mjs');

/**
 * Ids of every session record in the store (one `<id>.json` per session,
 * tombstones included). An unreadable store throws: it never reads as
 * "no sessions", which would make every worktree look orphaned.
 */
export async function storedSessionIds() {
  const { getStoreDir } = await import('../../agent/orchestrator/session/store/session-paths.mjs');
  const names = await readdir(getStoreDir());
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .filter((id) => /^[A-Za-z0-9_-]+$/.test(id));
}

/** Authoritative consumers for destructive folder actions; unreadable records fail closed. */
export async function storedWorkspaceConsumers() {
  const { loadSession } = await import('../../agent/orchestrator/session/store/load-session.mjs');
  return (await storedSessionIds())
    .map((id) => {
      const session = loadSession(id);
      if (!session) throw new Error(`Cannot inspect session ${id}; no workspace was removed.`);
      return session;
    })
    .filter((session) => session.closed !== true);
}

/**
 * Daemon startup: resume interrupted deletions and creations, release stale
 * leases, prune stale registrations; with autoCleanup on, also remove clean,
 * merged worktrees no stored session retains.
 * @param {{ liveSessionIds?: string[], listSessionIds?: () => Promise<string[]>, manager?: object }} [options]
 */
export async function reconcileWorktreesAtStartup({
  liveSessionIds = [],
  listSessionIds = storedSessionIds,
  manager = null,
} = {}) {
  const backend = manager || (await loadManager());
  const settings = await backend.currentWorktreeSettings();
  return backend.reconcileManagedWorktrees({
    liveSessionIds,
    retainedSessionIds: await listSessionIds(),
    removeOrphans: settings.autoCleanup === true,
  });
}

/**
 * The manual list: every managed worktree with its retention.
 * @param {{ liveSessionIds?: string[], listSessionIds?: () => Promise<string[]>, manager?: object }} [options]
 */
export async function listWorktreesWithRetention({
  liveSessionIds = [],
  listSessionIds = storedSessionIds,
  manager = null,
} = {}) {
  const backend = manager || (await loadManager());
  return backend.listManagedWorktrees({ liveSessionIds, retainedSessionIds: await listSessionIds() });
}

/**
 * The manual prune (an explicit request, so independent of autoCleanup):
 * the startup reconcile plus removal of clean, merged worktrees that no
 * stored or live session retains. Dirty or unmerged ones are reported kept.
 * `repoCommonDir` limits the prune to that repository's worktrees.
 * @param {{ liveSessionIds?: string[], listSessionIds?: () => Promise<string[]>, manager?: object, repoCommonDir?: string|null }} [options]
 */
export async function pruneWorktrees({
  liveSessionIds = [],
  listSessionIds = storedSessionIds,
  manager = null,
  repoCommonDir = null,
} = {}) {
  const backend = manager || (await loadManager());
  return backend.reconcileManagedWorktrees({
    liveSessionIds,
    retainedSessionIds: await listSessionIds(),
    removeOrphans: true,
    ...(repoCommonDir ? { repoCommonDir } : {}),
  });
}

/**
 * After a session was deleted: with autoCleanup on, its worktree is marked
 * disposable and removed when clean and merged (dirty or unmerged work is
 * kept, still disposable, for a later prune once it is clean). Off: kept.
 * @param {string} sessionId
 * @param {{ manager?: object, autoCleanup?: boolean }} [options]
 */
export async function cleanupDeletedSessionWorktree(sessionId, { manager = null, autoCleanup } = {}) {
  const backend = manager || (await loadManager());
  await backend.forgetSharedWorktreeSession?.(sessionId);
  // Its read-only snapshots go whatever autoCleanup says (they never outlive their holder).
  await backend.removeSessionSnapshots?.(sessionId);
  const entry = await backend.getSessionWorktree(sessionId);
  if (!entry) return null;
  const enabled = autoCleanup ?? (await backend.currentWorktreeSettings()).autoCleanup;
  if (enabled !== true) return { entryId: entry.id, removed: false, reason: 'auto-cleanup-off' };
  if (entry.state === 'ready') await backend.markWorktreeDisposable(entry.id);
  try {
    return { entryId: entry.id, ...(await backend.removeManagedWorktree({ entryId: entry.id })) };
  } catch (error) {
    if (
      isWorktreeError(error, 'WORKTREE_DIRTY') ||
      isWorktreeError(error, 'WORKTREE_BUSY_JOBS') ||
      isWorktreeError(error, 'WORKTREE_UNMERGED') ||
      isWorktreeError(error, 'WORKTREE_FILE_RECOVERY')
    ) {
      return { entryId: entry.id, removed: false, reason: error.code };
    }
    throw error;
  }
}
