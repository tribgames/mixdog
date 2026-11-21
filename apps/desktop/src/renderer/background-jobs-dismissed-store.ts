import { useSyncExternalStore } from 'react';

/** Finished rows the user dismissed (shell jobs, settled agent outcomes), per
 *  owner session, persisted locally so a dismissed row never reappears
 *  (records age out on the runtime side). */
const STORAGE_PREFIX = 'mixdog.dismissedShellJobs.';
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

/** The row keys the runtime lists for the owner now, per kind. A kind left
 *  out (or `null`, not loaded yet) is never pruned. */
export interface DismissedListing {
  agents?: ReadonlySet<string> | null;
  shells?: ReadonlySet<string> | null;
}

/** `agent:<id>@` of an agent key (`agent:<id>@<at>`): what every outcome of
 *  that agent starts with. Empty for any other key. */
function agentOf(key: string): string {
  const at = key.lastIndexOf('@');
  return key.startsWith('agent:') && at >= 0 ? key.slice(0, at + 1) : '';
}

/** Whether an earlier key can still hide a row. A shell key cannot once its
 *  session lists the job no longer. An agent key cannot once another outcome
 *  of that agent is known: a later one being dismissed now (`dismissed`; a
 *  clear made from rows read earlier can carry an older one), or one the
 *  listing holds. An agent the listing leaves out (its Lead's row is away) may
 *  come back with the same outcome. */
function stillHides(key: string, listing: DismissedListing, dismissed: readonly string[]): boolean {
  if (key.startsWith('shell:')) return !listing.shells || listing.shells.has(key);
  const agent = agentOf(key);
  if (!agent) return true;
  const settled = Number(key.slice(agent.length));
  if (dismissed.some((other) => other.startsWith(agent) && Number(other.slice(agent.length)) > settled)) return false;
  if (!listing.agents || listing.agents.has(key)) return true;
  for (const listed of listing.agents) if (listed.startsWith(agent)) return false;
  return true;
}

/** Hides the given row keys (`shell:<jobId>`, `agent:<id>@<at>`) for this
 *  session for good. Earlier keys that can hide nothing any more are dropped
 *  (`stillHides`); the set is bounded by the jobs and agents of the session,
 *  not by a count. */
export function dismissShellJobs(sessionId: string, keys: readonly string[], listing: DismissedListing = {}): void {
  if (!sessionId || keys.length === 0) return;
  const earlier = [...dismissedShellJobs(sessionId)].filter((key) => stillHides(key, listing, keys));
  const kept = new Set([...earlier, ...keys]);
  cache.set(sessionId, kept);
  try {
    globalThis.localStorage?.setItem(STORAGE_PREFIX + sessionId, JSON.stringify([...kept]));
  } catch {
    // Storage is best-effort; the in-memory set still hides the rows.
  }
  revision += 1;
  for (const listener of listeners) listener();
}

/** Notified on every dismissal, in any session. */
export function subscribeDismissedJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const subscribe = subscribeDismissedJobs;

export function dismissedJobsRevision(): number {
  return revision;
}

/** Re-renders on a dismissal in ANY session: for surfaces that read the
 *  dismissed sets of many sessions at once. */
export function useDismissedJobsRevision(): number {
  return useSyncExternalStore(subscribe, dismissedJobsRevision, () => 0);
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
