// The GitHub catalog row reuses the GitHub CLI's sign-in instead of an MCP
// sign-in. It counts as a connected connector only after the user confirmed
// the account gh actually runs as (`gh api user`: an environment token such as
// GH_TOKEN may differ from gh's active account). Mixdog never switches gh's
// global account and never logs gh out: removing the connector only forgets
// the confirmation.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getCachedGitPanelInfo, preloadGitPanelInfo } from './settings/git-panel-info';

const STORAGE_KEY = 'mixdog:connector-github';
const CHANGED = 'mixdog:connector-github-changed';
export const GITHUB_HOST = 'github.com';

export interface GithubConnection {
  /** `connected` (confirmed for this account), `unconfirmed` (gh signed in,
   *  not confirmed here or confirmed for another account), `signed-out`. */
  state: 'connected' | 'unconfirmed' | 'signed-out';
  host: string;
  /** The account gh runs as (what agents' gh calls use). */
  login: string;
  /** gh's active account when it differs from `login` (an env token wins). */
  activeLogin: string;
}

function confirmedLogin(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function setConfirmed(login: string): void {
  try {
    if (login) window.localStorage.setItem(STORAGE_KEY, login);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable: the row asks again */
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** 연결 after the account confirmation: GitHub runs as `login`. */
export function confirmGithubConnector(login: string): void {
  setConfirmed(login);
}

/** 연결 해제: forget the confirmation; gh itself stays signed in. */
export function forgetGithubConnector(): void {
  setConfirmed('');
}

type Info = Awaited<ReturnType<typeof preloadGitPanelInfo>> | undefined;

export function githubConnection(info: Info, confirmed = confirmedLogin()): GithubConnection | null {
  if (!info?.status) return null;
  const activeLogin = info.status.authenticated ? String(info.status.login || '') : '';
  const login = info.account?.login || activeLogin;
  if (!info.status.authenticated || !login) {
    return { state: 'signed-out', host: GITHUB_HOST, login: '', activeLogin: '' };
  }
  return {
    state: confirmed && confirmed === login ? 'connected' : 'unconfirmed',
    host: GITHUB_HOST,
    login,
    activeLogin: activeLogin && activeLogin !== login ? activeLogin : '',
  };
}

const subscribe = (listener: () => void) => {
  window.addEventListener(CHANGED, listener);
  return () => window.removeEventListener(CHANGED, listener);
};

/** The GitHub connector's state, re-read when gh's sign-in is re-probed. */
export function useGithubConnection(refreshKey = 0): GithubConnection | null {
  const api = window.mixdogDesktop;
  const confirmed = useSyncExternalStore(subscribe, confirmedLogin, () => '');
  const [info, setInfo] = useState<Info>(() => getCachedGitPanelInfo(api));
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey re-probes gh on demand.
  useEffect(() => {
    let live = true;
    void preloadGitPanelInfo(api).then((next) => {
      if (live && next) setInfo(next);
    });
    return () => {
      live = false;
    };
  }, [api, refreshKey]);
  return githubConnection(info, confirmed);
}
