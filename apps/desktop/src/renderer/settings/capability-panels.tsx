import {
  Trash2,
  X,
} from 'lucide-react';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type {
  DesktopApi,
  DesktopRemoteAccessInfo
} from '../../shared/contract';
import {
  desktopThemeOptions,
  desktopThemePreferenceForTheme,
  getDesktopThemePreference,
  setDesktopThemePreference,
  type DesktopThemePreference,
} from '../desktop-theme';
import {
  getUiLanguagePreference,
  resolveUiLanguage,
  setUiLanguagePreference,
  SUPPORTED_UI_LANGUAGES,
  t,
  type UiLanguagePreference,
} from '../i18n';
import { providerDisplayName } from '../provider-display';
import {
  getSidePanelMode,
  setSidePanelMode,
  subscribeSidePanelMode,
  type SidePanelMode,
} from '../side-panel-preferences';
import {
  connectionInfoReady,
  getCachedConnectionInfo,
  preloadConnectionInfo,
  setCachedConnectionInfo,
} from './connection-info';
import { GitPanel } from './git-panel';
import type { SettingsCategory } from './settings-items';

import { ActionButton, AutoSaveRow, Empty, FormRow, Group, ListEmpty, ResourceRow, SelectRow, settingsStatus, ToggleRow } from "./capability-controls";
import { durationTextInput, formatDuration, label, providerLabel, record, rows, sectionError, sectionLoaded, type CapabilityApi, type PanelContext, type RecordValue } from "./capability-data";

export function CategoryPanel({ category, context }: {
  category: SettingsCategory;
  context: PanelContext;
}) {
  if (category === 'output-style') return <OutputStylePanel {...context} />;
  if (category === 'providers') return <ProvidersPanel {...context} />;
  if (category === 'git') return <GitPanel />;
  if (category === 'channels') return <ChannelsPanel {...context} />;
  if (category === 'mcp') return <McpPanel {...context} />;
  if (category === 'plugins') return <PluginsPanel {...context} />;
  if (category === 'hooks') return <HooksPanel {...context} />;
  if (category === 'skills') return <SkillsPanel {...context} />;
  if (category === 'context') return <ContextPanel {...context} />;
  if (category === 'system') return <SystemPanel {...context} />;
  if (category === 'shortcuts') return <ShortcutsPanel />;
  if (category === 'connection') return <ConnectionPanel api={context.api} />;
  if (category === 'about') return <AboutPanel />;
  return <GeneralPanel {...context} />;
}

// Keybind reference (read-only). Bindings live in App.tsx's
// global keydown handler and the composer key map; keep this list in sync.
const SHORTCUT_GROUPS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  ['Workspace', [
    ['Ctrl+N', 'New task'],
    ['Ctrl+P', 'Quick Open'],
    ['Ctrl+Shift+P', 'Command Palette'],
    ['Ctrl+W', 'Close tab'],
    ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
    ['Ctrl+← / →', 'Switch tab'],
    ['Alt+← / →', 'Switch pane'],
    ['Ctrl+B', 'Toggle left side bar'],
    ['Ctrl+Alt+B', 'Toggle right utility panel'],
    ['Ctrl+` / Ctrl+T', 'Toggle terminal panel'],
    ['Ctrl+,', 'Open settings'],
    ['Esc', 'Close menus and popovers'],
  ]],
  ['Editor', [
    ['F2', 'Rename symbol'],
    ['Ctrl+.', 'Quick Fix'],
    ['Shift+Alt+F', 'Format document'],
    ['F12 / Shift+F12', 'Go to definition / references'],
  ]],
  ['Composer', [
    ['Enter', 'Send message'],
    ['Shift+Enter / Ctrl+Enter', 'Insert new line'],
    ['Ctrl+J', 'Insert new line'],
    ['Ctrl+U', 'Delete to line start'],
    ['↑ / ↓', 'Prompt history (empty draft)'],
    ['/', 'Command palette'],
    ['@', 'File and context mentions'],
  ]],
];

function ShortcutsPanel() {
  return <>
    {SHORTCUT_GROUPS.map(([title, rows]) => <Group key={title} title={title}>
      <div className="settings-shortcut-list">
        {rows.map(([keys, label]) => <div className="settings-shortcut-row" key={keys}>
          <span>{t(label)}</span>
          <kbd>{keys}</kbd>
        </div>)}
      </div>
    </Group>)}
  </>;
}

// Settings → Connection: pairing card for the phone remote (ChatGPT-desktop
// 연결 page grammar). Data + pre-rendered QR SVGs come from the main process;
// the remote shim omits the API, so a phone session shows the fallback note.
// Until the relay QRs exist the card polls (each read also makes the main
// process retry a failed bridge/relay leg) and keeps a QR-sized loading
// shell, so the panel heals in place instead of flashing notes.
const CONNECTION_RETRY_MS = 2_000;
// ~10s of polling before the explanatory notes replace the loading card.
const CONNECTION_STALLED_ATTEMPTS = 5;

function ConnectionPanel({ api }: { api: CapabilityApi }) {
  const [info, setInfo] = useState<DesktopRemoteAccessInfo | null | undefined>(
    () => getCachedConnectionInfo(api),
  );
  const [rotating, setRotating] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [stalledAttempts, setStalledAttempts] = useState(0);
  const ready = connectionInfoReady(info);
  useEffect(() => {
    if (ready || !api.getRemoteAccessInfo) return undefined;
    let live = true;
    let timer = 0;
    const attempt = () => {
      void preloadConnectionInfo(api).then((value) => {
        if (!live) return;
        setInfo(value);
        if (connectionInfoReady(value)) return;
        setStalledAttempts((count) => count + 1);
        timer = window.setTimeout(attempt, CONNECTION_RETRY_MS);
      });
    };
    attempt();
    return () => { live = false; window.clearTimeout(timer); };
  }, [api, ready]);
  if (!api.getRemoteAccessInfo) {
    // Remote surface (phone/browser): the desktop API is absent by design —
    // report where this device is connected instead of desktop-only pairing.
    const remoteServer = (window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer;
    if (remoteServer) {
      return <Group title="Phone remote">
        <p className="settings-connection-note">
          {t('This device is paired and connected through {{server}}. Pairing QR codes for other devices live in the desktop app under Settings → Connection.', { server: remoteServer })}
        </p>
      </Group>;
    }
    return <Group title="Phone remote">
      <p className="settings-connection-note">
        {t('Remote access is unavailable in this session. On the desktop it is on by default; restart without MIXDOG_REMOTE_BRIDGE=0 to enable pairing.')}
      </p>
    </Group>;
  }
  if (!ready) {
    if (stalledAttempts >= CONNECTION_STALLED_ATTEMPTS) {
      if (info === null) {
        return <Group title="Phone remote">
          <p className="settings-connection-note">
            {t('Remote access could not start in this session. On the desktop it is on by default; restart without MIXDOG_REMOTE_BRIDGE=0 to enable pairing.')}
          </p>
        </Group>;
      }
      return <Group title="Phone remote">
        <p className="settings-connection-note">
          {t('Connecting to the Mixdog relay… this card refreshes automatically. If this persists, check this PC’s internet connection.')}
        </p>
      </Group>;
    }
    return <Group title="Phone remote"
      description="Works on any network. Scan with the phone camera.">
      <div className="settings-connection-grid">
        <figure className="settings-connection-card settings-connection-card--loading"
          aria-label={t('Preparing pairing code')} aria-busy="true">
          <div className="settings-connection-qr-placeholder" aria-hidden="true" />
          <figcaption>
            <b>{t('Preparing pairing code…')}</b>
            <small>{t('Starting the secure relay')}</small>
          </figcaption>
        </figure>
      </div>
    </Group>;
  }
  // Relay-only pairing (user decision: Anywhere only, no LAN fallback) — the
  // LAN bridge stays a transport detail and never surfaces here. Browser-only
  // (user decision): the web app covers every phone, so the Android APK tab
  // was dropped from pairing surfaces.
  const browserQrSvg = info.relayBrowserQrSvg || '';
  return <Group title="Phone remote"
    description="Works on any network. Scan with the phone camera.">
    <div className="settings-connection-grid">
      <figure className="settings-connection-card">
        <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: browserQrSvg }} />
        <figcaption><b>{t('Open the web app')}</b><small>{t('Works on iPhone and Android — nothing to install')}</small></figcaption>
      </figure>
    </div>
    <ResourceRow title="Unpair every device"
      description="Mints a new pairing token. Phones and browsers paired so far lose access and must scan again."
      actions={<ActionButton disabled={rotating} onClick={() => {
        if (!confirmRotate) {
          setConfirmRotate(true);
          return;
        }
        if (!api.rotateRemoteAccess) return;
        setConfirmRotate(false);
        setRotating(true);
        void api.rotateRemoteAccess()
          .then((value) => {
            const next = value ?? null;
            setCachedConnectionInfo(api, next);
            setInfo(next);
          })
          .catch(() => { /* card keeps the previous QRs */ })
          .finally(() => setRotating(false));
      }}>{rotating ? 'Unpairing…' : confirmRotate ? 'Confirm unpair' : 'Unpair'}</ActionButton>} />
  </Group>;
}

// Settings → About: repo, issue, and sponsorship links (user decision:
// GitHub star / issues / Ko-fi / MIT). The Star button stars instantly
// through the local gh CLI when it is signed in and falls back to opening
// the repo page otherwise (also on the remote shim, which omits the API).
const MIXDOG_REPO_URL = 'https://github.com/tribgames/mixdog';
const MIXDOG_ISSUES_URL = 'https://github.com/tribgames/mixdog/issues';
const MIXDOG_SPONSOR_URL = 'https://ko-fi.com/tribgamesdev';

function AboutPanel() {
  const host = (window as unknown as { mixdogDesktop?: DesktopApi }).mixdogDesktop;
  const [ghReady, setGhReady] = useState(false);
  const [starred, setStarred] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void host?.githubStarStatus?.()
      ?.then((status) => {
        if (!live || !status) return;
        setGhReady(status.available === true);
        setStarred(status.starred === true);
      })
      .catch(() => { /* the button stays a plain repo link */ });
    return () => { live = false; };
  }, [host]);
  const open = (url: string) => void host?.openExternal?.(url).catch(() => undefined);
  const star = () => {
    if (starred || !ghReady || !host?.starGithub) {
      open(MIXDOG_REPO_URL);
      return;
    }
    setBusy(true);
    void host.starGithub()
      .then((result) => setStarred(result?.starred === true))
      .catch(() => open(MIXDOG_REPO_URL))
      .finally(() => setBusy(false));
  };
  return <>
    <Group title="Community">
      <ResourceRow title="GitHub" className="settings-about-row"
        description="Source, releases, and discussions — a star helps mixdog grow."
        actions={<>
          <ActionButton disabled={busy || starred} onClick={star}>
            {starred ? 'Starred ★' : busy ? 'Starring…' : ghReady ? 'Star ☆' : 'Star on GitHub ↗'}
          </ActionButton>
          <ActionButton disabled={busy} onClick={() => open(MIXDOG_REPO_URL)}>Open ↗</ActionButton>
        </>} />
      <ResourceRow title="Report an issue" className="settings-about-row"
        description="Bug reports and feature requests."
        actions={<ActionButton disabled={busy} onClick={() => open(MIXDOG_ISSUES_URL)}>Issues ↗</ActionButton>} />
      <ResourceRow title="Sponsor" className="settings-about-row"
        description="Support mixdog development."
        actions={<ActionButton disabled={busy} onClick={() => open(MIXDOG_SPONSOR_URL)}>Ko-fi ↗</ActionButton>} />
    </Group>
  </>;
}

function ChoicePanel({ title, values, active, pending, emptyText, onChoose }: {
  title: string; values: RecordValue[]; active: string; pending: string; emptyText?: string; onChoose(id: string): void;
}) {
  return <Group title={title}>{values.length ? values.map((entry) => {
    const id = String(entry.id);
    return <ResourceRow key={id} title={label(entry)} description={String(entry.description || entry.source || '')}
      selected={id === active || entry.active === true}
      actions={id !== active && !entry.active && <ActionButton disabled={Boolean(pending)} onClick={() => onChoose(id)}>Choose</ActionButton>} />;
  }) : <ListEmpty text={emptyText || `No ${title.toLowerCase()} available.`} />}</Group>;
}

function OutputStylePanel({ data, pending, run }: PanelContext) {
  const output = record(data.outputStyles);
  const failure = sectionError(data, 'outputStyles');
  return <ChoicePanel title="" values={rows(output, 'styles')}
    active={String(record(output.current).id || output.configured || 'default')} pending={pending}
    emptyText={sectionLoaded(data, 'outputStyles')
      ? 'No output styles available.'
      : (failure ? `Output styles unavailable: ${failure}` : 'Loading output styles…')}
    onChoose={(id) => void run('setOutputStyle', [id])} />;
}

function UpdatePanel({
  data,
  pending,
  run,
  updaterState,
  checkDesktopUpdate,
  installDesktopUpdate,
}: PanelContext) {
  const update = record(data.update);
  const version = 'version' in updaterState
    ? updaterState.version
    : String(update.latestVersion || '');
  const busy = Boolean(pending)
    || updaterState.status === 'checking'
    || updaterState.status === 'downloading'
    || updaterState.status === 'installing';
  const installLabel = updaterState.status === 'ready'
    ? t('Update to v{{version}}', { version: updaterState.version })
    : updaterState.status === 'installing'
      ? t('Installing v{{version}}…', { version: updaterState.version })
      : updaterState.status === 'downloading'
        ? t('Downloading v{{version}}…', { version: updaterState.version })
        : updaterState.status === 'checking'
          ? 'Checking for update…'
          : updaterState.status === 'up-to-date'
            ? 'Up to date'
            : updaterState.status === 'error'
              ? 'Update unavailable'
              : 'Check for update';
  return <Group title="Update">
    <ResourceRow title="Current version" description="Installed Mixdog Desktop version."
      meta={String(update.currentVersion || t('unknown'))} />
    <ResourceRow title="Latest version" meta={version || t('unknown')}
      actions={<ActionButton disabled={busy} onClick={() => void checkDesktopUpdate()}>Check now</ActionButton>} />
    <ToggleRow title="Auto-update" checked={update.autoUpdate === true}
      disabled={busy} onChange={(enabled) => void run('setAutoUpdate', [enabled])} />
    <ResourceRow title="Install update" actions={<ActionButton
      disabled={busy || updaterState.status !== 'ready'}
      onClick={() => void installDesktopUpdate()}>{installLabel}</ActionButton>} />
  </Group>;
}

function ThemeChoices({ data, pending }: Pick<PanelContext, 'data' | 'pending'>) {
  const loadedTheme = String(data.theme || 'basic');
  const [preference, setPreference] = useState<DesktopThemePreference>(() =>
    getDesktopThemePreference() || desktopThemePreferenceForTheme(loadedTheme));
  useEffect(() => {
    setPreference(getDesktopThemePreference() || desktopThemePreferenceForTheme(loadedTheme));
  }, [loadedTheme]);
  // Desktop-local theme (user decision): the toggle persists to desktop
  // storage only and never writes the engine/TUI theme.
  const choose = (next: string) => {
    const selected = next as DesktopThemePreference;
    setPreference(selected);
    setDesktopThemePreference(selected);
  };
  return <Group title="Theme">
    <SelectRow title="Theme" value={preference} disabled={Boolean(pending)}
      options={desktopThemeOptions()}
      onChange={choose} />
  </Group>;
}

// UI language is desktop-local (localStorage), like the theme rows: it never
// writes engine config. Changing the RESOLVED language reloads the window —
// module-scope strings bake their translation at import time, so a live swap
// would leave mixed-language chrome. The pane layout restores from storage.
function UiLanguageChoices({ pending }: Pick<PanelContext, 'pending'>) {
  const [preference, setPreference] = useState<UiLanguagePreference>(() => getUiLanguagePreference());
  return <Group title="Display language">
    <SelectRow title="Display language" value={preference} disabled={Boolean(pending)}
      options={[
        { value: 'system', label: 'System default' },
        ...SUPPORTED_UI_LANGUAGES,
      ]}
      onChange={(next) => {
        const selected = next as UiLanguagePreference;
        const previous = resolveUiLanguage();
        setPreference(selected);
        setUiLanguagePreference(selected);
        if (resolveUiLanguage(selected) !== previous) window.location.reload();
      }} />
  </Group>;
}

function SidePanelChoices({ pending }: Pick<PanelContext, 'pending'>) {
  const configuredMode = useSyncExternalStore(
    subscribeSidePanelMode,
    getSidePanelMode,
    () => 'close-both',
  );
  const mobile = document.documentElement.dataset.mixdogMobile === '1' ||
    window.matchMedia?.('(max-width: 760px)').matches === true;
  const mode = mobile ? 'close-both' : configuredMode;
  return <Group title="Side panels">
    <SelectRow title="Side panels" value={mode} disabled={Boolean(pending) || mobile}
      options={[
        { value: 'close-left', label: 'Left closed' },
        { value: 'close-right', label: 'Right closed' },
        { value: 'close-both', label: 'Both closed' },
        { value: 'keep-open', label: 'Keep open' },
      ]}
      onChange={(next) => setSidePanelMode(next as SidePanelMode)} />
  </Group>;
}

function GeneralPanel({ data, pending, run }: PanelContext) {
  const profile = record(data.profile);
  const languageOptions = rows(profile.languages).map((entry) => ({ value: String(entry.id || entry.value || 'system'), label: label(entry) }));
  const busy = Boolean(pending);
  return <>
    <Group title="Profile">
      <AutoSaveRow title="Title" name="title" value={String(profile.title || '')}
        placeholder="Your name or role" disabled={busy}
        onSave={(title) => void run('setProfile', [{ title }])} />
      <SelectRow title="Language" value={String(profile.language || 'system')} disabled={busy}
        options={languageOptions} onChange={(language) => void run('setProfile', [{ language }])} />
    </Group>
    <UiLanguageChoices pending={pending} />
        <ThemeChoices data={data} pending={pending} />
    <SidePanelChoices pending={pending} />
  </>;
}

function ProvidersPanel({ data, pending, run, confirm }: PanelContext) {
  const setup = record(data.providerSetup);
  const apiProviders = rows(setup.api);
  const oauthProviders = rows(setup.oauth);
  const localProviders = rows(setup.local);
  const busy = Boolean(pending);
  // Until the read lands, "none" would be a lie; and a snapshot taken before
  // the OS keychain answered reports every provider as not connected, so that
  // status reads as "Checking…" instead.
  const loading = !sectionLoaded(data, 'providerSetup');
  const secretsPending = setup.pendingSecrets === true;
  const providerStatus = (provider: RecordValue) => (provider.authenticated
    ? 'Connected'
    : (secretsPending ? 'Checking…' : String(provider.status || 'Not connected')));
  return <>
    <Group title="OAuth providers">{oauthProviders.length ? oauthProviders.map((provider) => <ResourceRow key={String(provider.id)} title={providerLabel(provider)}
      description={String(provider.detail || '')}
      status={providerStatus(provider)}
      actions={<><OAuthControl provider={provider} disabled={busy} run={run} />
        {provider.authenticated && <ActionButton danger disabled={busy} onClick={() => {
          confirm({ title: 'Forget provider authentication?', description: t('Remove the saved authentication for {{name}}.', { name: providerLabel(provider) }),
            confirmLabel: 'Forget', danger: true, onConfirm: () => void run('forgetProviderAuth', [provider.id]) });
        }}>Forget</ActionButton>}</>} />) : <ListEmpty text={loading ? 'Loading providers…' : 'No OAuth providers available.'} />}</Group>
    <Group title="API-key providers">{apiProviders.length ? apiProviders.map((provider) => <ResourceRow key={String(provider.id)} title={providerLabel(provider)}
      description={String(provider.detail || provider.envName || '')}
      status={providerStatus(provider)}
      actions={<>{String(provider.id) === 'opencode-go' && <ActionButton disabled={busy}
        onClick={() => void run('loginOpenCodeGoUsage')}>Usage sign-in</ActionButton>}
        {!provider.authenticated && <form className="settings-provider-secret" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const secret = new FormData(form).get('secret');
          form.reset();
          void run('saveProviderApiKey', [provider.id, secret], `provider-key-${String(provider.id)}`);
        }}>
          <input name="secret" type="password" autoComplete="off" placeholder="API key"
            aria-label={`${providerLabel(provider)} API key`} required />
          <button disabled={busy}>Save</button>
        </form>}
        {Boolean(provider.stored || (!provider.env && provider.authenticated)) &&
          <ActionButton danger disabled={busy} onClick={() => {
        confirm({ title: 'Forget provider authentication?', description: t('Remove the saved authentication for {{name}}.', { name: providerLabel(provider) }),
          confirmLabel: 'Forget', danger: true, onConfirm: () => void run('forgetProviderAuth', [provider.id]) });
        }}>Forget</ActionButton>}</>} />) : <ListEmpty text={loading ? 'Loading providers…' : 'No API-key providers available.'} />}</Group>
    <Group title="Local providers">{localProviders.length ? localProviders.map((provider) => <React.Fragment key={String(provider.id)}>
      <ResourceRow title={providerLabel(provider)} description={String(provider.baseURL || provider.detail || '')}
        status={String(provider.status || (provider.detected ? 'Detected' : 'Off'))}
        actions={<ActionButton disabled={busy} onClick={() => void run('setLocalProvider', [provider.id, {
          enabled: provider.enabled !== true, baseURL: provider.baseURL,
        }])}>{provider.enabled ? 'Disable' : 'Enable'}</ActionButton>} />
      <FormRow title={`${providerLabel(provider)} endpoint`} description="Update the OpenAI-compatible base URL."
        onSubmit={(form) => void run('setLocalProvider', [provider.id, {
          enabled: provider.enabled === true, baseURL: form.get('baseURL'),
        }], `local-${provider.id}`)}>
        <input name="baseURL" type="url" defaultValue={String(provider.baseURL || provider.defaultURL || '')}
          aria-label={`${providerLabel(provider)} endpoint`}
          placeholder={String(provider.defaultURL || 'http://127.0.0.1:11434/v1')} required />
        <button disabled={busy}>Save</button>
      </FormRow>
    </React.Fragment>) : <ListEmpty text={loading ? 'Loading providers…' : 'No local providers available.'} />}</Group>
  </>;
}

export function OAuthControl({ provider, disabled, run, onComplete }: {
  provider: RecordValue;
  disabled: boolean;
  run: PanelContext['run'];
  onComplete?: () => void;
}) {
  const [flow, setFlow] = useState<RecordValue | null>(null);
  const [error, setError] = useState('');
  const completedFlowRef = useRef('');
  const onCompleteRef = useRef(onComplete);
  const runRef = useRef(run);
  const providerId = String(provider.id || '');
  const flowId = String(flow?.flowId || '');
  const flowState = String(flow?.state || '');
  const manualCodeFlow = providerId === 'anthropic-oauth';
  const status = settingsStatus(flowState || 'pending');
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { runRef.current = run; }, [run]);
  useEffect(() => {
    if (!flowId || flowState !== 'pending') return undefined;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      const next = await runRef.current<RecordValue>(
        'getOAuthProviderLoginStatus',
        [flowId],
        `oauth-status-${providerId}`,
        false,
        true,
      );
      if (cancelled) return;
      if (!next) {
        setError('OAuth status could not be checked.');
        return;
      }
      const nextFlow = record(next);
      setFlow(nextFlow);
      if (String(nextFlow.state || 'pending') === 'pending') {
        timer = window.setTimeout(() => void poll(), 500);
      }
    };
    timer = window.setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [flowId, flowState, providerId]);
  useEffect(() => {
    if (!flowId || flowState !== 'complete' || completedFlowRef.current === flowId) return;
    completedFlowRef.current = flowId;
    void runRef.current<RecordValue>(
      'getProviderSetup',
      [{ force: true }],
      `oauth-refresh-${providerId}`,
      true,
    ).then((next) => {
      if (completedFlowRef.current !== flowId) return;
      if (!next) {
        completedFlowRef.current = '';
        setError('Connected, but provider status could not be refreshed.');
        return;
      }
      setFlow((current) => String(current?.flowId || '') === flowId ? null : current);
      onCompleteRef.current?.();
    });
  }, [flowId, flowState, providerId]);
  const start = async () => {
    setError('');
    completedFlowRef.current = '';
    const next = await run<RecordValue>('beginOAuthProviderLogin', [providerId], `oauth-begin-${providerId}`, false);
    if (next) setFlow(record(next));
  };
  const close = () => {
    const currentFlowId = String(flow?.flowId || '');
    const currentState = String(flow?.state || '');
    setFlow(null);
    setError('');
    if (currentFlowId && currentState !== 'complete' && currentState !== 'cancelled') {
      void run('cancelOAuthProviderLogin', [currentFlowId], `oauth-cancel-${providerId}`, false);
    }
  };
  return <>
    <ActionButton disabled={disabled} onClick={() => void start()}>{provider.authenticated ? 'Reconnect' : 'Connect'}</ActionButton>
    {flow && <div className="settings-oauth-layer" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}><section className="settings-oauth-dialog" role="dialog" aria-modal="true" data-settings-nested-dialog
      aria-labelledby={`settings-oauth-title-${providerId}`} aria-describedby={`settings-oauth-description-${providerId}`}>
      <header><div><h3 id={`settings-oauth-title-${providerId}`}>{providerLabel(provider)} OAuth</h3>
        <p id={`settings-oauth-description-${providerId}`}>{manualCodeFlow
          ? t('Complete the browser login, then paste the authorization code.')
          : t('Finish signing in in your browser. This window updates automatically.')}</p></div>
        <button type="button" aria-label={t('Close OAuth login')} data-settings-nested-close autoFocus onClick={close}>
          <X aria-hidden="true" size={16} />
        </button></header>
      <div className="settings-oauth-body">
        <div className="settings-oauth-status" role="status"><span>{t('Status')}</span>
          <b className={`tone-${status.tone}`}>{t(status.label)}</b></div>
        {String(flow.error || '') && <p className="settings-oauth-error" role="alert">{String(flow.error)}</p>}
        {manualCodeFlow && Boolean(flow.manualUrl || flow.url) && <label className="settings-oauth-url">{t('Manual login URL')}
          <textarea readOnly value={String(flow.manualUrl || flow.url)} /></label>}
        {manualCodeFlow && Boolean(flow.manualCodeSupported) && flow.state !== 'complete' && <form className="settings-oauth-code" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const code = new FormData(form).get('code');
        form.reset();
        void run<RecordValue>('completeOAuthProviderLogin', [flow.flowId, code], `oauth-complete-${providerId}`, false)
          .then((next) => {
            if (next) setFlow(record(next));
            else setError('The authorization code could not be completed.');
          });
      }}><input name="code" placeholder={t('Authorization code or code#state')} aria-label={t('Anthropic authorization code')} required />
          <button type="submit" className="primary" disabled={disabled}>{t('Complete')}</button></form>}
        {error && <p className="settings-oauth-error" role="alert">{error}</p>}
      </div>
      <footer><button type="button" disabled={disabled} onClick={close}>
        {flow.state === 'pending' ? t('Cancel') : t('Close')}
      </button></footer>
    </section></div>}
  </>;
}

function McpPanel({ data, pending, run }: PanelContext) {
  const status = record(data.mcp);
  const servers = rows(status, 'servers');
  const busy = Boolean(pending);
  return <>
    <Group title="Servers"
      description={t('{{connected}} connected · {{failed}} failed', { connected: status.connectedCount || 0, failed: status.failedCount || 0 })}>
      {servers.length ? servers.map((server) => <ResourceRow key={String(server.name)} title={String(server.name)}
        description={`${server.transport || 'transport unknown'}${server.error ? ` · ${server.error}` : ''}`}
        meta={t('{{count}} tools', { count: server.toolCount || 0 })}
        status={String(server.status || 'unknown')}
        actions={<ActionButton disabled={busy} onClick={() => void run('setMcpServerEnabled', [server.name, server.enabled === false])}>
          {server.enabled === false ? 'Enable' : 'Disable'}
    </ActionButton>} />) : <ListEmpty text={sectionLoaded(data, 'mcp') ? 'No MCP servers configured.' : 'Loading MCP servers…'} />}
    </Group>
  </>;
}

function SkillsPanel({ data, pending, run }: PanelContext) {
  const status = record(data.skills);
  const skills = rows(status, 'skills');
  const disabled = new Set((Array.isArray(record(data.disabledSkills).disabled) ? record(data.disabledSkills).disabled as unknown[] : []).map(String));
  const busy = Boolean(pending);
  const toggle = (name: string) => {
    const next = new Set(disabled);
    if (next.has(name)) next.delete(name); else next.add(name);
    void run('setDisabledSkills', [[...next]]);
  };
  return <>
    <Group>{skills.length ? skills.map((skill) => <ResourceRow key={String(skill.name)} title={String(skill.name)}
      description={String(skill.description || skill.filePath || '')} meta={String(skill.source || 'skill')}
      status={disabled.has(String(skill.name)) ? 'Disabled' : 'Enabled'}
      actions={<ActionButton disabled={busy} onClick={() => toggle(String(skill.name))}>{disabled.has(String(skill.name)) ? 'Enable' : 'Disable'}</ActionButton>} />)
      : <ListEmpty text={sectionLoaded(data, 'skills') ? 'No skills found.' : 'Loading skills…'} />}
    </Group>
  </>;
}

function PluginsPanel({ data, pending, run, confirm }: PanelContext) {
  const status = record(data.plugins);
  const plugins = rows(status, 'plugins');
  const busy = Boolean(pending);
  return <>
    <Group title="Installed">{plugins.length ? plugins.map((plugin) => <ResourceRow key={String(plugin.id || plugin.name)} title={label(plugin)}
      description={String(plugin.description || plugin.root || '')} meta={`${plugin.version || 'unversioned'} · ${plugin.skillCount || 0} skills`}
      actions={<><ActionButton disabled={busy} onClick={() => void run('updatePlugin', [plugin])}>
        {plugin.sourceType === 'local' ? 'Update metadata' : 'Update plugin'}</ActionButton>
        {plugin.mcpScript && <ActionButton disabled={busy}
          onClick={() => void run('enablePluginMcp', [plugin])}>{plugin.mcpEnabled ? 'Reconfigure MCP' : 'Enable MCP'}</ActionButton>}
        {Boolean(plugin.root) && <ActionButton disabled={busy} onClick={() => {
          void navigator.clipboard?.writeText(String(plugin.root));
        }}>Copy root</ActionButton>}
        {Boolean(plugin.mcpServerName) && <ActionButton disabled={busy} onClick={() => {
          void navigator.clipboard?.writeText(String(plugin.mcpServerName));
        }}>Copy MCP name</ActionButton>}
        <ActionButton danger disabled={busy} onClick={() => {
          confirm({ title: 'Remove plugin?', description: t('{{name}} will be removed from Mixdog.', { name: label(plugin) }),
            confirmLabel: 'Remove', danger: true, onConfirm: () => void run('removePlugin', [plugin]) });
        }}><Trash2 size={14} /></ActionButton></>} />) : <ListEmpty text={sectionLoaded(data, 'plugins') ? 'No plugins installed.' : 'Loading plugins…'} />}
    </Group>
    <Group title="Install plugin" description="Local path, Git URL, or supported registry source.">
      <FormRow title="Plugin source"
      onSubmit={(form) => void run('addPlugin', [form.get('source')])}>
      <input name="source" placeholder="https://github.com/org/plugin or C:\path" required /><button disabled={busy}>Install</button>
      </FormRow>
    </Group>
  </>;
}

function HooksPanel({ data, pending, run }: PanelContext) {
  const status = record(data.hooks);
  const rules = rows(status, 'rules');
  const busy = Boolean(pending);
  return <>
    <Group title="Rules"
      description={t('{{count}} rules · {{mode}}', { count: status.ruleCount || rules.length, mode: status.configMode || 'standalone' })}>
      {rules.length ? rules.map((rule, index) => <ResourceRow key={String(rule.index ?? index)} title={`${rule.tool || '*'} → ${rule.action || 'ask'}`}
        description={String(rule.match || rule.reason || '')} status={rule.enabled === false ? 'Disabled' : 'Enabled'}
        actions={<ActionButton disabled={busy} onClick={() => void run('setHookRuleEnabled', [Number(rule.index ?? index), rule.enabled === false])}>
          {rule.enabled === false ? 'Enable' : 'Disable'}
    </ActionButton>} />) : <ListEmpty text={sectionLoaded(data, 'hooks') ? 'No hook rules configured.' : 'Loading hooks…'} />}
    </Group>
  </>;
}

// Context management (user decision): ONE page owns how a session's context
// evolves — auto-compact, idle auto-clear, and the memory that carries over.
function ContextPanel({ data, pending, run, confirm }: PanelContext) {
  const recap = record(data.recap);
  const autoClear = record(data.autoClear);
  const compaction = record(data.compaction);
  const providerDefaults = rows(autoClear.providerDefaults);
  const busy = Boolean(pending);
  return <>
    <Group title="Session lifecycle">
      <ToggleRow title="Auto-compact" description="Compact automatically as the active context reaches its limit."
        checked={compaction.auto !== false} disabled={busy} onChange={(enabled) => void run('setCompactionSettings', [{ auto: enabled }])} />
      <ToggleRow title="Auto-clear" description={`Clear idle sessions after ${formatDuration(autoClear.idleMs) || 'the provider default'}.`}
        checked={autoClear.enabled !== false} disabled={busy} onChange={(enabled) => void run('setAutoClear', [{ enabled }])} />
      {providerDefaults.map((entry) => <AutoSaveRow key={String(entry.provider)}
        title={`${providerDisplayName(String(entry.provider || 'default'))} idle window`}
        name="duration" value={durationTextInput(entry.idleMs)} placeholder={durationTextInput(entry.builtInMs)}
        required disabled={busy}
        onSave={(duration) => void run('setAutoClear', [{ provider: entry.provider, duration }], `autoclear-${entry.provider}`)}
        actions={Boolean(entry.custom) && <ActionButton disabled={busy} onClick={() => void run('setAutoClear', [
          { provider: entry.provider, resetProvider: true },
        ], `autoclear-reset-${entry.provider}`)}>Reset</ActionButton>} />)}
    </Group>
    <Group title="Memory"><ToggleRow title="Background recap"
      description="Recap sessions in the background. Core memories and on-demand recall remain available."
      checked={recap.enabled !== false} disabled={busy} onChange={(enabled) => void run('setRecapEnabled', [enabled])} /></Group>
    <section className="settings-group core-memory-section">
      <header><h3>{t('Core memories')}</h3><p>{t('User-curated memories shared across Mixdog sessions.')}</p></header>
      <CoreMemoryManager initialValue={data.coreMemory} pending={pending} run={run} confirm={confirm} />
    </section>
  </>;
}

type CoreMemoryEntry = {
  id: number;
  projectId: string | null;
  element: string;
  summary: string;
  singleSentence: boolean;
};

function parseCoreMemoryEntries(value: unknown): CoreMemoryEntry[] {
  let projectId: string | null = null;
  const entries: CoreMemoryEntry[] = [];
  for (const line of String(value || '').split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    if (line.endsWith(':') && !line.includes('id=')) {
      const scope = line.slice(0, -1);
      projectId = scope === 'COMMON' ? null : scope;
      continue;
    }
    const match = line.match(/^id=(\d+)\s+(.+?)(?:\s+—\s+(.+))?$/);
    if (!match) continue;
    const element = match[2];
    const rawSummary = match[3] || '';
    entries.push({
      id: Number(match[1]),
      projectId,
      element,
      summary: rawSummary || element,
      singleSentence: element === rawSummary,
    });
  }
  return entries.sort((left, right) => right.id - left.id);
}

function memoryResultError(value: unknown): string {
  const text = String(value || '').trim();
  return /^(?:core (?:add|edit|delete|promote|dismiss)(?::| failed)|core:.*(?:not initialized|failed|error)|(?:error|failed)\b)/i.test(text)
    ? text
    : '';
}

function CoreMemoryManager({ initialValue, pending, run, confirm }: {
  initialValue: unknown;
  pending: string;
  run: PanelContext['run'];
  confirm: PanelContext['confirm'];
}) {
  const [entries, setEntries] = useState<CoreMemoryEntry[]>(() => parseCoreMemoryEntries(initialValue));
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const loaded = useRef(false);
  const refresh = async () => {
    const result = await run<unknown>('memoryControl', [
      { action: 'core', op: 'list', project_id: '*' }, { silent: true },
    ], 'core-memory-list', false);
    if (result !== undefined) setEntries(parseCoreMemoryEntries(result));
  };
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    if (initialValue === undefined) void refresh();
  }, []);
  useEffect(() => {
    if (initialValue !== undefined) setEntries(parseCoreMemoryEntries(initialValue));
  }, [initialValue]);
  const mutate = async (input: RecordValue) => {
    setError('');
    const result = await run<unknown>('memoryControl', [input, { silent: true }], `core-${input.op}`, false);
    const failure = memoryResultError(result);
    if (failure) {
      setError(failure);
      return false;
    }
    if (result !== undefined) await refresh();
    return result !== undefined;
  };
  return <div className="core-memory-manager">
    <section className="core-memory-add-card">
      <header><b>{t('Add memory')}</b><small>{t('Save a durable fact or preference for future sessions.')}</small></header>
      <form className="core-memory-add" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const sentence = String(new FormData(form).get('sentence') || '').trim();
        if (!sentence) return;
        void mutate({ action: 'core', op: 'add', project_id: 'common', element: sentence, summary: sentence })
          .then((ok) => { if (ok) form.reset(); });
      }}><input name="sentence" aria-label={t('Memory to add')} placeholder={t('What should Mixdog remember?')} maxLength={2000} required />
        <button disabled={Boolean(pending)}>{t('Add memory')}</button></form>
    </section>
    {entries.length ? <div className="core-memory-list">
      {entries.map((entry) => editing === entry.id ? <form className="core-memory-edit" key={entry.id} onSubmit={(event) => {
        event.preventDefault();
        const summary = String(new FormData(event.currentTarget).get('summary') || '').trim();
        if (!summary) return;
        const payload: RecordValue = { action: 'core', op: 'edit', id: entry.id, project_id: entry.projectId, summary };
        if (entry.singleSentence) payload.element = summary;
        void mutate(payload).then((ok) => { if (ok) setEditing(null); });
      }}><input name="summary" aria-label={t('Memory text')} defaultValue={entry.summary} maxLength={2000} required autoFocus />
        <span className="core-memory-scope">{entry.projectId || t('Common')}</span>
        <div className="core-memory-actions"><button disabled={Boolean(pending)}>{t('Save')}</button>
          <button type="button" onClick={() => setEditing(null)}>{t('Cancel')}</button></div></form>
        : <div className="core-memory-row" key={entry.id}><div className="core-memory-copy"><b>{entry.summary}</b></div>
          <span className="core-memory-scope">{entry.projectId || t('Common')}</span>
          <div className="core-memory-actions"><button disabled={Boolean(pending)} onClick={() => setEditing(entry.id)}>{t('Edit')}</button>
          <button className="danger" disabled={Boolean(pending)} onClick={() => {
            confirm({ title: 'Delete memory?', description: t('Memory #{{id}} will be removed permanently.', { id: entry.id }),
              confirmLabel: 'Delete', danger: true,
              onConfirm: () => void mutate({ action: 'core', op: 'delete', id: entry.id, project_id: entry.projectId }) });
          }}>{t('Delete')}</button></div></div>)}
    </div> : <div className="core-memory-list core-memory-list--empty"><Empty text="No core memories yet." /></div>}
    {error && <p className="settings-field-error">{error}</p>}
  </div>;
}

function ChannelsPanel({ data, snapshot, pending, run, notice }: PanelContext) {
  const channels = record(data.channels);
  const setup = record(data.channelSetup);
  const worker = record(data.channelWorker);
  const channel = record(setup.channel);
  const voice = record(data.voice);
  const progress = record(record(snapshot).progressHint);
  const voiceComponents = record(voice.components);
  const busy = Boolean(pending);
  const persistedProvider = String(setup.provider || 'discord');
  const [provider, setChannelProviderChoice] = useState(persistedProvider);
  const optimisticProvider = useRef<string | null>(null);
  useEffect(() => {
    if (optimisticProvider.current && optimisticProvider.current !== persistedProvider) return;
    optimisticProvider.current = null;
    setChannelProviderChoice(persistedProvider);
  }, [persistedProvider]);
  return <>
    <Group title="Channel service">
      {/* Messaging-only toggle: schedules/webhooks run sessions through the
          automation runtime and no longer depend on this switch. */}
      <ToggleRow title="Channels enabled" description={channels.enabled === false
        ? 'Discord and Telegram messaging is disabled. Schedules and webhooks keep running.'
        : 'Discord and Telegram messaging is enabled.'}
        checked={channels.enabled !== false} disabled={busy}
        onChange={(enabled) => void run('setChannelsEnabled', [enabled])} />
      {/* No "New task remote" row: the reservation became a one-shot draft
          toggle that resets on every NEW TASK entry (user decision), so a
          persistent settings default would be dead weight — the header toggle
          on the draft is the only control. */}
      <SelectRow title="Channel" description="Primary outbound channel provider." value={provider} disabled={busy}
        options={[{ value: 'discord', label: 'Discord' }, { value: 'telegram', label: 'Telegram' }]}
        onChange={(value) => {
          optimisticProvider.current = value;
          setChannelProviderChoice(value);
          void run('setChannelProvider', [value], 'channel-provider', false).then((result) => {
            if (result === undefined) {
              optimisticProvider.current = null;
              setChannelProviderChoice(persistedProvider);
              return;
            }
            const channelLabel = value === 'telegram' ? 'Telegram' : 'Discord';
            notice(data.remote === true || worker.running
              ? t('Channel set to {{channel}}. Restart remote to apply.', { channel: channelLabel })
              : t('Channel set to {{channel}}.', { channel: channelLabel }));
          });
        }} />
      <ResourceRow title="Voice transcription"
        description={progress.text ? String(progress.text) : voice.installed
          ? 'Managed Whisper and ffmpeg runtime is ready for incoming channel voice messages.'
          : `Runtime components · Whisper ${voiceComponents.whisper ? 'ready' : 'missing'} · model ${voiceComponents.model ? 'ready' : 'missing'} · ffmpeg ${voiceComponents.ffmpeg ? 'ready' : 'missing'}`}
        status={voice.enabled ? 'On' : progress.text || voice.busy ? 'Installing…' : 'Off'}
        actions={<ActionButton disabled={busy || voice.busy === true}
          onClick={() => void run('toggleVoice', [], 'voice-toggle')}>
          {voice.enabled ? 'Disable voice' : voice.installed ? 'Enable voice' : 'Install & enable'}
        </ActionButton>} />
    </Group>
    <Group title="Discord">
      <SecretForm title="Discord bot token" status={record(setup.discord)} disabled={busy}
        onSave={(secret) => void run('saveDiscordToken', [secret])} />
      <AutoSaveRow title="Main channel" name="discordChannelId"
        value={String(channel.discordChannelId || (setup.provider !== 'telegram' ? channel.channelId || '' : ''))}
        placeholder="Discord channel ID" required disabled={busy}
        onSave={(channelId) => void run('setChannel', [{ provider: 'discord', channelId }])} />
    </Group>
    <Group title="Telegram">
      <SecretForm title="Telegram bot token" status={record(setup.telegram)} disabled={busy}
        onSave={(secret) => void run('saveTelegramToken', [secret])} />
      <AutoSaveRow title="Main chat" name="telegramChatId"
        value={String(channel.telegramChatId || (setup.provider === 'telegram' ? channel.channelId || '' : ''))}
        placeholder="Telegram chat ID" required disabled={busy}
        onSave={(channelId) => void run('setChannel', [{ provider: 'telegram', channelId }])} />
    </Group>
    {/* No Webhook ingress group: the relay URL is issued automatically and
        surfaces per endpoint (Copy URL) on the main-pane Webhooks page. */}
  </>;
}

function SystemPanel(context: PanelContext) {
  return SystemPanelBody(context);
}

// Desktop-local power setting (main-process powerSaveBlocker): rides the
// readSettings/updateSetting lane, not an engine capability, so it loads its
// own state. Hidden when the hosting shell exposes no settings surface.
function DesktopPowerGroup() {
  const api = (window as unknown as { mixdogDesktop?: Partial<DesktopApi> }).mixdogDesktop;
  const [keepAwake, setKeepAwake] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void api?.readSettings?.().then((settings) => {
      if (live) setKeepAwake(settings.keepAwake !== false);
    }).catch(() => {});
    return () => { live = false; };
  }, [api]);
  if (keepAwake === null || !api?.updateSetting) return null;
  return <Group title="Power"
    description="Keep the computer awake while agents are working, so long runs never stall mid-turn.">
    <ToggleRow title="Keep system awake while working" checked={keepAwake}
      onChange={(enabled) => {
        setKeepAwake(enabled);
        void api.updateSetting?.('keepAwake', enabled).catch(() => {});
      }} />
  </Group>;
}

function SystemPanelBody(context: PanelContext) {
  const { pending, run } = context;
  const busy = Boolean(pending);
  return <>
    {/* The remote runtime toggle moved to the session header (user decision):
        a persistent on/off button next to the context indicator. */}
    <UpdatePanel {...context} />
    <DesktopPowerGroup />
    <Group title="Doctor">
      <ResourceRow title="Diagnostics" description="Check the runtime, providers, integrations, and local installation."
        actions={<ActionButton disabled={busy} onClick={() => void run('runDoctor')}>Run doctor</ActionButton>} />
    </Group>
  </>;
}

function SecretForm({ title, status, disabled, onSave }: {
  title: string; status: RecordValue; disabled: boolean; onSave(secret: string): void;
}) {
  const saved = status.stored === true || status.authenticated === true || String(status.status || '').toLowerCase() === 'set';
  const visibleStatus = status.problem ? String(status.status || 'Invalid') : saved ? 'Saved' : undefined;
  return <FormRow title={title} status={visibleStatus}
    description={t(String(status.problem || status.status || 'Not configured'))} resetOnSubmit
    onSubmit={(form) => onSave(String(form.get('secret') || ''))}>
    <input name="secret" type="password" autoComplete="off" aria-label={title}
      placeholder={saved ? `••••••••  ${t('Saved')}` : t('Secret')} required disabled={disabled} />
    <button disabled={disabled}>{saved ? t('Replace') : t('Save')}</button>
  </FormRow>;
}

// Schedules and webhook endpoints both moved to dedicated main-pane pages
// (sidebar → Schedules / Webhooks); settings keeps channel wiring only.
