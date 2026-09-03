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
import { t } from '../i18n';

import { ActionButton, FormRow, Group, ResourceRow, SelectRow, ToggleRow } from './capability-controls';
import {
  createGitPreferenceSaveQueue,
  type GitPreferenceField,
} from './git-preference-save';
import {
  getCachedGitPanelInfo,
  patchCachedGitPanelInfo,
  preloadGitPanelInfo,
  publishGitPreferences,
} from './git-panel-info';

const CLI_DOWNLOAD_URL = 'https://cli.github.com';
// Mirrored by SourceControlDock's summary placeholder.
const CONVENTIONAL_PATTERN = 'feat(scope): summary';

function customExample(preferences: {
  commitExample?: string;
} | null | undefined): string {
  return String(preferences?.commitExample || '');
}

function customInstructions(preferences: {
  commitInstructions?: string;
} | null | undefined): string {
  return String(preferences?.commitInstructions || '');
}

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
  const [exampleDraft, setExampleDraft] = useState(customExample(cachedInfo?.preferences));
  const [exampleSaved, setExampleSaved] = useState(customExample(cachedInfo?.preferences));
  const [instructionsDraft, setInstructionsDraft] = useState(
    customInstructions(cachedInfo?.preferences));
  const [instructionsSaved, setInstructionsSaved] = useState(
    customInstructions(cachedInfo?.preferences));
  const customSavedRef = useRef({ example: exampleSaved, instructions: instructionsSaved });
  useEffect(() => {
    customSavedRef.current = { example: exampleSaved, instructions: instructionsSaved };
  }, [exampleSaved, instructionsSaved]);
  const appliedGithubIdentity = useRef(false);
  const loginAppliedFlow = useRef('');
  const [flow, setFlow] = useState<DesktopGithubCliLoginFlow | null>(null);
  const [busy, setBusy] = useState('');
  const [preferenceBusy, setPreferenceBusy] = useState<
    Partial<Record<GitPreferenceField, boolean>>
  >({});
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
      const example = customExample(info.preferences);
      const instructions = customInstructions(info.preferences);
      setExampleDraft((current) =>
        current === customSavedRef.current.example ? example : current);
      setInstructionsDraft((current) =>
        current === customSavedRef.current.instructions ? instructions : current);
      setExampleSaved(example);
      setInstructionsSaved(instructions);
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

  const preferenceSaverRef = useRef<{
    host: typeof host;
    saver: ReturnType<typeof createGitPreferenceSaveQueue>;
  } | null>(null);
  if (!preferenceSaverRef.current || preferenceSaverRef.current.host !== host) {
    preferenceSaverRef.current = {
      host,
      saver: createGitPreferenceSaveQueue({
        update: async (patch) => {
          if (!host?.updateGitPreferences) throw new Error('Git preferences are unavailable.');
          return await host.updateGitPreferences(patch);
        },
        read: async () => {
          if (!host?.readGitPreferences) throw new Error('Git preferences are unavailable.');
          return await host.readGitPreferences();
        },
        onBusy: (field, saving) => setPreferenceBusy((current) => ({
          ...current,
          [field]: saving,
        })),
        onResult: (field, preferences, context) => {
          if (field === 'preset' && context.recovered) {
            setPreset(preferences.commitPreset);
          } else if (field === 'auto' && context.recovered) {
            setAutoCommit(preferences.autoCommitMessage);
          } else if (field === 'custom') {
            const example = customExample(preferences);
            const instructions = customInstructions(preferences);
            setExampleSaved(example);
            setInstructionsSaved(instructions);
            if (context.recovered) {
              const submittedExample = String(context.patch.commitExample || '');
              const submittedInstructions = String(context.patch.commitInstructions || '');
              setExampleDraft((current) => current === submittedExample ? example : current);
              setInstructionsDraft((current) =>
                current === submittedInstructions ? instructions : current);
            }
          }
          if (context.publish) publishGitPreferences(host, preferences);
        },
        onError: (reason) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
      }),
    };
  }
  const preferenceSaver = preferenceSaverRef.current.saver;

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
      description={t('Choose how manual commit hints and AI-generated messages should be written.')}>
      <SelectRow title="Format" value={preset} disabled={preferenceBusy.preset === true}
        options={[
          { value: 'none', label: t('Plain') },
          { value: 'conventional', label: t('Conventional Commits') },
          { value: 'custom', label: t('Custom instructions') },
        ]}
        onChange={(next) => {
          const value = next as DesktopGitCommitPreset;
          setPreset(value);
          setError('');
          void preferenceSaver.save('preset', { commitPreset: value });
        }} />
      {preferenceBusy.preset && <p className="settings-git-inline-status" role="status">
        {t('Saving format…')}
      </p>}
      <ToggleRow title="Auto commit message"
        description="Committing with an empty summary writes the message from the included changes (maintenance model), then commits."
        checked={autoCommit} disabled={preferenceBusy.auto === true}
        onChange={(enabled) => {
          setAutoCommit(enabled);
          setError('');
          void preferenceSaver.save('auto', { autoCommitMessage: enabled });
        }} />
      {preferenceBusy.auto && <p className="settings-git-inline-status" role="status">
        {t('Saving auto-message setting…')}
      </p>}
      {preset === 'none' && <div className="settings-commit-rule-card">
        <b>{t('Plain')}</b>
        <p>{t('Write any summary and optional description. No format validation is applied.')}</p>
        <code>Improve settings save recovery</code>
      </div>}
      {preset === 'conventional' && <div className="settings-commit-rule-grid">
        <article><b>{t('Format')}</b><code>type(scope)!: description</code></article>
        <article><b>{t('Types')}</b><p>{t('feat, fix, docs, refactor, test, build, ci, chore, revert, or a custom lowercase type.')}</p></article>
        <article><b>{t('Scope and breaking changes')}</b><p>{t('Scope is optional. Add')} <code>!</code> {t('before')} <code>:</code> {t('for a breaking change.')}</p></article>
        <article><b>{t('Body')}</b><p>{t('Optional details start after one blank line. Manual messages warn but remain committable.')}</p></article>
        <article className="settings-commit-rule-preview"><b>{t('Actual preview')}</b>
          <code>feat(settings)!: preserve saves during daemon recovery{'\n\n'}Keep unrelated inputs editable while reconnecting.</code>
        </article>
      </div>}
      {preset === 'custom' && <FormRow title={t('Custom instructions')}
        status={preferenceBusy.custom
          ? t('Saving')
          : exampleDraft === exampleSaved && instructionsDraft === instructionsSaved
            ? undefined : 'Unsaved'}
        onSubmit={() => {
          setError('');
          void preferenceSaver.save('custom', {
            commitExample: exampleDraft,
            commitInstructions: instructionsDraft,
          });
        }}>
        <div className="settings-commit-custom-fields">
          <label><span>{t('Example commit message')}</span>
            <textarea name="commitExample" aria-label={t('Example commit message')} rows={2}
              value={exampleDraft} placeholder={CONVENTIONAL_PATTERN}
              onChange={(event) => setExampleDraft(event.currentTarget.value)} />
          </label>
          <label><span>{t('AI instructions')}</span>
            <textarea name="commitInstructions" aria-label={t('AI commit message instructions')} rows={4}
              value={instructionsDraft}
              placeholder={t('Describe the tone, structure, and details the AI should include.')}
              onChange={(event) => setInstructionsDraft(event.currentTarget.value)} />
          </label>
          <button disabled={preferenceBusy.custom
            || (exampleDraft === exampleSaved && instructionsDraft === instructionsSaved)}>
            {preferenceBusy.custom ? t('Saving…') : t('Save')}
          </button>
        </div>
      </FormRow>}
      {preset === 'custom' && <div className="settings-commit-rule-card">
        <b>{t('Actual preview')}</b>
        <code>{exampleDraft.trim() || t('Your example commit message appears here.')}</code>
      </div>}
    </Group>
  </>;
}
