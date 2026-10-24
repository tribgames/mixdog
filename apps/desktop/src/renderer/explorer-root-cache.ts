// The project root listing the Files tree paints from in its first frame
// (keyed-read-cache): a warm-up (boot, or the Search entry's open intent) and
// the mounted tree share one read in flight, and every activation revalidates
// behind the cached rows instead of opening on an empty tree.
//
// Retention follows live use, with no size cap: a listing is kept only while
// its project is the current one or a mounted tree reads it, and is dropped
// when the project is unregistered (changesReaders style: readers are counted
// and the entry leaves with the last one).
import type { DesktopApi, DesktopDirEntry } from '../shared/contract';
import { projectIdentity } from '../shared/project-identity';
import { createKeyedReadCache, type KeyedReadCache } from './keyed-read-cache';

type ListingApi = Pick<DesktopApi, 'listProjectDir'> | undefined;

/** One cache per project (by identity), so dropping a project drops its listing. */
const roots = new Map<string, KeyedReadCache<DesktopDirEntry[]>>();
/** Per project: the mounted trees reading it. */
const readers = new Map<string, number>();
/** Per project: why its newest root read failed, until a read succeeds. A tree that opens on it shows the error in its first frame. */
const failures = new Map<string, { reason: unknown }>();
let currentProject = '';

const rootReader = (api: ListingApi, projectPath: string) => async () =>
  (await api?.listProjectDir?.(projectPath, '')) ?? [];

function cacheFor(projectPath: string): KeyedReadCache<DesktopDirEntry[]> {
  const key = projectIdentity(projectPath);
  let cache = roots.get(key);
  if (!cache) {
    cache = createKeyedReadCache();
    roots.set(key, cache);
  }
  return cache;
}

/** Drops every listing and failure nothing holds: not the current project's, not a mounted tree's. */
function sweep(): void {
  for (const key of [...roots.keys(), ...failures.keys()]) {
    if (key !== currentProject && !readers.has(key)) {
      roots.delete(key);
      failures.delete(key);
    }
  }
}

/** Runs a read on the project's cache and keeps its outcome: the newest failure,
 *  cleared by the next success. An outcome counts only while the cache entry
 *  that started the read is still the project's (a read finishing after its
 *  entry was evicted leaves nothing behind); the retention sweep runs after
 *  every read, so a listing or failure nothing holds leaves with it. */
function track(
  projectPath: string,
  run: (cache: KeyedReadCache<DesktopDirEntry[]>) => Promise<DesktopDirEntry[]>
): Promise<DesktopDirEntry[]> {
  const key = projectIdentity(projectPath);
  const cache = cacheFor(projectPath);
  const read = run(cache);
  const settle = (failure?: { reason: unknown }) => {
    if (roots.get(key) === cache) {
      if (failure) failures.set(key, failure);
      else failures.delete(key);
    }
    sweep();
  };
  void read.then(
    () => settle(),
    (reason) => settle({ reason })
  );
  return read;
}

/** The newest root listing read for the project, if any. */
export function peekExplorerRoot(projectPath: string): DesktopDirEntry[] | undefined {
  return roots.get(projectIdentity(projectPath))?.peek('');
}

/** Why the newest root read failed, if it did. */
export function peekExplorerRootFailure(projectPath: string): { reason: unknown } | undefined {
  return failures.get(projectIdentity(projectPath));
}

/** A listing or a failure is known: a tree opens on it in its first frame. */
export function explorerRootSettled(projectPath: string): boolean {
  return peekExplorerRoot(projectPath) !== undefined || peekExplorerRootFailure(projectPath) !== undefined;
}

/** Reads the root (a read in flight is shared). */
export function loadExplorerRoot(api: ListingApi, projectPath: string): Promise<DesktopDirEntry[]> {
  return track(projectPath, (cache) => cache.load('', rootReader(api, projectPath)));
}

/** Reads the root after a change: a read in flight began before it. */
export function refreshExplorerRoot(api: ListingApi, projectPath: string): Promise<DesktopDirEntry[]> {
  return track(projectPath, (cache) => cache.refresh('', rootReader(api, projectPath)));
}

/** Warms the cache before a tree opens. */
export async function prefetchExplorerRoot(api: ListingApi, projectPath: string): Promise<void> {
  if (projectPath) await loadExplorerRoot(api, projectPath);
}

/** The project the app is on: its listing stays while no tree reads it. */
export function setCurrentExplorerProject(projectPath: string): void {
  currentProject = projectIdentity(projectPath);
  sweep();
}

/** A mounted tree reads this project's listing until the returned release. */
export function retainExplorerRoot(projectPath: string): () => void {
  const key = projectIdentity(projectPath);
  readers.set(key, (readers.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (readers.get(key) ?? 0) - 1;
    if (count > 0) readers.set(key, count);
    else readers.delete(key);
    sweep();
  };
}

/** The registered projects: a listing of a project that is gone is dropped. */
export function pruneExplorerRoots(registeredPaths: readonly string[]): void {
  const registered = new Set(registeredPaths.map(projectIdentity));
  for (const key of [...roots.keys(), ...failures.keys()]) {
    if (!registered.has(key)) {
      roots.delete(key);
      failures.delete(key);
    }
  }
}

export function resetExplorerRootCache(): void {
  roots.clear();
  failures.clear();
  readers.clear();
  currentProject = '';
}
