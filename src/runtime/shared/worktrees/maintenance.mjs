/**
 * Session-aware worktree maintenance: the daemon-startup reconcile, the
 * manual list/prune (Lead tool, desktop) and the cleanup after a session is
 * deleted. A worktree whose session is still in the session store is never
 * removed by any of them; only explicit removal (removeWorktree) does that.
 */
import { readdir } from 'node:fs/promises';
import { isWorktreeError } from './contract.mjs';
import { pathKey } from './paths.mjs';

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

/** Worktrees younger than this are never cleaned up automatically. */
export const WORKTREE_CLEANUP_MIN_AGE_MS = 60 * 60_000;
/** At most this many count/age removals per pass. */
export const WORKTREE_CLEANUP_MAX_REMOVALS = 20;
const DAY_MS = 24 * 60 * 60_000;

/** Favorite session ids from the attached desktop; null when unknown (no desktop, or one without favorites). */
async function storedFavoriteSessionIds() {
  const { readSessionSidebarState } = await import('../session-sidebar-host.mjs');
  const state = await readSessionSidebarState();
  return state?.favorites ? Object.keys(state.favorites) : null;
}

/**
 * `{ id → { lastActiveAt, title } }` for the given stored sessions (missing
 * ones are left out): the last conversation turn or heartbeat.
 */
async function storedSessionActivity(ids) {
  const [{ loadSession }, { subAgentActivityAt }] = await Promise.all([
    import('../../agent/orchestrator/session/store/load-session.mjs'),
    import('../../agent/orchestrator/session/store/sweep/sub-agent-retention.mjs'),
  ]);
  const out = {};
  for (const id of new Set(ids)) {
    const doc = loadSession(id);
    if (doc) out[id] = { lastActiveAt: subAgentActivityAt(doc) || null, title: doc.title || doc.name || null };
  }
  return out;
}

/** Running background shell jobs (`{ cwd, ownerSessionId }`); an unreadable record throws (fail closed). */
async function runningShellJobs() {
  const { listShellJobRecords } = await import('../../agent/orchestrator/tools/builtin/lib/shell-job-records.mjs');
  return (await listShellJobRecords({ strict: true })).filter((job) => !job.terminal);
}

const within = (folder, path) => {
  if (typeof path !== 'string' || !path) return false;
  const a = folder
    .replace(/[\\/]+$/, '')
    .toLowerCase()
    .replace(/\\/g, '/');
  const b = path.toLowerCase().replace(/\\/g, '/');
  return b === a || b.startsWith(`${a}/`);
};

/** A row's last activity: its newest session's last turn, else its creation. */
function rowActivity(row, activity) {
  const sessions = [row.ownerSessionId, ...(row.sharedSessionIds ?? [])].filter(Boolean);
  return Math.max(Number(row.createdAt) || 0, ...sessions.map((id) => Number(activity[id]?.lastActiveAt) || 0));
}

/**
 * The count/age limits' choice (pure): which managed worktrees to clean up,
 * least recently used first, at most WORKTREE_CLEANUP_MAX_REMOVALS.
 * Candidates are ready branch worktrees that are clean (`dirty === 0`),
 * merged (`unmerged === 0`), not in use (`ownerLive`, `inUse`), not shared,
 * not a favorite session's and at least WORKTREE_CLEANUP_MIN_AGE_MS old.
 * `maxWorktrees` counts every managed branch worktree; `unusedDays` compares
 * the row's last activity (rowActivity). Off (autoCleanup false) selects none.
 * @param {object[]} rows listManagedWorktrees({ inspect: true }) rows (+ `inUse`)
 * @param {{ settings: object, now?: number, activity?: Record<string, { lastActiveAt?: number|null }>, favoriteSessionIds?: Iterable<string> }} options
 * @returns {{ id: string, reason: 'count'|'age', lastActiveAt: number }[]}
 */
export function selectWorktreeCleanup(
  rows,
  { settings, now = Date.now(), activity = {}, favoriteSessionIds = [], potential = false, repoCommonDir = null }
) {
  if (settings?.autoCleanup !== true) return [];
  const favorites = new Set(favoriteSessionIds);
  const managed = rows.filter((row) => row.kind !== 'snapshot');
  const candidates = managed
    .filter(
      (row) =>
        row.state === 'ready' &&
        row.dirty === 0 &&
        row.unmerged === 0 &&
        row.ownerLive !== true &&
        row.inUse !== true &&
        !row.sharedSessionIds?.length &&
        ![row.ownerSessionId].some((id) => id && favorites.has(id)) &&
        now - (Number(row.createdAt) || 0) >= WORKTREE_CLEANUP_MIN_AGE_MS
    )
    .map((row) => ({ id: row.id, repoCommonDir: row.repoCommonDir, lastActiveAt: rowActivity(row, activity) }))
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt || a.id.localeCompare(b.id));
  const reasons = new Map();
  if (settings.unusedDays > 0) {
    const cutoff = now - settings.unusedDays * DAY_MS;
    for (const row of candidates) if (row.lastActiveAt < cutoff) reasons.set(row.id, 'age');
  }
  if (settings.maxWorktrees > 0) {
    let excess = managed.length - settings.maxWorktrees;
    for (const row of candidates) {
      if (excess <= 0) break;
      if (!reasons.has(row.id)) reasons.set(row.id, 'count');
      // `potential` (the unverified preview): which candidates are really dirty or
      // unmerged is unknown, so any of them could be the ones that fill the excess.
      if (!potential) excess -= 1;
    }
  }
  // The limits count every repository; a cleanup scoped to one repository
  // drops the others' picks before the per-pass cap, so its own are reached.
  const scope = repoCommonDir ? pathKey(repoCommonDir) : null;
  const picked = candidates.filter(
    (row) => reasons.has(row.id) && (!scope || pathKey(row.repoCommonDir || '') === scope)
  );
  return (potential ? picked : picked.slice(0, WORKTREE_CLEANUP_MAX_REMOVALS)).map(
    ({ repoCommonDir: _repo, ...row }) => ({
      ...row,
      reason: reasons.get(row.id),
    })
  );
}

/**
 * The count/age limits' selection for one cleanup pass (autoCleanup on only).
 * `inspect` runs the per-worktree dirty/merge checks the removal needs; off,
 * every ready worktree counts as clean and merged (the preview's optimistic,
 * git-free reading). Adds the owners of worktrees with a running job to `live`.
 */
async function selectLimitCleanup(
  backend,
  { settings, live, jobs, retainedSessionIds, now, readFavorites, readActivity, inspect, repoCommonDir }
) {
  if (settings.autoCleanup !== true) return { selected: [], favorites: [], limits: 'off' };
  const known = await readFavorites();
  const favorites = known ?? [];
  const limits = known ? 'applied' : 'favorites-unknown';
  let selected = [];
  if (known && (settings.maxWorktrees > 0 || settings.unusedDays > 0)) {
    let rows = await backend.listManagedWorktrees({ liveSessionIds: [...live], retainedSessionIds, inspect });
    if (!inspect) rows = rows.map((row) => ({ ...row, dirty: 0, unmerged: 0 }));
    for (const row of rows) {
      if (jobs.some((job) => within(row.path, job.cwd))) {
        row.inUse = true;
        if (row.ownerSessionId) live.add(row.ownerSessionId);
      }
    }
    const owners = rows.flatMap((row) => [row.ownerSessionId, ...(row.sharedSessionIds ?? [])]).filter(Boolean);
    selected = selectWorktreeCleanup(rows, {
      settings,
      now,
      activity: await readActivity(owners),
      favoriteSessionIds: favorites,
      potential: !inspect,
      repoCommonDir,
    });
  }
  return { selected, favorites, limits };
}

/**
 * Whether "Clean up now" could act on anything, without its git
 * verification or any removal: the same selection as runWorktreeCleanup
 * (registrations whose folder is gone, unretained or disposable worktrees,
 * interrupted removals, and with autoCleanup on the limits and archive rules),
 * read from the registry and session store only. A candidate may still be
 * kept when the prune verifies it (dirty, unmerged, in use).
 * @param {Parameters<typeof runWorktreeCleanup>[0]} [options]
 * @returns {Promise<{ hasCandidates: boolean, ids: string[], stale: string[] }>}
 */
export async function previewWorktreeCleanup({
  liveSessionIds = [],
  listSessionIds = storedSessionIds,
  manager = null,
  repoCommonDir = null,
  now = Date.now(),
  readFavorites = storedFavoriteSessionIds,
  readActivity = storedSessionActivity,
  listJobs = runningShellJobs,
  settings: given = null,
} = {}) {
  const backend = manager || (await loadManager());
  const settings = given ?? (await backend.currentWorktreeSettings());
  const retainedSessionIds = await listSessionIds();
  const live = new Set(liveSessionIds);
  const jobs = await listJobs();
  for (const job of jobs) if (job.ownerSessionId) live.add(job.ownerSessionId);
  const { selected, favorites, limits } = await selectLimitCleanup(backend, {
    settings,
    live,
    jobs,
    retainedSessionIds,
    now,
    readFavorites,
    readActivity,
    inspect: false,
    repoCommonDir,
  });
  const auto = settings.autoCleanup === true;
  const { ids, stale } = await backend.previewManagedWorktreeCleanup({
    liveSessionIds: [...live],
    retainedSessionIds,
    ...(repoCommonDir ? { repoCommonDir } : {}),
    ...(auto
      ? {
          removeEntryIds: selected.map((row) => row.id),
          protectedSessionIds: favorites,
          minAgeMs: WORKTREE_CLEANUP_MIN_AGE_MS,
          now,
          cleanupArchived: settings.cleanupArchived === true && limits === 'applied',
        }
      : {}),
  });
  return { hasCandidates: ids.length + stale.length > 0, ids, stale };
}

/**
 * The automatic cleanup (daemon startup and the idle maintenance pass), and
 * with `explicit` the manual "Clean up now". Always: the bookkeeping
 * reconcile (interrupted deletions/creations, stale leases, `git worktree
 * prune`). With autoCleanup on (or `explicit`): clean, merged worktrees no
 * stored session retains or a deleted session left disposable; with
 * autoCleanup on also archived sessions' (cleanupArchived) and what the
 * count/age limits select (selectWorktreeCleanup). Never removed: dirty or
 * unmerged work, a live owner (`liveSessionIds`, a running lease holder, an
 * owner with a running background shell job, or any job running inside the
 * folder), a favorite session's, one younger than an hour, a shared one, an
 * unmanaged one. The limits need the favorites: unknown (no desktop
 * attached) skips them (`limits: 'favorites-unknown'`). `deleteBranch` off
 * keeps every removed worktree's branch; on, its tip stays under
 * refs/mixdog/removed/<id>.
 * @param {{ liveSessionIds?: string[], listSessionIds?: () => Promise<string[]>, manager?: object,
 *   repoCommonDir?: string|null, explicit?: boolean, now?: number, settings?: object|null,
 *   currentLiveSessionIds?: () => Iterable<string>, finalCheckTimeoutMs?: number|null,
 *   readFavorites?: () => Promise<string[]|null>, readActivity?: (ids: string[]) => Promise<object>,
 *   listJobs?: () => Promise<{ cwd?: string, ownerSessionId?: string }[]> }} [options]
 */
export async function runWorktreeCleanup({
  liveSessionIds = [],
  listSessionIds = storedSessionIds,
  manager = null,
  repoCommonDir = null,
  explicit = false,
  now = Date.now(),
  readFavorites = storedFavoriteSessionIds,
  readActivity = storedSessionActivity,
  listJobs = runningShellJobs,
  settings: given = null,
  currentLiveSessionIds = () => [],
  finalCheckTimeoutMs = null,
} = {}) {
  const backend = manager || (await loadManager());
  const settings = given ?? (await backend.currentWorktreeSettings());
  const retainedSessionIds = await listSessionIds();
  const scope = repoCommonDir ? { repoCommonDir } : {};
  if (settings.autoCleanup !== true && !explicit) {
    return {
      ...(await backend.reconcileManagedWorktrees({
        liveSessionIds,
        retainedSessionIds,
        removeOrphans: false,
        ...scope,
      })),
      selected: [],
    };
  }
  const live = new Set(liveSessionIds);
  const jobs = await listJobs();
  for (const job of jobs) if (job.ownerSessionId) live.add(job.ownerSessionId);
  // Asked again under each removal's folder hold (manager reconcile): the
  // sessions live now and the jobs running now, whatever the limits are.
  const inUse = async (record) => {
    const now = new Set([...live, ...currentLiveSessionIds()]);
    const running = await listJobs();
    for (const job of running) if (job.ownerSessionId) now.add(job.ownerSessionId);
    return (
      [record.ownerSessionId, ...(record.sharedSessionIds ?? [])].some((id) => id && now.has(id)) ||
      running.some((job) => within(record.path, job.cwd))
    );
  };
  const { selected, favorites, limits } = await selectLimitCleanup(backend, {
    settings,
    live,
    jobs,
    retainedSessionIds,
    now,
    readFavorites,
    readActivity,
    inspect: true,
    repoCommonDir,
  });
  const report = await backend.reconcileManagedWorktrees({
    liveSessionIds: [...live],
    retainedSessionIds,
    removeOrphans: true,
    ...scope,
    ...(settings.autoCleanup === true
      ? {
          removeEntryIds: selected.map((row) => row.id),
          protectedSessionIds: favorites,
          minAgeMs: WORKTREE_CLEANUP_MIN_AGE_MS,
          now,
          cleanupArchived: settings.cleanupArchived === true && limits === 'applied',
        }
      : {}),
    preserveBranch: settings.deleteBranch !== true,
    keepTip: settings.deleteBranch === true,
    maxRemovals: WORKTREE_CLEANUP_MAX_REMOVALS,
    inUse,
    ...(finalCheckTimeoutMs ? { finalCheckTimeoutMs } : {}),
  });
  return { ...report, selected, limits };
}

/**
 * Daemon startup: resume interrupted deletions and creations, release stale
 * leases, prune stale registrations; with autoCleanup on, also the automatic
 * cleanup (runWorktreeCleanup).
 * @param {Parameters<typeof runWorktreeCleanup>[0]} [options]
 */
export async function reconcileWorktreesAtStartup(options = {}) {
  return runWorktreeCleanup(options);
}

/**
 * The manual list: every managed worktree with its retention. `details`
 * adds what the worktree list shows: dirty/unmerged counts, folder size, the
 * owner's title, archive flag and last activity (`lastActiveAt`).
 * @param {{ liveSessionIds?: string[], listSessionIds?: () => Promise<string[]>, manager?: object, details?: boolean,
 *   readActivity?: (ids: string[]) => Promise<object>, readArchived?: () => Promise<string[]|null> }} [options]
 */
export async function listWorktreesWithRetention({
  liveSessionIds = [],
  listSessionIds = storedSessionIds,
  manager = null,
  details = false,
  readActivity = storedSessionActivity,
  readArchived = storedArchivedSessionIds,
} = {}) {
  const backend = manager || (await loadManager());
  const rows = await backend.listManagedWorktrees({
    liveSessionIds,
    retainedSessionIds: await listSessionIds(),
    ...(details ? { inspect: true, size: true } : {}),
  });
  if (!details) return rows;
  const owners = rows.flatMap((row) => [row.ownerSessionId, ...(row.sharedSessionIds ?? [])]).filter(Boolean);
  const activity = await readActivity(owners);
  const archived = new Set((await readArchived()) ?? []);
  return rows.map((row) => ({
    ...row,
    ownerTitle: (row.ownerSessionId && activity[row.ownerSessionId]?.title) || null,
    ownerArchived: !!row.ownerSessionId && archived.has(row.ownerSessionId),
    lastActiveAt: rowActivity(row, activity) || null,
  }));
}

/** Archived session ids from the attached desktop; null when none is attached. */
async function storedArchivedSessionIds() {
  const { readSessionSidebarState } = await import('../session-sidebar-host.mjs');
  const state = await readSessionSidebarState();
  return state ? Object.keys(state.archived ?? {}) : null;
}

/**
 * The manual prune ("Clean up now"; an explicit request, so independent of
 * autoCleanup): the startup reconcile plus removal of clean, merged worktrees
 * that no stored or live session retains, and with autoCleanup on everything
 * the automatic cleanup would remove (runWorktreeCleanup). Dirty or unmerged
 * ones are reported kept. `repoCommonDir` limits the prune to that repository.
 * @param {Parameters<typeof runWorktreeCleanup>[0]} [options]
 */
export async function pruneWorktrees(options = {}) {
  return runWorktreeCleanup({ ...options, explicit: true });
}

/**
 * After sessions were archived (`archived`) or restored: with autoCleanup and
 * cleanupArchived on, an archive marks their worktrees disposable, so the
 * automatic cleanup removes each once it is clean, merged, an hour old, not a
 * favorite's and its owner is not live; dirty or unmerged work stays. Nothing
 * is removed here. Off: nothing is marked. A restore always clears the mark.
 * @param {string[]} sessionIds
 * @param {boolean} archived
 * @param {{ manager?: object, autoCleanup?: boolean, cleanupArchived?: boolean }} [options]
 */
export async function setArchivedSessionWorktrees(
  sessionIds,
  archived,
  { manager = null, autoCleanup, cleanupArchived } = {}
) {
  const backend = manager || (await loadManager());
  if (archived === true) {
    const settings =
      autoCleanup === undefined || cleanupArchived === undefined ? await backend.currentWorktreeSettings() : null;
    if ((autoCleanup ?? settings.autoCleanup) !== true) return { changed: [], reason: 'auto-cleanup-off' };
    if ((cleanupArchived ?? settings.cleanupArchived) === false) return { changed: [], reason: 'archive-cleanup-off' };
  }
  return { changed: await backend.setSessionWorktreesDisposable(sessionIds, archived === true) };
}

/**
 * After a session was deleted: with autoCleanup on, its worktree is marked
 * disposable and removed when clean and merged (dirty or unmerged work is
 * kept, still disposable, for a later prune once it is clean). Off: kept.
 * Its branch goes only with deleteBranch on.
 * @param {string} sessionId
 * @param {{ manager?: object, autoCleanup?: boolean, deleteBranch?: boolean }} [options]
 */
export async function cleanupDeletedSessionWorktree(sessionId, { manager = null, autoCleanup, deleteBranch } = {}) {
  const backend = manager || (await loadManager());
  await backend.forgetSharedWorktreeSession?.(sessionId);
  // Its read-only snapshots go whatever autoCleanup says (they never outlive their holder).
  await backend.removeSessionSnapshots?.(sessionId);
  const entry = await backend.getSessionWorktree(sessionId);
  if (!entry) return null;
  const settings =
    autoCleanup === undefined || deleteBranch === undefined ? await backend.currentWorktreeSettings() : null;
  const enabled = autoCleanup ?? settings.autoCleanup;
  if (enabled !== true) return { entryId: entry.id, removed: false, reason: 'auto-cleanup-off' };
  if (entry.state === 'ready') await backend.markWorktreeDisposable(entry.id);
  const preserveBranch = (deleteBranch ?? settings.deleteBranch) !== true;
  try {
    return {
      entryId: entry.id,
      ...(await backend.removeManagedWorktree({ entryId: entry.id, preserveBranch, automatic: true })),
    };
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
