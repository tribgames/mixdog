import { useCallback, useEffect, useRef, useState } from 'react';
import { createGitRefreshScheduler, watchGitRefreshEvidence } from './git-refresh-scheduler';
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
  const refreshDockGitStatus = useCallback(async () => {
    const currentProject = dockProjectPath;
    const epoch = ++gitRequestEpoch.current;
    if (!currentProject) {
      setDockGitState(readCachedDockGitState(''));
      return;
    }
    const next = await requestDockGitState(currentProject);
    if (epoch !== gitRequestEpoch.current) return;
    setDockGitState(next);
  }, [dockProjectPath]);
  // Git I/O follows intent and evidence: a recursive project watcher (with
  // the checkout's git dirs) and explicit Git actions drive every refresh;
  // nothing re-reads on a clock or on window focus.
  const gitSurfaceSelected = tab === 'source-control' || tab === 'pull-requests';
  useEffect(() => {
    if (!open || !contentReady || !dockProjectPath || !gitSurfaceSelected) return undefined;
    const scheduler = createGitRefreshScheduler(refreshDockGitStatus);
    return watchGitRefreshEvidence(dockProjectPath, scheduler);
  }, [contentReady, dockProjectPath, gitSurfaceSelected, open, refreshDockGitStatus]);
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
  const dockGitError = effectiveDockGitState.error;
  return {
    refreshDockGitStatus,
    gitSurfaceSelected,
    dockGitStatus,
    dockGitStatusReady,
    dockGitError,
  };
}
