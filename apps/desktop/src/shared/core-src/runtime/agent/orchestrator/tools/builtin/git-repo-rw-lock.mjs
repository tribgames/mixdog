// In-process write lock for git work on one repository.
//
// Why it exists: Mixdog runs several sessions and sub-agents against one
// repository at once, and some of its own git work is a multi-step transaction
// that git's lock files cannot make atomic:
//   - a managed worktree mutation (worktrees/lock.mjs: create, checkout,
//     merge, remove, reconcile) inspects state, verifies it is clean or free,
//     then mutates refs, worktrees and the registry; an agent commit, checkout
//     or `worktree add` landing between the check and the mutation would be
//     lost or contradict it;
//   - `git action:stage` re-runs the diff, verifies it against the snapshot,
//     then applies the selection to the index; another write to that index in
//     between would stage a patch built from a stale view;
//   - two writes to one worktree (checkout + commit) must not interleave.
// The previous repository-wide read/write lock covered these by making every
// git tool call, reads included, queue on one lock, so one long read
// (`git log -S`) held back a writer and that queued writer held back every
// later read in every worktree of the repository.
//
// Policy:
//   - Reads take no lock. Git publishes the index and refs by atomic rename,
//     so a read always sees a consistent index and ref state; the git tool runs
//     reads with optional locks off, so `git status` never takes index.lock
//     beside a write (`git diff` may still refresh it briefly, which the write
//     retry absorbs). A read during a same-worktree write sees git's state at
//     that instant, as any second terminal (or the shell tool) does.
//   - A write names the worktrees it touches (the cwd's worktree, or the
//     target paths of `worktree add/remove/move`). Writes conflict only when
//     those sets intersect; a whole-repository write (managed mutations,
//     object pruning, init/clone, an unresolved worktree target) conflicts
//     with every write of the repository.
//   - Fair FIFO without convoys: a waiting write is granted once it conflicts
//     with no running write and no earlier waiting write. A later write never
//     overtakes an earlier one it conflicts with, so no write starves; a later
//     write that conflicts with nothing ahead of it runs at once.
//   - Git's own lock files still guard index, refs and config against other
//     processes; the git tool retries a write that git refused on one of them.
import { pathKey } from '../../../../shared/worktrees/paths.mjs';

const states = new Map();

// Callers key by the canonical `git rev-parse --git-common-dir`, so the main
// checkout and every linked worktree of one repository share one lock. The key
// is the real path (8.3 names, symlinked parents) and case-insensitive on
// Windows, so two spellings of one directory never hold separate locks.
export function gitRepoLockKey(repo) {
  return pathKey(String(repo || '.'));
}

function stateFor(key) {
  let state = states.get(key);
  if (!state) {
    state = { running: new Set(), queue: [] };
    states.set(key, state);
  }
  return state;
}

// `scopes` null is the whole repository.
function conflicts(left, right) {
  if (!left.scopes || !right.scopes) return true;
  return left.scopes.some((scope) => right.scopes.includes(scope));
}

function grant(key, state, entry) {
  entry.granted = true;
  entry.signal?.removeEventListener?.('abort', entry.onAbort);
  state.running.add(entry);
  let released = false;
  entry.resolve(() => {
    if (released) return;
    released = true;
    state.running.delete(entry);
    drain(key, state);
  });
}

function drain(key, state) {
  const waiting = [];
  for (const entry of state.queue) {
    const blocked =
      [...state.running].some((running) => conflicts(running, entry)) ||
      waiting.some((earlier) => conflicts(earlier, entry));
    if (blocked) waiting.push(entry);
    else grant(key, state, entry);
  }
  state.queue = waiting;
  if (state.running.size === 0 && waiting.length === 0) states.delete(key);
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error('git repository lock aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function acquire(repo, scopes, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const key = gitRepoLockKey(repo);
  const state = stateFor(key);
  return new Promise((resolveLock, rejectLock) => {
    const entry = { scopes, resolve: resolveLock, signal, onAbort: null, granted: false };
    entry.onAbort = () => {
      if (entry.granted) return;
      const index = state.queue.indexOf(entry);
      if (index >= 0) state.queue.splice(index, 1);
      signal?.removeEventListener?.('abort', entry.onAbort);
      rejectLock(abortError(signal));
      drain(key, state);
    };
    state.queue.push(entry);
    signal?.addEventListener?.('abort', entry.onAbort, { once: true });
    drain(key, state);
  });
}

async function withLock(repo, scopes, fn, options = {}) {
  const signal = options?.signal || null;
  const release = await acquire(repo, scopes, signal);
  try {
    if (signal?.aborted) throw abortError(signal);
    return await fn();
  } finally {
    release();
  }
}

/**
 * Run `fn` holding the write lock of the whole repository.
 * @template T
 * @param {string} repo canonical common git dir (or the path being created)
 * @param {() => Promise<T>|T} fn
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<T>}
 */
export function withGitRepoWriteLock(repo, fn, options = {}) {
  return withLock(repo, null, fn, options);
}

/**
 * Run `fn` holding the write lock of the named worktrees only; no (or no
 * non-empty) worktree list holds the whole repository.
 * @template T
 * @param {string} repo canonical common git dir
 * @param {string[]|null} worktrees worktree roots (or target paths) the write touches
 * @param {() => Promise<T>|T} fn
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<T>}
 */
export function withGitWorktreeWriteLock(repo, worktrees, fn, options = {}) {
  const scopes = [...new Set((worktrees || []).filter(Boolean).map((path) => gitRepoLockKey(path)))];
  return withLock(repo, scopes.length ? scopes : null, fn, options);
}
