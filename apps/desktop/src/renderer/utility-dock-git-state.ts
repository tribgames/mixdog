import type { DesktopGitStatus } from '../shared/contract';

export type DockGitState = {
  projectPath: string;
  status: DesktopGitStatus | null;
  loading: boolean;
  ready: boolean;
  error: string;
};

/** Git status outlives each movable Dock view. The last known snapshot per
 * project paints at once; every entry revalidates in the background and
 * replaces it in place. */
const dockGitCache = new Map<string, DockGitState>();
const dockGitRequests = new Map<string, Promise<DockGitState>>();

export function readCachedDockGitState(projectPath: string): DockGitState {
  if (!projectPath) {
    return { projectPath: '', status: null, loading: false, ready: true, error: '' };
  }
  return (
    dockGitCache.get(projectPath) ?? {
      projectPath,
      status: null,
      loading: false,
      ready: false,
      error: '',
    }
  );
}

function loadDockGitState(projectPath: string): Promise<DockGitState> {
  const gitStatus = window.mixdogDesktop?.gitStatus;
  if (typeof gitStatus !== 'function') {
    return Promise.resolve({ projectPath, status: null, loading: false, ready: true, error: '' });
  }
  // Source Control/Search only consume repository, branch and changed-file
  // shape. Line totals belong to Review surfaces, so making this dock wait
  // for two numstat passes and every untracked file read was pure latency.
  return gitStatus(projectPath, { skipLineStats: true }).then(
    (status) => ({ projectPath, status: status ?? null, loading: false, ready: true, error: '' }),
    (reason) => ({
      projectPath,
      status: null,
      loading: false,
      ready: true,
      error: reason instanceof Error ? reason.message : String(reason),
    })
  );
}

export function requestDockGitState(projectPath: string): Promise<DockGitState> {
  const pending = dockGitRequests.get(projectPath);
  if (pending) return pending;
  const request = loadDockGitState(projectPath).then((state) => {
    dockGitCache.set(projectPath, state);
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
