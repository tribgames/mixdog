// Settings → Git (desktop-only): GitHub CLI status/install/device-flow login,
// the commit format preset (ghost-text preview, never inserted), and the
// global git identity sourced from the signed-in GitHub account. The Connect
// flow follows the Providers OAuth grammar: start → one-time code card →
// status polling until a terminal state; gh itself opens the browser.
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  DesktopApi,
  DesktopGithubCliAccount,
  DesktopGithubCliLoginFlow,
  DesktopGithubCliStatus,
  DesktopGitCommitPreset,
  DesktopGitGlobalConfig,
} from '../../shared/contract';
import { showDesktopToast } from '../notifications';

import { ActionButton, FormRow, Group, ResourceRow, SelectRow, ToggleRow } from './capability-controls';
import {
  getCachedGitPanelInfo,
  patchCachedGitPanelInfo,
  preloadGitPanelInfo,
  publishGitPreferences,
} from './git-panel-info';

const CLI_DOWNLOAD_URL = 'https://cli.github.com';
// Mirrored by SourceControlDock's summary placeholder.
const CONVENTIONAL_PATTERN = 'feat(scope): summary';

export function GitPanel() {
  const host = (window as unknown as { mixdogDesktop?: DesktopApi }).mixdogDesktop;
  const supported = Boolean(host?.githubCliStatus);
  // Cached snapshot first (user: 캐시해서 툭 나오지 않게): the panel paints its
  // last known rows immediately; the background probe reconciles afterwards.
  const cachedInfo = getCachedGitPanelInfo(host);
  const [status, setStatus] = useState<DesktopGithubCliStatus | null>(cachedInfo?.status ?? null);
  const [config, setConfig] = useState<DesktopGitGlobalConfig | null>(null);
  const [account, setAccount] = useState<DesktopGithubCliAccount | null>(cachedInfo?.account ?? null);
  const [preset, setPreset] = useState<DesktopGitCommitPreset>(
    cachedInfo?.preferences?.commitPreset ?? 'none');
  const [autoCommit, setAutoCommit] = useState(
    cachedInfo?.preferences ? cachedInfo.preferences.autoCommitMessage === true : true);
  const [customDraft, setCustomDraft] = useState(cachedInfo?.preferences?.commitTemplate ?? '');
  const [customSaved, setCustomSaved] = useState(cachedInfo?.preferences?.commitTemplate ?? '');
  const customSavedRef = useRef(customSaved);
  useEffect(() => { customSavedRef.current = customSaved; }, [customSaved]);
  const appliedGithubIdentity = useRef(false);
  const loginAppliedFlow = useRef('');
  const [flow, setFlow] = useState<DesktopGithubCliLoginFlow | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (error) showDesktopToast(error, 'error');
  }, [error]);

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
    // reconciles it. The custom-pattern draft only adopts the fresh value
    // when it carries no unsaved edits.
    void preloadGitPanelInfo(host).then((info) => {
      if (!live || !info) return;
      setStatus(info.status);
      setAccount(info.account);
      setPreset(info.preferences?.commitPreset ?? 'none');
      setAutoCommit(info.preferences ? info.preferences.autoCommitMessage === true : true);
      const template = String(info.preferences?.commitTemplate ?? '');
      setCustomDraft((current) => (current === customSavedRef.current ? template : current));
      setCustomSaved(template);
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
    return <Group title="Git">
      <p className="settings-connection-note">
        Git and GitHub settings are managed in the desktop app.
      </p>
    </Group>;
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

  return <>
    <Group title="GitHub"
      description="The GitHub CLI (gh) powers pull requests and repository actions. Connecting signs it in and authors your commits with this account.">
      <ResourceRow title="GitHub CLI"
        meta={status?.installed ? `gh ${status.version || ''}`.trim() : undefined}
        status={loading ? 'Checking…' : !status?.installed ? 'Not installed'
          : status.authenticated ? 'Connected' : 'Not connected'}
        actions={<>
          {!loading && !status?.installed && <ActionButton disabled={busyAny}
            onClick={() => act('install', () => host?.installGithubCli?.()
              .then((next) => {
                setStatus(next);
                patchCachedGitPanelInfo(host, { status: next });
              }))}>
            {busy === 'install' ? 'Installing…' : 'Install'}
          </ActionButton>}
          {!loading && !status?.installed && <ActionButton disabled={busyAny}
            onClick={() => open(CLI_DOWNLOAD_URL)}>Download ↗</ActionButton>}
          {status?.installed && !status.authenticated && !flowLive &&
            <ActionButton disabled={busyAny} onClick={() => act('connect', () =>
              host?.githubCliLoginStart?.().then((started) => { if (started) setFlow(started); }),
            )}>Connect</ActionButton>}
          {flowLive && <ActionButton danger disabled={busyAny} onClick={() => {
            const id = flowId;
            setFlow(null);
            act('cancel', () => host?.githubCliLoginCancel?.(id));
          }}>Cancel</ActionButton>}
          {status?.authenticated && <ActionButton danger disabled={busyAny}
            onClick={() => act('logout', () => host?.githubCliLogout?.()
              .then((next) => {
                setStatus(next);
                setFlow(null);
                patchCachedGitPanelInfo(host, { status: next, account: null });
              }))}>
            {busy === 'logout' ? 'Disconnecting…' : 'Disconnect'}
          </ActionButton>}
        </>} />
      {status?.authenticated && (account || status.login) &&
        <ResourceRow title="Account"
          meta={account ? `${account.name} <${account.email}>` : status.login || ''} />}
      {flowLive && <p className="settings-connection-note" role="status">
        {flow?.code
          ? <>Enter code <code><b>{flow.code}</b></code> at github.com/login/device — the
            browser should open by itself. <ActionButton
              onClick={() => open(flow.url || 'https://github.com/login/device')}>
              Open github.com ↗</ActionButton></>
          : 'Starting GitHub sign-in…'}
      </p>}
      {flowState === 'error' && <p className="settings-connection-note" role="alert">
        Sign-in failed: {flow?.message || 'unknown error'}
      </p>}
    </Group>
    <Group title="Commit messages"
      description="The chosen format shows as ghost text in the Source Control commit form — it is never inserted into your message.">
      <SelectRow title="Format" value={preset} disabled={busyAny}
        options={[
          { value: 'none', label: 'None' },
          { value: 'conventional', label: 'Conventional Commits' },
          { value: 'custom', label: 'Custom' },
        ]}
        onChange={(next) => {
          const value = next as DesktopGitCommitPreset;
          setPreset(value);
          act('preset', () => host?.updateGitPreferences?.({ commitPreset: value })
            .then((saved) => { if (saved) publishGitPreferences(host, saved); }));
        }} />
      <ToggleRow title="Auto commit message"
        description="Committing with an empty summary writes the message from the included changes (maintenance model), then commits."
        checked={autoCommit} disabled={busyAny}
        onChange={(enabled) => {
          setAutoCommit(enabled);
          act('auto-commit', () => host?.updateGitPreferences?.({ autoCommitMessage: enabled })
            .then((saved) => { if (saved) publishGitPreferences(host, saved); }));
        }} />
      {preset === 'custom' && <FormRow title="Custom pattern"
        status={customDraft === customSaved ? undefined : 'Unsaved'}
        onSubmit={() => act('template', () =>
          host?.updateGitPreferences?.({ commitTemplate: customDraft }).then((next) => {
            const value = String(next?.commitTemplate ?? customDraft);
            setCustomDraft(value);
            setCustomSaved(value);
            if (next) publishGitPreferences(host, next);
          }))}>
        <textarea name="commitTemplate" aria-label="Custom commit pattern" rows={2}
          value={customDraft} placeholder={CONVENTIONAL_PATTERN}
          onChange={(event) => setCustomDraft(event.currentTarget.value)} />
        <button disabled={busyAny || customDraft === customSaved}>Save</button>
      </FormRow>}
      {preset !== 'none' && (() => {
        const lines = (preset === 'conventional' ? CONVENTIONAL_PATTERN : customSaved).split('\n');
        const summaryHint = (lines[0] || '').trim();
        const descriptionHint = lines.slice(1).join(' ').trim();
        return <p className="settings-connection-note" role="status">
          Preview — Summary: <code>{summaryHint || '(empty)'}</code>
          {descriptionHint ? <> · Description: <code>{descriptionHint}</code></> : null}
          {preset === 'conventional' && <>
            <br />Types: feat · fix · docs · style · refactor · perf · test · build · ci · chore
          </>}
        </p>;
      })()}
    </Group>
  </>;
}
