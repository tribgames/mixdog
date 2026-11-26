import { useSyncExternalStore } from 'react';
import type { DesktopGitStatus } from '../shared/contract';
import { RendererLruCache } from './renderer-lru-cache';

export type DockGitState = {
  projectPath: string;
  status: DesktopGitStatus | null;
  ready: boolean;
  error: string;
};

const DOCK_GIT_CACHE_MAX_ENTRIES = 64;
const DOCK_GIT_CACHE_MAX_CHARS = 2 * 1024 * 1024;

const dockGitViewers = new Map<string, number>();
const dockGitListeners = new Set<() => void>();

function notifyDockGitListeners(): void {
  for (const listener of [...dockGitListeners]) listener();
}

/** Git status outlives each movable Dock view and hidden rail surface. The last
 * known snapshot per project stays in a bounded LRU, paints at once, and
 * revalidates in place. */
const dockGitCache = new RendererLruCache<string, DockGitState>({
  name: 'utility-dock-git',
  maxEntries: DOCK_GIT_CACHE_MAX_ENTRIES,
  maxChars: DOCK_GIT_CACHE_MAX_CHARS,
  measure: (value, key) =>
    Math.min(
      DOCK_GIT_CACHE_MAX_CHARS,
      key.length + 256 + value.error.length + (value.status?.files?.length ?? 0) * 128
    ),
  isPinned: (projectPath) => (dockGitViewers.get(projectPath) ?? 0) > 0,
  onTrim: notifyDockGitListeners,
});
const dockGitRequests = new Map<string, Promise<DockGitState>>();

export function subscribeDockGitState(listener: () => void): () => void {
  dockGitListeners.add(listener);
  return () => {
    dockGitListeners.delete(listener);
  };
}

/** Pins `projectPath`'s cached Git snapshot while a view is mounted; transient
 *  cleanups unpin it without purging the LRU entry. */
export function retainDockGitState(projectPath: string): () => void {
  if (!projectPath) return () => {};
  dockGitCache.get(projectPath);
  dockGitViewers.set(projectPath, (dockGitViewers.get(projectPath) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (dockGitViewers.get(projectPath) ?? 1) - 1;
    if (count > 0) {
      dockGitViewers.set(projectPath, count);
      return;
    }
    dockGitViewers.delete(projectPath);
  };
}

/** Explicitly purges one project's cached Git snapshot (or all snapshots when omitted). */
export function purgeDockGitState(projectPath?: string): void {
  if (projectPath === undefined) {
    dockGitCache.clear();
    dockGitRequests.clear();
  } else {
    dockGitCache.delete(projectPath);
    dockGitRequests.delete(projectPath);
  }
  notifyDockGitListeners();
}

export function readCachedDockGitState(projectPath: string): DockGitState {
  if (!projectPath) {
    return { projectPath: '', status: null, ready: true, error: '' };
  }
  return (
    dockGitCache.peek(projectPath) ?? {
      projectPath,
      status: null,
      ready: false,
      error: '',
    }
  );
}

export function useDockGitReady(projectPath: string): boolean {
  return useSyncExternalStore(
    subscribeDockGitState,
    () => !projectPath || readCachedDockGitState(projectPath).ready,
    () => !projectPath
  );
}

function loadDockGitState(projectPath: string): Promise<DockGitState> {
  const gitStatus = window.mixdogDesktop?.gitStatus;
  if (typeof gitStatus !== 'function') {
    return Promise.resolve({ projectPath, status: null, ready: true, error: '' });
  }
  // Source Control/Search only consume repository, branch and changed-file
  // shape. Line totals belong to Review surfaces, so making this dock wait
  // for two numstat passes and every untracked file read was pure latency.
  return gitStatus(projectPath, { skipLineStats: true }).then(
    (status) => ({ projectPath, status: status ?? null, ready: true, error: '' }),
    (reason) => ({
      projectPath,
      status: null,
      ready: true,
      error: reason instanceof Error ? reason.message : String(reason),
    })
  );
}

export function requestDockGitState(projectPath: string): Promise<DockGitState> {
  const pending = dockGitRequests.get(projectPath);
  if (pending) return pending;
  const request = loadDockGitState(projectPath).then((state) => {
    if (dockGitRequests.get(projectPath) === request) {
      dockGitCache.set(projectPath, state);
      notifyDockGitListeners();
    }
    return state;
  });
  dockGitRequests.set(projectPath, request);
  void request.finally(() => {
    if (dockGitRequests.get(projectPath) === request) dockGitRequests.delete(projectPath);
  });
  return request;
}

export async function prewarmUtilityDockGitState(projectPath: string): Promise<void> {
  if (!projectPath) return;
  const cached = readCachedDockGitState(projectPath);
  if (cached.ready && !cached.error) return;
  await requestDockGitState(projectPath);
}
