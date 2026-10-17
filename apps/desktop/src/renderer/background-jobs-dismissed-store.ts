import { useSyncExternalStore } from 'react';

/** Finished rows the user dismissed (shell jobs, settled agent outcomes), per
 *  owner session, persisted locally so a dismissed row never reappears
 *  (records age out on the runtime side). */
const STORAGE_PREFIX = 'mixdog.dismissedShellJobs.';
const MAX_REMEMBERED = 200;
const EMPTY: ReadonlySet<string> = new Set();

const cache = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
/** Advances on every dismissal, in any session. */
let revision = 0;

function readStored(sessionId: string): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_PREFIX + sessionId) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return EMPTY;
  }
}

export function dismissedShellJobs(sessionId: string): ReadonlySet<string> {
  if (!sessionId) return EMPTY;
  let set = cache.get(sessionId);
  if (!set) {
    set = readStored(sessionId);
    cache.set(sessionId, set);
  }
  return set;
}

/** Hides the given shell row keys (`shell:<jobId>`) for this session for good. */
export function dismissShellJobs(sessionId: string, keys: readonly string[]): void {
  if (!sessionId || keys.length === 0) return;
  const next = new Set([...dismissedShellJobs(sessionId), ...keys]);
  const kept = new Set([...next].slice(-MAX_REMEMBERED));
  cache.set(sessionId, kept);
  try {
    globalThis.localStorage?.setItem(STORAGE_PREFIX + sessionId, JSON.stringify([...kept]));
  } catch {
    // Storage is best-effort; the in-memory set still hides the rows.
  }
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders on a dismissal in ANY session: for surfaces that read the
 *  dismissed sets of many sessions at once. */
export function useDismissedJobsRevision(): number {
  return useSyncExternalStore(
    subscribe,
    () => revision,
    () => 0
  );
}

export function useDismissedShellJobs(sessionId: string): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => dismissedShellJobs(sessionId),
    () => EMPTY
  );
}

/** Test seam: forget the in-memory cache so storage is re-read. */
export function resetDismissedShellJobsCache(): void {
  cache.clear();
}
