import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  DesktopApi,
  DesktopGithubCliAccount,
  DesktopGithubCliLoginFlow,
  DesktopGitGlobalConfig,
} from '../../shared/contract';
import { useErrorToast } from '../notifications';
import { ErrorNotice } from '../ErrorNotice';
import { t } from '../i18n';
import { subscribeSetupChanges } from '../setup-change-refresh';

import {
  ExtensionAction,
  ExtensionItemList,
  ExtensionItemRow,
  ExtensionNote,
  ExtensionSection,
  type ExtensionItemTone,
} from './extension-detail';
import { patchCachedGitPanelInfo } from './git-panel-info';
import { GithubDeviceCodeText, useGithubDeviceCode } from './github-device-code';
import { useGithubCliStatus, useGithubLoginPolling } from './github-login-polling';
import { errorMessage } from '../editor-pane-session-errors';
import { desktopBridge, openExternalOn } from './desktop-bridge';

const CLI_DOWNLOAD_URL = 'https://cli.github.com';

function cliStatusView(
  loading: boolean,
  status: { installed?: boolean; authenticated?: boolean } | null
): { label: string; tone: ExtensionItemTone } {
  if (loading) return { label: t('Checking…'), tone: 'muted' };
  if (!status?.installed) return { label: t('Not installed'), tone: 'warn' };
  return status.authenticated ? { label: t('Connected'), tone: 'ok' } : { label: t('Not connected'), tone: 'off' };
}
/** No Identity UI: the git identity syncs itself from the connected account — on a fresh machine with no identity
 *  at all, and after every explicit Connect (once per flow, even over an existing manual identity). */
function useGitIdentitySync({
  host,
  account,
  config,
  setConfig,
  flowId,
  flowState,
}: {
  host: Partial<DesktopApi> | undefined;
  account: DesktopGithubCliAccount | null;
  config: DesktopGitGlobalConfig | null;
  setConfig(next: DesktopGitGlobalConfig): void;
  flowId: string;
  flowState: string;
}) {
  const appliedGithubIdentity = useRef(false);
  const loginAppliedFlow = useRef('');
  const adoptAccountIdentity = useCallback(
    async (identity: DesktopGithubCliAccount) => {
      try {
        await host?.setGitGlobalConfig?.('user.name', identity.name);
        const next = await host?.setGitGlobalConfig?.('user.email', identity.email);
        if (next) setConfig(next);
      } catch {
        /* git config stays as it was */
      }
    },
    [host, setConfig]
  );
  useEffect(() => {
    if (!account || !config || appliedGithubIdentity.current) return;
    if (config.name || config.email) return;
    appliedGithubIdentity.current = true;
    void adoptAccountIdentity(account);
  }, [account, config, adoptAccountIdentity]);
  useEffect(() => {
    if (flowState !== 'success' || !flowId || !account) return;
    if (loginAppliedFlow.current === flowId) return;
    loginAppliedFlow.current = flowId;
    void adoptAccountIdentity(account);
  }, [flowState, flowId, account, adoptAccountIdentity]);
}

export function GitPanel({ api }: { api?: Partial<DesktopApi> } = {}) {
  const host = api ?? desktopBridge();
  const supported = Boolean(host?.githubCliStatus);
  const [config, setConfig] = useState<DesktopGitGlobalConfig | null>(null);
  const [flow, setFlow] = useState<DesktopGithubCliLoginFlow | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useErrorToast(error, 'git-settings');
  const { status, setStatus, account, refreshStatus } = useGithubCliStatus(host, supported, setError);

  useEffect(() => {
    let live = true;
    const readConfig = () =>
      void host
        ?.gitGlobalConfig?.()
        .then((next) => {
          if (live) setConfig(next);
        })
        .catch(() => {});
    readConfig();
    // A Git identity written elsewhere (host or another client) re-reads here.
    const unsubscribe = subscribeSetupChanges(readConfig);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [host]);

  // Follow the live flow until the host reports an outcome or acknowledges cancellation.
  const flowId = flow?.flowId || '';
  const flowState = flow?.state || '';
  useGithubLoginPolling({ host, flowId, flowState, setFlow, setStatus, refreshStatus });
  const deviceCode = useGithubDeviceCode(host, flow, (url) => openExternalOn(host, url));

  useGitIdentitySync({ host, account, config, setConfig, flowId, flowState });

  if (!supported) {
    return <ExtensionNote>{t('Git and GitHub settings are managed in the desktop app.')}</ExtensionNote>;
  }

  const act = (key: string, action: () => Promise<unknown> | undefined) => {
    setBusy(key);
    setError('');
    void Promise.resolve(action())
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setBusy(''));
  };
  const open = (url: string) => openExternalOn(host, url);
  const loading = status === null;
  const busyAny = Boolean(busy);
  const flowLive = flowState === 'pending' || flowState === 'code';
  const canConnect = typeof host?.githubCliLoginStart === 'function' && typeof host.githubCliLoginCancel === 'function';
  const cli = cliStatusView(loading, status);

  // Same grammar as every other Extensions card: sections of item rows whose
  // controls sit on the trailing edge, notes under them, previews as quiet
  // blocks.
  return (
    <ExtensionSection
      title={t('GitHub')}
      description={t('Uses GitHub CLI (gh) for PRs and repos, and signs your commits.')}
    >
      <ExtensionItemList>
        <ExtensionItemRow
          title="GitHub CLI"
          description={status?.installed ? `gh ${status.version || ''}`.trim() : undefined}
          status={cli.label}
          tone={cli.tone}
          control={
            <>
              {!loading && !status?.installed && (
                <ExtensionAction
                  disabled={busyAny}
                  onClick={() =>
                    act('install', () =>
                      host?.installGithubCli?.().then((next) => {
                        setStatus(next);
                        patchCachedGitPanelInfo(host, { status: next });
                      })
                    )
                  }
                >
                  {busy === 'install' ? t('Installing…') : t('Install')}
                </ExtensionAction>
              )}
              {!loading && !status?.installed && (
                <ExtensionAction disabled={busyAny} onClick={() => open(CLI_DOWNLOAD_URL)}>
                  {t('Download ↗')}
                </ExtensionAction>
              )}
              {status?.installed && !status.authenticated && !flowLive && (
                <ExtensionAction
                  disabled={busyAny || !canConnect}
                  onClick={() =>
                    act('connect', () =>
                      host?.githubCliLoginStart?.().then((started) => {
                        if (started) setFlow(started);
                      })
                    )
                  }
                >
                  {t('Connect')}
                </ExtensionAction>
              )}
              {flowLive && deviceCode.active && (
                <ExtensionAction
                  disabled={busyAny}
                  onClick={deviceCode.opened ? deviceCode.reopen : deviceCode.openGithub}
                >
                  {deviceCode.opened ? t('Open GitHub again ↗') : t('Copy & open GitHub ↗')}
                </ExtensionAction>
              )}
              {flowLive && (
                <ExtensionAction
                  danger
                  disabled={busyAny}
                  onClick={() =>
                    act('cancel', () =>
                      host?.githubCliLoginCancel?.(flowId).then(() => {
                        setFlow((current) => (current?.flowId === flowId ? null : current));
                      })
                    )
                  }
                >
                  {t('Cancel')}
                </ExtensionAction>
              )}
              {status?.authenticated && (
                <ExtensionAction
                  danger
                  disabled={busyAny}
                  onClick={() =>
                    act('logout', () =>
                      host?.githubCliLogout?.().then((next) => {
                        setStatus(next);
                        setFlow(null);
                        patchCachedGitPanelInfo(host, { status: next, account: null });
                      })
                    )
                  }
                >
                  {busy === 'logout' ? t('Disconnecting…') : t('Disconnect')}
                </ExtensionAction>
              )}
            </>
          }
        />
        {status?.authenticated && (account || status.login) && (
          <ExtensionItemRow
            title={t('Account')}
            description={account ? `${account.name} <${account.email}>` : status.login || ''}
          />
        )}
      </ExtensionItemList>
      {flowLive &&
        (deviceCode.active ? (
          <GithubDeviceCodeText state={deviceCode} />
        ) : (
          <ExtensionNote role="status">{t('Starting GitHub sign-in…')}</ExtensionNote>
        ))}
      {flowState === 'error' && <ErrorNotice error={flow?.message || t('Sign-in failed')} />}
    </ExtensionSection>
  );
}
