import {
  Check,
  ChevronRight,
  X,
} from 'lucide-react';
import React, { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import type {
  DesktopApi,
  DesktopRemoteAccessInfo,
  DesktopSettingKey,
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
import { registerMobileBack, useMobileBack } from '../mobile-back';
import { showDesktopToast } from '../notifications';
import { providerDisplayName } from '../provider-display';
import { acquireTitleBarDim } from '../titlebar-dim';
import { record } from '../record-utils';
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

import { ActionButton, AutoSaveRow, CompactSwitch, FormRow, Group, ListEmpty, ResourceRow, SelectRow, settingsStatus, ToggleRow } from "./capability-controls";
import { durationTextInput, formatDuration, label, providerLabel, rows, sectionError, sectionLoaded, type CapabilityApi, type PanelContext, type RecordValue } from "./capability-data";

export function CategoryPanel({ category, context }: {
  category: SettingsCategory;
  context: PanelContext;
}) {
  if (category === 'output-style') return <OutputStylePanel {...context} />;
  if (category === 'providers') return <ProvidersPanel {...context} />;
  if (category === 'git') return <GitPanel />;
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
  ['Project', [
    ['Ctrl+N', 'New task'],
    ['Ctrl+P', 'Quick Open'],
    ['Ctrl+Shift+P', 'Command Palette'],
    ['Ctrl+W', 'Close tab'],
    ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
    ['Ctrl+← / →', 'Switch tab / pane'],
    ['Ctrl+↑ / ↓', 'Focus pane above / below'],
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
  ['Conversation', [
    ['PageUp / PageDown', 'Scroll conversation'],
    ['Home / End', 'First / latest message'],
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

// Settings → Connection: pairing card for the installable web app. Data and
// the pre-rendered QR SVG come from the main process; the remote shim omits
// the API, so a browser session reports its current connection instead.
// Until the relay QR exists the card polls (each read also makes the main
// process retry a failed relay leg) and keeps a QR-sized loading
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
  const [revokingClient, setRevokingClient] = useState('');
  const [confirmClient, setConfirmClient] = useState('');
  const [stalledAttempts, setStalledAttempts] = useState(0);
  const ready = connectionInfoReady(info);
  // Linked devices freshness: the cached card paints instantly, but browsers
  // pair and drop while Settings is closed — refresh in the background for as
  // long as the panel stays open.
  useEffect(() => {
    if (!ready || !api.getRemoteAccessInfo) return undefined;
    let live = true;
    const refresh = () => {
      void api.getRemoteAccessInfo?.()
        .then((value) => {
          if (!live || !value) return;
          setCachedConnectionInfo(api, value);
          setInfo(value);
        })
        .catch(() => { /* keep the current card */ });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [ready, api]);
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
    // Remote browser: the desktop API is absent by design —
    // report where this device is connected instead of desktop-only pairing.
    const remoteServer = (window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer;
    if (remoteServer) {
      return <Group title="Web app">
        <p className="settings-connection-note">
          {t('This web app is paired and connected through {{server}}. Pairing QR codes for other browsers live in the desktop app under Settings → Connection.', { server: remoteServer })}
        </p>
      </Group>;
    }
    return <Group title="Web app">
      <p className="settings-connection-note">
        {t('Connecting to the Mixdog relay… this card refreshes automatically. If this persists, check this PC’s internet connection.')}
      </p>
    </Group>;
  }
  if (!ready) {
    if (stalledAttempts >= CONNECTION_STALLED_ATTEMPTS) {
      if (info === null) {
        return <Group title="Web app">
          <p className="settings-connection-note">
            {t('Connecting to the Mixdog relay… this card refreshes automatically. If this persists, check this PC’s internet connection.')}
          </p>
        </Group>;
      }
      return <Group title="Web app">
        <p className="settings-connection-note">
          {t('Connecting to the Mixdog relay… this card refreshes automatically. If this persists, check this PC’s internet connection.')}
        </p>
      </Group>;
    }
    return <Group title="Web app"
      description="Works on any network. Open the secure link in a browser.">
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
  // Relay-only pairing: the installed web app is the only remote client. The
  // scanned link routes to this desktop and carries no credential — approving
  // the request the installed app makes is what grants access.
  const browserQrSvg = info.relayBrowserQrSvg || '';
  return <>
    <Group title="Web app"
      description="Works on any network. Scan to install the app, then approve it here.">
      <div className="settings-connection-grid">
        <figure className="settings-connection-card">
          <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: browserQrSvg }} />
          <figcaption><b>{t('Scan to install the web app')}</b><small>{t('Chrome/Edge: Install app · Safari: Add to Home Screen')}</small></figcaption>
        </figure>
      </div>
    </Group>
    {info.clients.length > 0 && <Group title={t('Linked devices')}
      description={t('Review and revoke browsers paired with this desktop.')}>
    <div className="settings-resource-list">
      {info.clients.map((client) => {
        const lastSeen = client.lastSeenAt
          ? new Date(client.lastSeenAt).toLocaleString()
          : t('Never');
        return <ResourceRow key={client.id}
          title={client.name || `${client.platform || 'Device'} · ${client.browser || 'Browser'}`}
          meta={t('Added {{created}} · Last used {{lastSeen}}', {
            created: new Date(client.createdAt).toLocaleDateString(),
            lastSeen,
          })}
          status={client.online ? 'Connected' : 'Not connected'}
          actions={<ActionButton danger disabled={Boolean(revokingClient)}
            onClick={() => {
              if (confirmClient !== client.id) {
                setConfirmClient(client.id);
                return;
              }
              if (!api.revokeRemoteAccessClient) return;
              setConfirmClient('');
              setRevokingClient(client.id);
              void api.revokeRemoteAccessClient(client.id)
                .then((value) => {
                  const next = value ?? null;
                  setCachedConnectionInfo(api, next);
                  setInfo(next);
                })
                .catch(() => { /* keep the current list for retry */ })
                .finally(() => setRevokingClient(''));
            }}>
            {revokingClient === client.id
              ? 'Unpairing…'
              : confirmClient === client.id ? 'Confirm unpair' : 'Unpair'}
          </ActionButton>} />;
      })}
    </div>
    <ResourceRow title="Unpair every device"
      description="Every device approved so far loses access and must be approved again."
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
    </Group>}
  </>;
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
  const narrow = window.matchMedia?.('(max-width: 760px)').matches === true;
  const mode = narrow ? 'close-both' : configuredMode;
  return <Group title="Side panels">
    <SelectRow title="Side panels" value={mode} disabled={Boolean(pending) || narrow}
      options={[
        { value: 'close-left', label: 'Left closed' },
        { value: 'close-right', label: 'Right closed' },
        { value: 'close-both', label: 'Both closed' },
        { value: 'keep-open', label: 'Keep open' },
      ]}
      onChange={(next) => setSidePanelMode(next as SidePanelMode)} />
  </Group>;
}

type VoiceInstallDialogMode = 'confirm' | 'installing' | 'failed';

function VoiceInstallDialog({ mode, progressText, progressPercent, onClose, onInstall }: {
  mode: VoiceInstallDialogMode;
  progressText: string;
  progressPercent: number | null;
  onClose(): void;
  onInstall(): void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const modeRef = useRef(mode);
  const onCloseRef = useRef(onClose);
  modeRef.current = mode;
  onCloseRef.current = onClose;
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const releaseTitleBarDim = acquireTitleBarDim();
    return () => {
      releaseTitleBarDim();
      prior?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (mode !== 'installing') closeRef.current?.focus();
  }, [mode]);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || modeRef.current === 'installing') return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);
  useEffect(() => registerMobileBack(() => {
    if (modeRef.current !== 'installing') onCloseRef.current();
  }), []);

  const title = mode === 'confirm'
    ? t('Install voice transcription?')
    : mode === 'installing'
      ? t('Installing…')
      : `${t('Voice transcription')} · ${t('Failed')}`;
  const progressStyle = progressPercent === null
    ? undefined
    : { width: `${progressPercent}%` };
  return createPortal(
    <div className="settings-confirm-layer" onMouseDown={(event) => {
      if (event.target === event.currentTarget && mode !== 'installing') onClose();
    }}>
      <section className="settings-confirm-dialog voice-install-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby="voice-settings-install-title" aria-describedby="voice-settings-install-description"
        data-settings-nested-dialog>
        <header>
          <h3 id="voice-settings-install-title">{title}</h3>
          {mode !== 'installing' && <button type="button" aria-label={t('Close confirmation')}
            data-settings-nested-close onClick={onClose}>
            <X aria-hidden="true" size={16} />
          </button>}
        </header>
        {mode === 'confirm'
          ? <p id="voice-settings-install-description">{t('Install & enable')}</p>
          : mode === 'installing'
            ? <div id="voice-settings-install-description" className="voice-install-progress">
              <p role="status">{progressText || t('Installing…')}</p>
              <span className={`voice-install-progress-bar${progressPercent === null ? ' is-indeterminate' : ''}`}
                role="progressbar" aria-valuenow={progressPercent ?? undefined}
                aria-valuemin={0} aria-valuemax={100}
                aria-valuetext={progressText || t('Installing…')}>
                <span style={progressStyle} />
              </span>
            </div>
            : <p id="voice-settings-install-description">{t('Failed')}</p>}
        {mode !== 'installing' && <footer>
          <button ref={closeRef} type="button" onClick={onClose}>
            {mode === 'confirm' ? t('Cancel') : t('Close')}
          </button>
          <button type="button" className="primary" onClick={onInstall}>
            {mode === 'confirm' ? t('Install') : t('Retry')}
          </button>
        </footer>}
      </section>
    </div>,
    document.body,
  );
}

function GeneralPanel({ data, snapshot, pending, run }: PanelContext) {
  const profile = record(data.profile);
  const toolModules = record(data.toolModules);
  const recap = record(data.recap);
  const webSearchModule = record(toolModules.webSearch);
  const memoryModule = record(toolModules.memory);
  // Voice transcription moved here from the retired Channels page (user:
  // 음성전사만 일반으로): the managed Whisper runtime powers voice input.
  const voice = record(data.voice);
  const voiceProgress = record(record(snapshot).progressHint);
  const voiceReady = voice.enabled === true && voice.installed === true;
  const [voiceInstallDialog, setVoiceInstallDialog] = useState<VoiceInstallDialogMode | null>(null);
  const voiceProgressText = String(voiceProgress.text || '');
  const fallbackPercent = Number(voiceProgressText.match(/(\d+)%/)?.[1]);
  const hintedPercent = Number(voiceProgress.percent);
  const rawPercent = Number.isFinite(hintedPercent) ? hintedPercent : fallbackPercent;
  const voiceProgressPercent = Number.isFinite(rawPercent)
    ? Math.max(0, Math.min(100, Math.round(rawPercent)))
    : null;
  const languageOptions = rows(profile.languages).map((entry) => ({ value: String(entry.id || entry.value || 'system'), label: label(entry) }));
  const experienceLevelOptions = rows(profile.experienceLevels).map((entry) => ({ value: String(entry.id || entry.value || ''), label: label(entry) }));
  const busy = Boolean(pending);
  const installVoice = async () => {
    setVoiceInstallDialog('installing');
    const result = record(await run('toggleVoice', [], 'voice-toggle'));
    if (result.enabled === true && result.installed === true) {
      setVoiceInstallDialog(null);
      return;
    }
    setVoiceInstallDialog('failed');
  };
  return <>
    <Group title="Profile">
      <AutoSaveRow title="Title" name="title" value={String(profile.title || '')}
        placeholder="Your name or role" disabled={busy}
        onSave={(title) => void run('setProfile', [{ title }])} />
      <SelectRow title="Language" value={String(profile.language || 'system')} disabled={busy}
        options={languageOptions} onChange={(language) => void run('setProfile', [{ language }])} />
      <SelectRow title="Experience level" value={String(profile.experienceLevel || '')} disabled={busy}
        options={experienceLevelOptions} onChange={(experienceLevel) => void run('setProfile', [{ experienceLevel }])} />
    </Group>
    <Group title="Features">
      <ToggleRow title="Web search" description={t("Expose web search and web fetch tools to new sessions.")}
        checked={webSearchModule.enabled !== false} disabled={busy}
        onChange={(enabled) => void run('setWebSearchEnabled', [enabled])} />
      <ToggleRow title="Memory" description={t("Memory and recall tools, core-memory injection, and background memory upkeep.")}
        checked={memoryModule.enabled !== false && recap.enabled !== false} disabled={busy}
        onChange={(enabled) => void run('setMemoryToolsEnabled', [enabled])} />
      <ToggleRow title="Voice transcription" checked={voiceReady} optimistic={false}
        disabled={busy || voice.busy === true || voiceInstallDialog !== null}
        onChange={(enabled) => {
          if (!enabled || voice.installed === true) {
            void run('toggleVoice', [], 'voice-toggle');
            return;
          }
          setVoiceInstallDialog('confirm');
        }} />
    </Group>
    {voiceInstallDialog && <VoiceInstallDialog mode={voiceInstallDialog}
      progressText={voiceProgressText} progressPercent={voiceProgressPercent}
      onClose={() => setVoiceInstallDialog(null)} onInstall={() => void installVoice()} />}
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
  const providerStatus = (provider: RecordValue) => {
    if (secretsPending && !provider.authenticated) return 'Checking…';
    const status = String(provider.status || '');
    if (provider.reauthRequired === true) return status || 'Reauth required';
    if (provider.authenticated && /^(valid|set|access only)$/i.test(status)) return 'Connected';
    return status || (provider.authenticated ? 'Connected' : 'Not connected');
  };
  return <>
    <Group title="OAuth providers">{oauthProviders.length ? oauthProviders.map((provider) => <ResourceRow key={String(provider.id)} title={providerLabel(provider)}
      description={String(provider.detail || '')}
      status={providerStatus(provider)}
      actions={<><OAuthControl provider={provider} disabled={busy} run={run} />
        {(provider.authenticated || provider.reauthRequired) && <ActionButton danger disabled={busy} onClick={() => {
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
  const flowOpen = Boolean(flow);
  const flowState = String(flow?.state || '');
  const manualCodeFlow = providerId === 'anthropic-oauth';
  const loginLabel = providerId === 'cursor-oauth' ? 'Cursor OAuth' : `${providerLabel(provider)} OAuth`;
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
        setError(providerId === 'cursor-oauth'
          ? t('Cursor OAuth status could not be checked.')
          : t('OAuth status could not be checked.'));
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
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!flowOpen) return undefined;
    return registerMobileBack(() => closeRef.current());
  }, [flowOpen]);
  return <>
    <ActionButton disabled={disabled} onClick={() => void start()}>{provider.authenticated || provider.reauthRequired ? 'Reconnect' : 'Connect'}</ActionButton>
    {flow && <div className="settings-oauth-layer" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}><section className="settings-oauth-dialog" role="dialog" aria-modal="true" data-settings-nested-dialog
      aria-labelledby={`settings-oauth-title-${providerId}`} aria-describedby={`settings-oauth-description-${providerId}`}>
      <header><div><h3 id={`settings-oauth-title-${providerId}`}>{loginLabel}</h3>
        <p id={`settings-oauth-description-${providerId}`}>{manualCodeFlow
          ? t('Complete the browser login, then paste the authorization code.')
          : t('Finish signing in in your browser. This window updates automatically.')}</p></div>
        <button type="button" aria-label={t(providerId === 'cursor-oauth' ? 'Close Cursor OAuth' : 'Close OAuth login')} data-settings-nested-close autoFocus onClick={close}>
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

/** Every extension list row is one drill-in action. Enabled state stays
 *  visible as metadata; its switch lives in the detail surface. */
function ExtensionRow({ title, description, enabled, busy, onOpen }: {
  title: string;
  description: string;
  enabled: boolean;
  busy: boolean;
  onOpen(): void;
}) {
  return <button type="button" className="schedules-row utilities-row extensions-row"
    aria-label={title} disabled={busy} onClick={onOpen}>
    <span className="schedules-row-copy utilities-row-copy">
      <span className="sidebar-resource-title">
        <b>{title}</b>
        <span className={`sidebar-resource-state ${enabled ? 'is-enabled' : 'is-disabled'}`}>
          {t(enabled ? 'Enabled' : 'Disabled')}
        </span>
      </span>
      <small>{description}</small>
    </span>
    <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
  </button>;
}

/** Skills follow the Workflows row grammar: identity first, short source/status
 *  metadata second, and the full description only in the detail dialog. */
function SkillRow({ title, description, disabled, busy, onOpen }: {
  title: string;
  description: string;
  disabled: boolean;
  busy: boolean;
  onOpen(): void;
}) {
  return <ExtensionRow title={title} description={description}
    enabled={!disabled} busy={busy} onOpen={onOpen} />;
}

/** The detail card every section shares: facts, optional content, then the
 *  entry's actions. Rows drill IN here instead of exposing their actions in the
 *  list (user: 다른것들처럼 클릭해서 들어가서 설정하는 걸로) — the same move
 *  Workflows, Schedules and Webhooks make. Portaled for their reason too: the
 *  list lives inside the sidebar's clipped box. */
function ExtensionDetailDialog({ title, facts, content, actions, enabled, busy, onToggle, onClose }: {
  title: string;
  facts: ReadonlyArray<readonly [string, string]>;
  content?: string;
  actions: ReactNode;
  enabled?: boolean;
  busy?: boolean;
  onToggle?(enabled: boolean): void;
  onClose(): void;
}) {
  useMobileBack(true, onClose);
  useEffect(() => acquireTitleBarDim(), []);
  return createPortal(<div className="schedules-dialog-layer"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
    <section className="schedules-dialog extensions-dialog" role="dialog" aria-modal="true"
      aria-labelledby="extensions-dialog-title">
      <header>
        <h2 id="extensions-dialog-title">{title}</h2>
        <div className="schedules-dialog-header-actions">
          {typeof enabled === 'boolean' && onToggle && <CompactSwitch
            label={`${title} · ${t('Enabled')}`} checked={enabled}
            disabled={busy} onChange={onToggle} />}
          <button type="button" aria-label={t("Close")} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="extensions-dialog-body">
        <dl className="extensions-dialog-facts">
          {facts.filter(([, value]) => value).map(([label, value]) => <div key={label}>
            <dt>{t(label)}</dt>
            <dd>{value}</dd>
          </div>)}
        </dl>
        {content !== undefined && <pre className="extensions-skill-preview">{content}</pre>}
        <footer>
          {actions}
          <button type="button" className="secondary" onClick={onClose}>{t('Close')}</button>
        </footer>
      </div>
    </section>
  </div>, document.body);
}

function SkillEditorDialog({ skill, instructions, disabled, busy, readOnly = false, onClose, onSave, onToggle }: {
  skill: RecordValue | null;
  instructions: string;
  disabled: boolean;
  busy: boolean;
  readOnly?: boolean;
  onClose(): void;
  onSave(payload: RecordValue): void;
  onToggle?(): void;
}) {
  const editing = Boolean(skill);
  const [formError, setFormError] = useState('');
  useMobileBack(true, onClose);
  useEffect(() => acquireTitleBarDim(), []);
  return createPortal(<div className="schedules-dialog-layer"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
    <section className="schedules-dialog workflows-dialog extensions-skill-dialog"
      role="dialog" aria-modal="true" aria-labelledby="extensions-skill-dialog-title">
      <header>
        <h2 id="extensions-skill-dialog-title">
          {editing ? String(skill?.name || '') : t('Add skill')}
        </h2>
        <div className="schedules-dialog-header-actions">
          {editing && onToggle && <CompactSwitch
            label={`${String(skill?.name || '')} · ${t('Enabled')}`} checked={!disabled}
            disabled={busy} onChange={() => onToggle()} />}
          <button type="button" aria-label={t('Close')} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (readOnly) return;
        const data = new FormData(event.currentTarget);
        const name = String(data.get('skill-name') || '').trim();
        const description = String(data.get('skill-trigger') || '').trim();
        const body = String(data.get('skill-instructions') || '').trim();
        if (!body) {
          setFormError('SKILL.md instructions must not be empty.');
          return;
        }
        setFormError('');
        onSave({
          ...(editing ? { originalName: String(skill?.name || '') } : {}),
          name,
          description,
          instructions: body,
        });
      }}>
        <label className="schedules-field"><span>{t('Name')}</span>
          <small>{t('Shown in skill lists and menus.')}</small>
          <input name="skill-name" defaultValue={String(skill?.name || '')}
            required autoFocus={!editing} disabled={busy || readOnly} maxLength={64}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
        </label>
        <label className="schedules-field workflows-md-field extensions-trigger-field">
          <span>{t('Trigger')}</span>
          <small>{t('When should this skill be used?')}</small>
          <textarea name="skill-trigger" defaultValue={String(skill?.description || '')}
            required disabled={busy || readOnly} maxLength={1024} />
        </label>
        <label className="schedules-field workflows-md-field extensions-instructions-field">
          <span>{t('Instructions')}</span>
          <small>{t('Instructions that define how this skill works.')}</small>
          <textarea name="skill-instructions"
            defaultValue={instructions || (editing ? '' : '# Instructions\n\nDescribe how to use this skill.')}
            required spellCheck={false} disabled={busy || readOnly} />
        </label>
        <footer>
          {formError && <p className="schedules-form-error" role="alert">{formError}</p>}
          <button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
          {!readOnly && <button type="submit" disabled={busy}>{t('Save')}</button>}
        </footer>
      </form>
    </section>
  </div>, document.body);
}

/** Create form for the rail: the panel header's + action opens it above the
 *  list and submitting closes it, so the list is never permanently pushed down
 *  by a form (the settings dialog's multi-column FormRow does not fit 260px). */
function mcpTransport(config: RecordValue): string {
  const explicit = String(config.type || config.transport || '').toLowerCase();
  if (config.autoDetect) return 'autoDetect';
  if (explicit === 'streamable-http' || explicit === 'streamablehttp') return 'http';
  if (explicit === 'stdio') return 'stdio';
  if (['http', 'sse', 'ws'].includes(explicit)) return 'http';
  return config.url ? 'http' : 'stdio';
}

function mcpRowDescription(server: RecordValue): string {
  const nested = record(server.config);
  const config = Object.keys(nested).length ? nested : server;
  const transport = mcpTransport(config);
  if (transport === 'autoDetect') return t('Auto-detect');
  if (transport === 'http') {
    return [t('Streamable HTTP'), String(config.url || '').trim()].filter(Boolean).join(' · ');
  }
  return ['STDIO', String(config.command || '').trim()].filter(Boolean).join(' · ');
}

type McpPair = { key: string; value: string };

function mcpStringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function mcpPairValues(value: unknown): McpPair[] {
  return Object.entries(record(value)).map(([key, entry]) => ({ key, value: String(entry ?? '') }));
}

function mcpPairRecord(values: McpPair[], field: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of values) {
    const key = row.key.trim();
    const value = row.value;
    if (!key && !value.trim()) continue;
    if (!key) throw new Error(`${field} contains a value without a key.`);
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new Error(`${field} contains duplicate key "${key}".`);
    }
    result[key] = value;
  }
  return result;
}

function McpStringListEditor({ label, description, values, placeholder, busy, onChange }: {
  label: string;
  description: string;
  values: string[];
  placeholder: string;
  busy: boolean;
  onChange(values: string[]): void;
}) {
  const visible = values.length ? values : [''];
  return <fieldset className="extensions-mcp-list">
    <legend>{t(label)}</legend>
    <small>{t(description)}</small>
    <div className="extensions-mcp-list-rows">
      {visible.map((value, index) => <div className="extensions-mcp-list-row" key={`${label}-${index}`}>
        <input value={value} placeholder={placeholder} disabled={busy} spellCheck={false}
          onChange={(event) => {
            const next = [...visible];
            next[index] = event.currentTarget.value;
            onChange(next);
          }} />
        <button type="button" aria-label={t('Remove')} disabled={busy || (!value && values.length === 0)}
          onClick={() => onChange(visible.filter((_, rowIndex) => rowIndex !== index))}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>)}
    </div>
    <button type="button" className="extensions-mcp-list-add" disabled={busy}
      onClick={() => onChange([...visible.filter((value, index) => value || index < values.length), ''])}>
      + {t('Add')}
    </button>
  </fieldset>;
}

function McpPairListEditor({ label, description, values, keyPlaceholder, valuePlaceholder, busy, onChange }: {
  label: string;
  description: string;
  values: McpPair[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  busy: boolean;
  onChange(values: McpPair[]): void;
}) {
  const visible = values.length ? values : [{ key: '', value: '' }];
  return <fieldset className="extensions-mcp-list">
    <legend>{t(label)}</legend>
    <small>{t(description)}</small>
    <div className="extensions-mcp-list-rows">
      {visible.map((row, index) => <div className="extensions-mcp-list-row extensions-mcp-pair-row"
        key={`${label}-${index}`}>
        <input value={row.key} placeholder={keyPlaceholder} disabled={busy} spellCheck={false}
          onChange={(event) => {
            const next = visible.map((entry) => ({ ...entry }));
            next[index].key = event.currentTarget.value;
            onChange(next);
          }} />
        <input value={row.value} placeholder={valuePlaceholder} disabled={busy} spellCheck={false}
          onChange={(event) => {
            const next = visible.map((entry) => ({ ...entry }));
            next[index].value = event.currentTarget.value;
            onChange(next);
          }} />
        <button type="button" aria-label={t('Remove')} disabled={busy || (!row.key && !row.value && values.length === 0)}
          onClick={() => onChange(visible.filter((_, rowIndex) => rowIndex !== index))}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>)}
    </div>
    <button type="button" className="extensions-mcp-list-add" disabled={busy}
      onClick={() => onChange([
        ...visible.filter((row, index) => row.key || row.value || index < values.length),
        { key: '', value: '' },
      ])}>
      + {t('Add')}
    </button>
  </fieldset>;
}

function McpEditorDialog({ server, busy, onClose, onSave, onToggle, onRemove }: {
  server: RecordValue | null;
  busy: boolean;
  onClose(): void;
  onSave(payload: RecordValue): void;
  onToggle?(): void;
  onRemove?(): void;
}) {
  const editing = Boolean(server);
  const config = record(server?.config);
  const initialTransport = mcpTransport(config);
  const [transport, setTransport] = useState(initialTransport);
  const [args, setArgs] = useState(() => mcpStringValues(config.args));
  const [env, setEnv] = useState(() => mcpPairValues(config.env));
  const [envVars, setEnvVars] = useState(() => mcpStringValues(config.env_vars));
  const [headers, setHeaders] = useState(() => mcpPairValues(config.headers));
  const [envHeaders, setEnvHeaders] = useState(() => mcpPairValues(config.env_http_headers));
  const [formError, setFormError] = useState('');
  const autoDetect = initialTransport === 'autoDetect';
  useMobileBack(true, onClose);
  useEffect(() => acquireTitleBarDim(), []);
  return createPortal(<div className="schedules-dialog-layer"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
    <section className="schedules-dialog extensions-skill-dialog extensions-mcp-dialog"
      role="dialog" aria-modal="true" aria-labelledby="extensions-mcp-dialog-title">
      <header>
        <h2 id="extensions-mcp-dialog-title">
          {editing ? String(server?.name || '') : t('Add MCP server')}
        </h2>
        <div className="schedules-dialog-header-actions">
          {editing && onToggle && <CompactSwitch
            label={`${String(server?.name || '')} · ${t('Enabled')}`}
            checked={server?.enabled !== false} disabled={busy}
            onChange={() => onToggle()} />}
          <button type="button" aria-label={t('Close')} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (autoDetect) return;
        const data = new FormData(event.currentTarget);
        try {
          const name = String(data.get('mcp-name') || '').trim();
          const payload: RecordValue = {
            ...(editing ? { originalName: String(server?.name || '') } : {}),
            name,
            type: transport,
          };
          if (transport === 'stdio') {
            payload.command = String(data.get('mcp-command') || '').trim();
            payload.args = args.map((value) => value.trim()).filter(Boolean);
            payload.env = mcpPairRecord(env, 'Environment');
            payload.env_vars = envVars.map((value) => value.trim()).filter(Boolean);
            payload.cwd = String(data.get('mcp-cwd') || '').trim();
          } else {
            payload.url = String(data.get('mcp-url') || '').trim();
            payload.headers = mcpPairRecord(headers, 'Headers');
            payload.bearer_token_env_var = String(data.get('mcp-bearer-token-env') || '').trim();
            payload.env_http_headers = mcpPairRecord(envHeaders, 'Environment-backed headers');
          }
          setFormError('');
          onSave(payload);
        } catch (error) {
          setFormError(error instanceof Error ? error.message : String(error));
        }
      }}>
        {editing && <p className="extensions-mcp-summary">
          {String(server?.status || 'unknown')}{server?.error ? ` · ${String(server.error)}` : ''}
        </p>}
        <section className="extensions-mcp-card extensions-mcp-identity-card">
          <label className="schedules-field"><span>{t('Name')}</span>
            <small>{t('Shown in the MCP server list.')}</small>
            <input name="mcp-name" defaultValue={String(server?.name || '')}
              required autoFocus={!editing} disabled={busy || autoDetect} maxLength={80}
              pattern="[a-z0-9_.-]+" />
          </label>
          <div className="schedules-field extensions-mcp-transport-field">
            <span>{t('Transport')}</span>
            <small>{t('How Mixdog connects to this MCP server.')}</small>
            {autoDetect ? <p className="extensions-mcp-note">{t('Auto-detect')}</p>
              : <div className="extensions-mcp-transport" role="group" aria-label={t('Transport')}>
                <button type="button" className={transport === 'stdio' ? 'active' : ''}
                  aria-pressed={transport === 'stdio'} disabled={busy}
                  onClick={() => setTransport('stdio')}>
                  <Check size={12} aria-hidden="true" />
                  <span>{t('stdio')}</span>
                </button>
                <button type="button" className={transport === 'http' ? 'active' : ''}
                  aria-pressed={transport === 'http'} disabled={busy}
                  onClick={() => setTransport('http')}>
                  <Check size={12} aria-hidden="true" />
                  <span>{t('Streamable HTTP')}</span>
                </button>
              </div>}
          </div>
        </section>
        {transport === 'stdio' ? <section className="extensions-mcp-card extensions-mcp-config-card">
          <label className="schedules-field"><span>{t('Command')}</span>
            <small>{t('Executable used to start the stdio server.')}</small>
            <input name="mcp-command" defaultValue={String(config.command || '')}
              required disabled={busy} spellCheck={false} />
          </label>
          <McpStringListEditor label="Arguments" description="One command argument per row."
            values={args} placeholder="--argument" busy={busy} onChange={setArgs} />
          <McpPairListEditor label="Environment" description="Environment variables passed to the server."
            values={env} keyPlaceholder={t('Key')} valuePlaceholder={t('Value')}
            busy={busy} onChange={setEnv} />
          <McpStringListEditor label="Environment passthrough"
            description="Environment variable names inherited by the server."
            values={envVars} placeholder="VARIABLE_NAME" busy={busy} onChange={setEnvVars} />
          <label className="schedules-field"><span>{t('Working directory')}</span>
            <small>{t('Optional directory used when starting the server.')}</small>
            <input name="mcp-cwd" defaultValue={String(config.cwd || '')}
              placeholder="~/code" disabled={busy} spellCheck={false} />
          </label>
        </section> : !autoDetect && <section className="extensions-mcp-card extensions-mcp-config-card">
          <label className="schedules-field"><span>{t('URL')}</span>
            <small>{t('Streamable HTTP server endpoint.')}</small>
            <input name="mcp-url" type="url" defaultValue={String(config.url || '')}
              required disabled={busy} spellCheck={false} />
          </label>
          <label className="schedules-field"><span>{t('Bearer token environment variable')}</span>
            <small>{t('Environment variable containing the bearer token. The token is not stored.')}</small>
            <input name="mcp-bearer-token-env"
              defaultValue={String(config.bearer_token_env_var || '')}
              placeholder="MCP_BEARER_TOKEN"
              disabled={busy} spellCheck={false} />
          </label>
          <McpPairListEditor label="Headers" description="HTTP request headers."
            values={headers} keyPlaceholder={t('Key')} valuePlaceholder={t('Value')}
            busy={busy} onChange={setHeaders} />
          <McpPairListEditor label="Environment-backed headers"
            description="Map each HTTP header to an environment variable name."
            values={envHeaders} keyPlaceholder="Header" valuePlaceholder="VARIABLE_NAME"
            busy={busy} onChange={setEnvHeaders} />
        </section>}
        {autoDetect && <p className="extensions-mcp-note">
          {t('Built-in auto-detect servers keep their managed connection settings.')}
        </p>}
        <footer>
          {formError && <p className="schedules-form-error" role="alert">{formError}</p>}
          {editing && onRemove && <button type="button" className="danger"
            disabled={busy} onClick={onRemove}>{t('Remove')}</button>}
          <button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
          {!autoDetect && <button type="submit" disabled={busy}>{t('Save')}</button>}
        </footer>
      </form>
    </section>
  </div>, document.body);
}

function PluginInstallDialog({ busy, onClose, onSubmit }: {
  busy: boolean;
  onClose(): void;
  onSubmit(source: string): void;
}) {
  useMobileBack(true, onClose);
  useEffect(() => acquireTitleBarDim(), []);
  return createPortal(<div className="schedules-dialog-layer"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
    <section className="schedules-dialog workflows-dialog extensions-plugin-dialog"
      role="dialog" aria-modal="true" aria-labelledby="extensions-plugin-dialog-title">
      <header>
        <h2 id="extensions-plugin-dialog-title">{t('Install plugin')}</h2>
        <div className="schedules-dialog-header-actions">
          <button type="button" aria-label={t('Close')} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const source = String(new FormData(event.currentTarget).get('source') || '').trim();
        if (!source) return;
        onSubmit(source);
        onClose();
      }}>
        <label className="schedules-field">
          <span>{t('Source')}</span>
          <input name="source" placeholder="https://github.com/org/plugin or C:\path"
            required autoFocus disabled={busy} />
        </label>
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" disabled={busy}>{t('Install')}</button>
        </footer>
      </form>
    </section>
  </div>, document.body);
}

function McpPanel({ data, pending, run, confirm, createOpen, closeCreate }: PanelContext) {
  const status = record(data.mcp);
  const servers = rows(status, 'servers');
  const busy = Boolean(pending);
  const [openName, setOpenName] = useState('');
  const [openServer, setOpenServer] = useState<RecordValue | null>(null);
  const openEditor = async (name: string) => {
    closeCreate?.();
    setOpenName(name);
    setOpenServer(null);
    const detail = await run<RecordValue>('getMcpServerConfig', [name], `mcp-config-${name}`, false);
    if (detail) {
      const row = servers.find((server) => String(server.name) === name);
      setOpenServer({ ...(row || {}), ...detail });
    }
  };
  const closeEditor = () => {
    setOpenName('');
    setOpenServer(null);
  };
  // No section title: the filter tag above already names the resource kind, and
  // repeating it printed the same word twice under the tabs (user: 이상한데).
  return <Group>
    {createOpen && <McpEditorDialog key="new-mcp" server={null} busy={busy}
      onClose={() => closeCreate?.()}
      onSave={(payload) => {
        closeCreate?.();
        void run('saveMcpServer', [payload]);
      }} />}
    {servers.length ? servers.map((server) => {
      const name = String(server.name);
      const enabled = server.enabled !== false;
      return <ExtensionRow key={name} title={name}
        description={mcpRowDescription(server)}
        enabled={enabled} busy={busy}
        onOpen={() => void openEditor(name)} />;
    }) : <ListEmpty text={sectionLoaded(data, 'mcp')
      ? 'No MCP servers configured.' : 'Loading MCP servers…'} />}
    {openName && openServer && <McpEditorDialog key={openName}
      server={openServer} busy={busy} onClose={closeEditor}
      onSave={(payload) => {
        closeEditor();
        void run('saveMcpServer', [payload]);
      }}
      onToggle={() => {
        const enabled = openServer.enabled !== false;
        void run('setMcpServerEnabled', [openName, !enabled]);
      }}
      onRemove={() => confirm({
        title: 'Remove MCP server?',
        description: t('{{name}} will be removed from Mixdog.', { name: openName }),
        confirmLabel: 'Remove',
        danger: true,
        onConfirm: () => {
          const name = openName;
          closeEditor();
          void run('removeMcpServer', [name]);
        },
      })} />}
  </Group>;
}

function SkillsPanel({ data, pending, run, createOpen, closeCreate }: PanelContext) {
  const status = record(data.skills);
  const skills = rows(status, 'skills');
  const disabled = new Set((Array.isArray(record(data.disabledSkills).disabled) ? record(data.disabledSkills).disabled as unknown[] : []).map(String));
  const busy = Boolean(pending);
  // User-global skills are editable. Plugin-provided skills use the same detail
  // surface but remain read-only because their installation owns the files.
  const [detail, setDetail] = useState<{ name: string; content: string } | null>(null);
  const toggle = (name: string) => {
    const next = new Set(disabled);
    if (next.has(name)) next.delete(name); else next.add(name);
    void run('setDisabledSkills', [[...next]]);
  };
  const open = detail ? skills.find((skill) => String(skill.name) === detail.name) : undefined;
  const openOff = detail ? disabled.has(detail.name) : false;
  const openDetail = (name: string) => {
    closeCreate?.();
    void run<RecordValue>('skillContent', [name], `skill-content-${name}`, false)
      .then((value) => {
        if (value !== undefined) {
          setDetail({ name, content: String(record(value).content || '') });
        }
      });
  };
  const save = async (payload: RecordValue) => {
    const capability = detail ? 'saveSkill' : 'addSkill';
    const value = await run<RecordValue>(capability, [payload]);
    if (value === undefined) return;
    setDetail(null);
    closeCreate?.();
    showDesktopToast(`Saved "${String(payload.name || '')}".`, 'success');
  };
  return <Group>
    {createOpen && <SkillEditorDialog skill={null} instructions="" disabled={false} busy={busy}
      onClose={() => closeCreate?.()} onSave={(payload) => void save(payload)} />}
    {skills.length ? skills.map((skill) => {
      const name = String(skill.name);
      const off = disabled.has(name);
      const description = String(skill.description || '').trim() || t('Skill instructions');
      return <SkillRow key={name} title={name} description={description} disabled={off}
        busy={busy} onOpen={() => openDetail(name)} />;
    }) : <ListEmpty text={sectionLoaded(data, 'skills')
      ? 'No skills found.' : 'Loading skills…'} />}
    {detail && open && <SkillEditorDialog key={detail.name} skill={open}
      instructions={detail.content} disabled={openOff} busy={busy}
      readOnly={open.editable === false}
      onClose={() => setDetail(null)} onSave={(payload) => void save(payload)}
      onToggle={() => toggle(detail.name)} />}
  </Group>;
}

function PluginsPanel({ data, pending, run, confirm, createOpen, closeCreate }: PanelContext) {
  const status = record(data.plugins);
  const plugins = rows(status, 'plugins');
  const busy = Boolean(pending);
  const [openId, setOpenId] = useState('');
  const open = openId ? plugins.find((plugin) => String(plugin.id || plugin.name) === openId) : undefined;
  return <Group>
    {createOpen && <PluginInstallDialog busy={busy}
      onClose={() => closeCreate?.()}
      onSubmit={(source) => void run('addPlugin', [source])} />}
    {plugins.length ? plugins.map((plugin) => {
      const id = String(plugin.id || plugin.name);
      const enabled = plugin.enabled !== false;
      const description = String(plugin.description || '').trim()
        || [String(plugin.version || '').trim(), String(plugin.sourceType || plugin.source || '').trim()]
          .filter(Boolean).join(' · ')
        || t('Installed plugin');
      return <ExtensionRow key={id} title={label(plugin)}
        description={description}
        enabled={enabled} busy={busy}
        onOpen={() => setOpenId(id)} />;
    }) : <ListEmpty text={sectionLoaded(data, 'plugins')
      ? 'No plugins installed.' : 'Loading plugins…'} />}
    {open && <ExtensionDetailDialog title={label(open)}
      enabled={open.enabled !== false} busy={busy}
      onToggle={(next) => void run('setPluginEnabled', [open, next])}
      facts={[
        ['Version', String(open.version || 'unversioned')],
        ['Skills', String(open.skillCount ?? '')],
        ['Description', String(open.description || '')],
        ['Source', String(open.sourceType || '')],
        ['Root', String(open.root || '')],
        ['MCP server', String(open.mcpServerName || '')],
      ]}
      actions={<>
        <button type="button" disabled={busy} onClick={() => void run('updatePlugin', [open])}>
          {open.sourceType === 'local' ? t('Update metadata') : t('Update plugin')}
        </button>
        {Boolean(open.mcpScript) && <button type="button" disabled={busy}
          onClick={() => void run('enablePluginMcp', [open])}>
          {open.mcpEnabled ? t('Reconfigure MCP') : t('Enable MCP')}
        </button>}
        {Boolean(open.root) && <button type="button"
          onClick={() => void navigator.clipboard?.writeText(String(open.root))}>
          {t('Copy root')}
        </button>}
        {Boolean(open.mcpServerName) && <button type="button"
          onClick={() => void navigator.clipboard?.writeText(String(open.mcpServerName))}>
          {t('Copy MCP name')}
        </button>}
        <button type="button" className="danger" disabled={busy}
          onClick={() => confirm({
            title: 'Remove plugin?',
            description: t('{{name}} will be removed from Mixdog.', { name: label(open) }),
            confirmLabel: 'Remove',
            danger: true,
            onConfirm: () => {
              setOpenId('');
              void run('removePlugin', [open]);
            },
          })}>{t('Remove')}</button>
      </>}
      onClose={() => setOpenId('')} />}
  </Group>;
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
function ContextPanel({ data, pending, run }: PanelContext) {
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

function DesktopAgentControlGroup({
  settingKey,
  title,
  description,
  toggleTitle,
  hidden = false,
}: {
  settingKey: Extract<DesktopSettingKey, 'computerControl' | 'browserControl'>;
  title: string;
  description: string;
  toggleTitle: string;
  hidden?: boolean;
}) {
  const api = (window as unknown as { mixdogDesktop?: Partial<DesktopApi> }).mixdogDesktop;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    void api?.readSettings?.().then((settings) => {
      if (live) setEnabled(settings[settingKey] === true);
    }).catch(() => {});
    return () => { live = false; };
  }, [api, settingKey]);
  if (hidden || enabled === null || !api?.updateSetting) return null;
  return <Group title={title} description={description}>
    <ToggleRow title={toggleTitle} checked={enabled} disabled={saving}
      onChange={(value) => {
        if (saving) return;
        const previous = enabled;
        setEnabled(value);
        setSaving(true);
        void api.updateSetting?.(settingKey, value).then((settings) => {
          setEnabled(settings[settingKey] === true);
        }).catch((reason) => {
          setEnabled(previous);
          showDesktopToast(reason instanceof Error ? reason.message : String(reason), 'error');
        }).finally(() => setSaving(false));
      }} />
  </Group>;
}

// Desktop-local Computer Use opt-in (Windows only): exposes the agent
// `computer` tool that reads UI Automation trees and drives real windows.
// High risk, so default off; the main process starts/stops the bridge live.
function DesktopComputerUseGroup() {
  return <DesktopAgentControlGroup settingKey="computerControl" title="Computer Use"
    description="Let agents inspect screens, read UI and clipboard text, and operate real windows with the mouse and keyboard. Windows only."
    toggleTitle="Enable Computer Use"
    hidden={!navigator.userAgent.includes('Windows')} />;
}

// Browser Use opt-in: exposes the agent `browser` tool that drives the in-app
// browser. Only the agent bridge starts/stops with this toggle — the browser
// window itself stays available to the user either way.
function DesktopBrowserUseGroup() {
  return <DesktopAgentControlGroup settingKey="browserControl" title="Browser Use"
    description="Let agents operate the in-app browser or one Chrome tab you explicitly connect."
    toggleTitle="Enable Browser Use" />;
}

function SystemPanelBody(context: PanelContext) {
  const { pending, run } = context;
  const busy = Boolean(pending);
  return <>
    {/* The remote runtime toggle moved to the session header (user decision):
        a persistent on/off button next to the context indicator. */}
    <UpdatePanel {...context} />
    <DesktopPowerGroup />
    <DesktopBrowserUseGroup />
    <DesktopComputerUseGroup />
    <Group title="Doctor">
      <ResourceRow title="Diagnostics" description="Check the runtime, providers, integrations, and local installation."
        actions={<ActionButton disabled={busy} onClick={() => void run('runDoctor')}>Run doctor</ActionButton>} />
    </Group>
  </>;
}

// Schedules and webhook endpoints both moved to dedicated main-pane pages
// (sidebar → Schedules / Webhooks); the Channels settings page is retired.
