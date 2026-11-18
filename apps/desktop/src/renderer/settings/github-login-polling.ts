import { useEffect, type Dispatch, type SetStateAction } from 'react';

import type { DesktopApi, DesktopGithubCliLoginFlow, DesktopGithubCliStatus } from '../../shared/contract';

/** Follows the scoped login feed, or reads the host's flow status if the feed is missing or lost. */
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
    let settled = false;
    let recovering = false;
    let pushed = false;
    let timer: number | undefined;
    const adopt = (next: DesktopGithubCliLoginFlow | null | undefined) => {
      if (cancelled || settled || next?.flowId !== flowId) return;
      settled = next.state === 'success' || next.state === 'error';
      if (settled) window.clearTimeout(timer);
      setFlow((current) => {
        if (current?.flowId !== flowId || current.state === 'success' || current.state === 'error') return current;
        if (current.state === 'code' && next.state === 'pending') return current;
        return next;
      });
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
    };
    const recover = () => {
      if (cancelled || settled || recovering || !host?.githubCliLoginStatus) return;
      recovering = true;
      const readStatus = async () => {
        try {
          adopt(await host.githubCliLoginStatus?.(flowId));
        } catch {
          // A failed read says nothing about the flow. Keep the last known state and try again.
        }
        if (!cancelled && !settled) timer = window.setTimeout(() => void readStatus(), 1500);
      };
      void readStatus();
    };
    const sections = host?.sections;
    const unsubscribe = sections?.subscribeLoginUpdated?.((update) => {
      if (update.flowId !== flowId) return;
      pushed = true;
      adopt(update.state as DesktopGithubCliLoginFlow);
    });
    const stopLost = sections?.subscribeLoginFeedLost?.((lost) => {
      if (lost.flowId === flowId) recover();
    });
    if (unsubscribe && stopLost && sections?.loginFeed) {
      void sections.loginFeed(flowId).then(({ state, lost }) => {
        const next = state as DesktopGithubCliLoginFlow | null;
        if (!pushed || next?.state === 'success' || next?.state === 'error') adopt(next);
        if (lost) recover();
      }, recover);
    } else {
      recover();
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unsubscribe?.();
      stopLost?.();
    };
  }, [host, flowId, flowState, setFlow, setStatus, refreshStatus]);
}
