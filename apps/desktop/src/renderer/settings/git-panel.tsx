// Built-in Git & GitHub: GitHub CLI status/install/device-flow login and the
// global git identity sourced from the signed-in GitHub account. The Connect
// flow follows the Providers OAuth grammar: start → one-time code card →
// status polling until a terminal state; gh itself opens the browser.
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  DesktopApi,
  DesktopGithubCliAccount,
  DesktopGithubCliLoginFlow,
  DesktopGithubCliStatus,
  DesktopGitGlobalConfig,
} from '../../shared/contract';
import { useErrorToast } from '../notifications';
import { ErrorNotice } from '../ErrorNotice';
import { t } from '../i18n';

import {
  ExtensionAction,
  ExtensionItemList,
  ExtensionItemRow,
  ExtensionNote,
  ExtensionSection,
  type ExtensionItemTone,
} from './extension-detail';
import {
  getCachedGitPanelInfo,
  patchCachedGitPanelInfo,
  preloadGitPanelInfo,
} from './git-panel-info';

const CLI_DOWNLOAD_URL = 'https://cli.github.com';
export function GitPanel({ api }: { api?: Partial<DesktopApi> } = {}) {
  const host = api ?? (window as unknown as { mixdogDesktop?: DesktopApi }).mixdogDesktop;
  const supported = Boolean(host?.githubCliStatus);
  // Cached snapshot first (user: 캐시해서 툭 나오지 않게): the panel paints its
  // last known rows immediately; the background probe reconciles afterwards.
  const cachedInfo = getCachedGitPanelInfo(host);
  const [status, setStatus] = useState<DesktopGithubCliStatus | null>(cachedInfo?.status ?? null);
  const [config, setConfig] = useState<DesktopGitGlobalConfig | null>(null);
  const [account, setAccount] = useState<DesktopGithubCliAccount | null>(cachedInfo?.account ?? null);
  const appliedGithubIdentity = useRef(false);
  const loginAppliedFlow = useRef('');
  const [flow, setFlow] = useState<DesktopGithubCliLoginFlow | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useErrorToast(error, 'git-settings');

  const refreshStatus = useCallback(async () => {
    if (!host?.githubCliStatus) return;
    try {
      const next = await host.githubCliStatus();
      setStatus(next);
      patchCachedGitPanelInfo(host, { status: next });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [host]);

  useEffect(() => {
    let live = true;
    // Stale-while-revalidate: the cached snapshot painted already; this probe
    // reconciles it.
    void preloadGitPanelInfo(host).then((info) => {
      if (!live || !info) return;
      setStatus(info.status);
      setAccount(info.account);
    });
    void host?.gitGlobalConfig?.().then((next) => { if (live) setConfig(next); }).catch(() => {});
    return () => { live = false; };
  }, [host]);

  // Poll the login flow while it is live; a terminal state stops the timer.
  const flowId = flow?.flowId || '';
  const flowState = flow?.state || '';
  useEffect(() => {
    if (!flowId || (flowState !== 'pending' && flowState !== 'code')) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void host?.githubCliLoginStatus?.(flowId).then((next) => {
        if (cancelled || !next) return;
        setFlow(next);
        if (next.state === 'success') void refreshStatus();
      }).catch(() => { /* transient; the next tick retries */ });
    }, 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [flowId, flowState, host, refreshStatus]);

  // The signed-in GitHub account is the identity source of truth (user
  // decision): load it whenever gh reports authenticated.
  const authenticated = status?.authenticated === true;
  useEffect(() => {
    if (!authenticated) {
      setAccount(null);
      patchCachedGitPanelInfo(host, { account: null });
      return undefined;
    }
    let live = true;
    void host?.githubCliAccount?.()
      .then((next) => {
        if (!live) return;
        setAccount(next || null);
        patchCachedGitPanelInfo(host, { account: next || null });
      })
      .catch(() => { /* the manual identity rows remain */ });
    return () => { live = false; };
  }, [authenticated, host]);
  // No Identity UI (user decision: 연동하면 자동으로): the git identity syncs
  // itself from the connected account — on a fresh machine with no identity
  // at all, and after every explicit Connect.
  useEffect(() => {
    if (!account || !config || appliedGithubIdentity.current) return;
    if (config.name || config.email) return;
    appliedGithubIdentity.current = true;
    void (async () => {
      try {
        await host?.setGitGlobalConfig?.('user.name', account.name);
        const next = await host?.setGitGlobalConfig?.('user.email', account.email);
        if (next) setConfig(next);
      } catch { /* git config stays as it was */ }
    })();
  }, [account, config, host]);
  useEffect(() => {
    // A completed Connect is an explicit identity choice: adopt the account
    // even over an existing manual identity, once per flow.
    if (flowState !== 'success' || !flowId || !account) return;
    if (loginAppliedFlow.current === flowId) return;
    loginAppliedFlow.current = flowId;
    void (async () => {
      try {
        await host?.setGitGlobalConfig?.('user.name', account.name);
        const next = await host?.setGitGlobalConfig?.('user.email', account.email);
        if (next) setConfig(next);
      } catch { /* git config stays as it was */ }
    })();
  }, [flowState, flowId, account, host]);

  if (!supported) {
    return <ExtensionNote>{t('Git and GitHub settings are managed in the desktop app.')}</ExtensionNote>;
  }

  const act = (key: string, action: () => Promise<unknown> | undefined) => {
    setBusy(key);
    setError('');
    void Promise.resolve(action())
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(''));
  };
  const open = (url: string) => void host?.openExternal?.(url).catch(() => undefined);
  const loading = status === null;
  const busyAny = Boolean(busy);
  const flowLive = flowState === 'pending' || flowState === 'code';
  const cliStatus = loading ? t('Checking…')
    : !status?.installed ? t('Not installed')
    : status.authenticated ? t('Connected') : t('Not connected');
  const cliTone: ExtensionItemTone = loading ? 'muted'
    : !status?.installed ? 'warn'
    : status.authenticated ? 'ok' : 'off';

  // Same grammar as every other Extensions card: sections of item rows whose
  // controls sit on the trailing edge, notes under them, previews as quiet
  // blocks. The settings page's Group/ResourceRow/ToggleRow primitives are
  // gone from here (user: 팝업 디자인 리뉴얼, 우리 테마에 맞게).
  return <>
    <ExtensionSection title={t('GitHub')}
      description={t('The GitHub CLI (gh) powers pull requests and repository actions. Connecting signs it in and authors your commits with this account.')}>
      <ExtensionItemList>
        <ExtensionItemRow title="GitHub CLI"
          description={status?.installed ? `gh ${status.version || ''}`.trim() : undefined}
          status={cliStatus} tone={cliTone}
          control={<>
            {!loading && !status?.installed && <ExtensionAction disabled={busyAny}
              onClick={() => act('install', () => host?.installGithubCli?.()
                .then((next) => {
                  setStatus(next);
                  patchCachedGitPanelInfo(host, { status: next });
                }))}>
              {busy === 'install' ? t('Installing…') : t('Install')}
            </ExtensionAction>}
            {!loading && !status?.installed && <ExtensionAction disabled={busyAny}
              onClick={() => open(CLI_DOWNLOAD_URL)}>{t('Download ↗')}</ExtensionAction>}
            {status?.installed && !status.authenticated && !flowLive &&
              <ExtensionAction disabled={busyAny} onClick={() => act('connect', () =>
                host?.githubCliLoginStart?.().then((started) => { if (started) setFlow(started); }),
              )}>{t('Connect')}</ExtensionAction>}
            {flowLive && <ExtensionAction danger disabled={busyAny} onClick={() => {
              const id = flowId;
              setFlow(null);
              act('cancel', () => host?.githubCliLoginCancel?.(id));
            }}>{t('Cancel')}</ExtensionAction>}
            {status?.authenticated && <ExtensionAction danger disabled={busyAny}
              onClick={() => act('logout', () => host?.githubCliLogout?.()
                .then((next) => {
                  setStatus(next);
                  setFlow(null);
                  patchCachedGitPanelInfo(host, { status: next, account: null });
                }))}>
              {busy === 'logout' ? t('Disconnecting…') : t('Disconnect')}
            </ExtensionAction>}
          </>} />
        {status?.authenticated && (account || status.login) &&
          <ExtensionItemRow title={t('Account')}
            description={account ? `${account.name} <${account.email}>` : status.login || ''} />}
      </ExtensionItemList>
      {flowLive && <ExtensionNote role="status">
        {flow?.code
          ? <>
            {t('Enter this code at github.com/login/device — the browser should open by itself.')}
            {' '}<code><b>{flow.code}</b></code>{' '}
            <ExtensionAction onClick={() => open(flow.url || 'https://github.com/login/device')}>
              {t('Open github.com ↗')}
            </ExtensionAction>
          </>
          : t('Starting GitHub sign-in…')}
      </ExtensionNote>}
      {flowState === 'error' && <ErrorNotice error={flow?.message || t('Sign-in failed')} />}
    </ExtensionSection>
  </>;
}
