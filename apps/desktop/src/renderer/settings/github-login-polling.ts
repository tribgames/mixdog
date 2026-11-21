import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import type {
  DesktopApi,
  DesktopGithubCliAccount,
  DesktopGithubCliLoginFlow,
  DesktopGithubCliStatus,
} from '../../shared/contract';
import { errorMessage } from '../editor-pane-session-errors';
import { getCachedGitPanelInfo, patchCachedGitPanelInfo, preloadGitPanelInfo } from './git-panel-info';

/** The GitHub CLI status and the signed-in account: the cached snapshot first, reconciled by the background probe;
 *  the account is read whenever gh reports authenticated and dropped when it does not. */
export function useGithubCliStatus(
  host: Partial<DesktopApi> | undefined,
  supported: boolean,
  setError: (message: string) => void
) {
  const cached = getCachedGitPanelInfo(host);
  const [status, setStatus] = useState<DesktopGithubCliStatus | null>(cached?.status ?? null);
  const [account, setAccount] = useState<DesktopGithubCliAccount | null>(cached?.account ?? null);
  const refreshStatus = useCallback(async () => {
    if (!host?.githubCliStatus) return;
    try {
      const next = await host.githubCliStatus();
      setStatus(next);
      patchCachedGitPanelInfo(host, { status: next });
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, [host, setError]);
  useEffect(() => {
    if (!supported) return undefined;
    let live = true;
    void preloadGitPanelInfo(host).then((info) => {
      if (!live || !info) return;
      setStatus(info.status);
      setAccount(info.account);
    });
    return () => {
      live = false;
    };
  }, [host, supported]);
  const authenticated = status?.authenticated === true;
  useEffect(() => {
    if (!supported) return undefined;
    if (!authenticated) {
      setAccount(null);
      patchCachedGitPanelInfo(host, { account: null });
      return undefined;
    }
    let live = true;
    void host
      ?.githubCliAccount?.()
      .then((next) => {
        if (!live) return;
        setAccount(next || null);
        patchCachedGitPanelInfo(host, { account: next || null });
      })
      .catch(() => {
        /* the status row still shows the login */
      });
    return () => {
      live = false;
    };
  }, [host, authenticated, supported]);
  return { status, setStatus, account, setAccount, refreshStatus, authenticated };
}

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
