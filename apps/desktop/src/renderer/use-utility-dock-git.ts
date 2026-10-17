import { useCallback, useEffect, useRef, useState } from 'react';
import { createGitRefreshScheduler } from './git-refresh-scheduler';
import { subscribeProjectFileChanges } from './project-file-changes';
import { readCachedDockGitState, requestDockGitState, type DockGitState } from './utility-dock-git-state';
import type { UtilityDockTab } from './UtilityDock';

/** Shared Git status for the dock's Search / Source Control / Pull Requests
 *  views: request-epoch guarded refresh, the intent-driven refresh scheduler,
 *  and the idle boot warm-up. */
export function useUtilityDockGit({
  dockProjectPath,
  open,
  contentReady,
  tab,
}: {
  dockProjectPath: string;
  open: boolean;
  contentReady: boolean;
  tab: UtilityDockTab;
}) {
  const gitRequestEpoch = useRef(0);
  const [dockGitState, setDockGitState] = useState<DockGitState>(() => readCachedDockGitState(dockProjectPath));
  const refreshDockGitStatus = useCallback(
    async (showLoading = false) => {
      const currentProject = dockProjectPath;
      const epoch = ++gitRequestEpoch.current;
      if (!currentProject) {
        setDockGitState(readCachedDockGitState(''));
        return;
      }
      if (showLoading) {
        setDockGitState((current) => ({
          ...(current.projectPath === currentProject ? current : readCachedDockGitState(currentProject)),
          projectPath: currentProject,
          loading: true,
          // Keep established rows during live refreshes. Entry readiness is
          // tracked separately so retained cache readiness cannot reveal them.
        }));
      }
      const next = await requestDockGitState(currentProject);
      if (epoch !== gitRequestEpoch.current) return;
      setDockGitState(next);
    },
    [dockProjectPath]
  );
  // Git I/O follows intent and evidence. A recursive project watcher plus
  // explicit Git actions drive refreshes; the slow safety lane only protects
  // platforms where native watch delivery is unavailable or overflowed.
  const gitSurfaceSelected = tab === 'source-control' || tab === 'pull-requests';
  useEffect(() => {
    if (!open || !contentReady || !dockProjectPath || !gitSurfaceSelected) return undefined;
    let first = true;
    const scheduler = createGitRefreshScheduler(
      async () => {
        // A cached snapshot paints at once and revalidates in place; only a
        // cold project shows the loading state.
        const showLoading = first && !readCachedDockGitState(dockProjectPath).ready;
        first = false;
        await refreshDockGitStatus(showLoading);
      },
      {
        safetyIntervalMs: 30_000,
        activityDebounceMs: 125,
        activityMinGapMs: 3_000,
        slowTaskMultiplier: 5,
      }
    );
    const signal = () => scheduler.signal();
    const refreshNow = () => scheduler.refreshNow();
    const visibilityChanged = () => {
      if (document.visibilityState === 'hidden') scheduler.pause();
      else scheduler.resume();
    };
    const unsubscribeProject = subscribeProjectFileChanges(dockProjectPath, signal);
    window.addEventListener('focus', refreshNow);
    window.addEventListener('mixdog:git-changed', signal);
    document.addEventListener('visibilitychange', visibilityChanged);
    if (document.visibilityState !== 'hidden') scheduler.resume();
    return () => {
      scheduler.dispose();
      unsubscribeProject();
      window.removeEventListener('focus', refreshNow);
      window.removeEventListener('mixdog:git-changed', signal);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [contentReady, dockProjectPath, gitSurfaceSelected, open, refreshDockGitStatus]);
  // Boot preload (user: 호버 말고 부트 프리로드는 백그라운드에서): the intent
  // rule above still owns live polling, but ONE idle-time gitStatus per
  // project warms the shared snapshot for Search / Pull Requests. Source
  // Control still validates on entry. No interval runs while a Git surface
  // is not selected.
  const warmedGitProject = useRef('');
  useEffect(() => {
    if (!dockProjectPath || gitSurfaceSelected) return undefined;
    if (warmedGitProject.current === dockProjectPath) return undefined;
    if (readCachedDockGitState(dockProjectPath).ready) {
      warmedGitProject.current = dockProjectPath;
      return undefined;
    }
    const host = window as typeof window & {
      requestIdleCallback?(callback: () => void, options?: { timeout: number }): number;
      cancelIdleCallback?(handle: number): void;
    };
    let idle = 0;
    let timer = 0;
    const warm = () => {
      idle = 0;
      timer = 0;
      warmedGitProject.current = dockProjectPath;
      void refreshDockGitStatus();
    };
    if (typeof host.requestIdleCallback === 'function') {
      idle = host.requestIdleCallback(warm, { timeout: 2_000 });
    } else {
      timer = window.setTimeout(warm, 250);
    }
    return () => {
      if (idle) host.cancelIdleCallback?.(idle);
      if (timer) window.clearTimeout(timer);
    };
  }, [dockProjectPath, gitSurfaceSelected, refreshDockGitStatus]);
  const effectiveDockGitState =
    dockGitState.projectPath === dockProjectPath ? dockGitState : readCachedDockGitState(dockProjectPath);
  const dockGitStatus = effectiveDockGitState.status;
  const dockGitStatusReady = !dockProjectPath || effectiveDockGitState.ready;
  const dockGitLoading = effectiveDockGitState.loading;
  const dockGitError = effectiveDockGitState.error;
  return {
    refreshDockGitStatus,
    gitSurfaceSelected,
    dockGitStatus,
    dockGitStatusReady,
    dockGitLoading,
    dockGitError,
  };
}
