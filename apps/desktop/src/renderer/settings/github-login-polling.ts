import { useEffect, type Dispatch, type SetStateAction } from 'react';

import type { DesktopApi, DesktopGithubCliLoginFlow, DesktopGithubCliStatus } from '../../shared/contract';

/** Polls a live GitHub CLI device-flow login; a terminal state stops the timer. */
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
    const timer = window.setInterval(() => {
      void host
        ?.githubCliLoginStatus?.(flowId)
        .then((next) => {
          if (cancelled || !next) return;
          setFlow(next);
          if (next.state === 'success') {
            // Main reports success only after `gh auth status` confirmed the
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
        })
        .catch(() => {
          /* transient; the next tick retries */
        });
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [host, flowId, flowState, setFlow, setStatus, refreshStatus]);
}
