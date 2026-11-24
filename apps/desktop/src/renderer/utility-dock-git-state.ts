import type { DesktopGitStatus } from '../shared/contract';

export type DockGitState = {
  projectPath: string;
  status: DesktopGitStatus | null;
  ready: boolean;
  error: string;
};

/** Git status outlives each movable Dock view. The last known snapshot per
 * project paints at once; every entry revalidates in the background and
 * replaces it in place. */
const dockGitCache = new Map<string, DockGitState>();
const dockGitRequests = new Map<string, Promise<DockGitState>>();

const dockGitViewers = new Map<string, number>();

/** A view of `projectPath`'s Git status is mounted; the snapshot goes with the
 *  last one. */
export function retainDockGitState(projectPath: string): () => void {
  if (!projectPath) return () => {};
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
    dockGitCache.delete(projectPath);
    dockGitRequests.delete(projectPath);
  };
}

export function readCachedDockGitState(projectPath: string): DockGitState {
  if (!projectPath) {
    return { projectPath: '', status: null, ready: true, error: '' };
  }
  return (
    dockGitCache.get(projectPath) ?? {
      projectPath,
      status: null,
      ready: false,
      error: '',
    }
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
    // A read whose last viewer left meanwhile has no owner to hold it.
    if (dockGitRequests.get(projectPath) === request) dockGitCache.set(projectPath, state);
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
