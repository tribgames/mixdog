import { useEffect, type Dispatch, type SetStateAction } from 'react';

import type { DesktopApi, DesktopGithubCliLoginFlow, DesktopGithubCliStatus } from '../../shared/contract';

/** Follows a live GitHub CLI device-flow login from its pushed progress. */
export function useGithubLoginPolling({
  host,
  flowId,
  flowState,
  setFlow,
  setStatus,
  refreshStatus,
}: {
  host: Partial<DesktopApi> | undefined;
  flowId: string;
  flowState: string;
  setFlow: Dispatch<SetStateAction<DesktopGithubCliLoginFlow | null>>;
  setStatus: Dispatch<SetStateAction<DesktopGithubCliStatus | null>>;
  refreshStatus: () => Promise<void>;
}): void {
  useEffect(() => {
    if (!flowId || (flowState !== 'pending' && flowState !== 'code')) return undefined;
    let cancelled = false;
    // The flow's progress is pushed on its scoped feed (`login:<flowId>`, desktop-services.md §5.4, §15 P8).
    const unsubscribe = host?.sections?.subscribeLoginUpdated((update) => {
      if (cancelled || update.flowId !== flowId || !update.state) return;
      const next = update.state as DesktopGithubCliLoginFlow;
      setFlow(next);
      if (next.state === 'success') {
        // The core reports success only after `gh auth status` confirmed the
        // account: adopt it now. Waiting for the refresh probe flashed the
        // Sign-in button back for ~1s, and a click there started a second
        // device flow (a new 8-character code).
        setStatus((current) => ({
          installed: true,
          ...current,
          authenticated: true,
          ...(next.login ? { login: next.login } : {}),
        }));
        void refreshStatus();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [host, flowId, flowState, setFlow, setStatus, refreshStatus]);
}
