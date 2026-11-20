import { CapabilityIcon } from '../CapabilityIcon';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { DesktopGitCliStatus, DesktopLibreOfficeStatus, DesktopSettings } from '../../shared/contract';
import { t } from '../i18n';
import { showDesktopToast } from '../desktop-toasts';
import { ErrorNotice } from '../ErrorNotice';
import { record } from '../record-utils';
import { REMOTE_CONNECTION_READY_EVENT } from '../remote-connection-state';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { publishAutoEffort } from '../auto-effort-store';
import { useSection } from '../section-store';
import type { SidebarResourceTag } from '../sidebar-resource-row';
import { CompactSwitch, Group } from './capability-controls';
import { sectionError, sectionLoaded, type PanelContext, type RecordValue } from './capability-data';
import {
  ExtensionAction,
  ExtensionDetailDialog,
  ExtensionNote,
  ExtensionRow,
  ExtensionSection,
} from './extension-detail';
import { BUILT_IN_FEATURES, type BuiltInFeatureDefinition, type BuiltInFeatureId } from './built-in-feature-registry';
import { SlotProgress } from './built-in-install-progress';
import { LocalProviderModels } from './local-provider-models';
import { BuiltInFeatureInfo, featureRequirement } from './built-in-feature-info';
import {
  installationActive,
  installationPercent,
  localProviderInstallation,
  useLocalProviderStatus,
} from './local-provider-status';
import { useLocalProviderActions } from './local-provider-actions';
import type { LocalProviderActions } from './local-provider-actions';
import { GitPanel } from './git-panel';
import {
  getCachedDesktopStatus,
  readDesktopStatus,
  recordDesktopStatus,
  writeDesktopStatus,
} from './desktop-status-cache';
import { useTidyEngineStatus, type TidyEngineSnapshot, type TidyInstallProgress } from './tidy-status';
import { useAutoEffortStatus } from './auto-effort-status';
import { TidyEngines } from './tidy-engines';
import {
  MediaGenerationSettings,
  mediaGeneratorNames,
  useMediaGeneration,
  type MediaGenerationData,
} from './media-generation-settings';
import { computerReadinessBlocking } from './computer-readiness';
import { ComputerReadinessSection, useComputerReadiness } from './computer-readiness-section';
import { isSshConnectionWindow } from '../desktop-connection';

/** Browser Use and Computer Use drive this PC's browser and screen; a server
 *  window does not offer them. */
const PC_ONLY_FEATURES: ReadonlySet<BuiltInFeatureId> = new Set(['browser', 'computer']);
const serverWindow = isSshConnectionWindow();

type FeatureAction = {
  id: BuiltInFeatureId;
  status: 'installing' | 'repairing' | 'failed' | 'toggling';
  /** A failed Browser/Computer install can leave its marker set but control off. */
  retryDesktopInstall?: boolean;
  /** Failure reason, shown under the card next to the Retry pill. */
  message?: string;
};

const reason = (error: unknown): string =>
  String((error as Error)?.message || error || '') || t('Something went wrong');

function voiceProgress(snapshot: unknown): { text: string; percent: number | null } {
  const hint = record(record(snapshot).progressHint);
  const text = String(hint.text || '');
  const fallback = Number(text.match(/(\d+)%/)?.[1]);
  const hinted = Number(hint.percent);
  const raw = Number.isFinite(hinted) ? hinted : fallback;
  return {
    text,
    percent: Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : null,
  };
}

/** Desktop settings and the Git / LibreOffice dependency status the cards depend on. */
function useDesktopFeatureStatus(api: PanelContext['api'], officeDetailOpen: boolean) {
  const [settings, setSettings] = useState<DesktopSettings | null>(
    () => getCachedDesktopStatus(api, 'settings') ?? null
  );
  const [gitStatus, setGitStatus] = useState<DesktopGitCliStatus | null>(
    () => getCachedDesktopStatus(api, 'gitCli') ?? null
  );
  const [officeDependency, setOfficeDependency] = useState<DesktopLibreOfficeStatus | null>(
    () => getCachedDesktopStatus(api, 'libreOffice') ?? null
  );
  const [settingsFailed, setSettingsFailed] = useState(false);
  const [gitFailed, setGitFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () => {
      void Promise.resolve(readDesktopStatus(api, 'settings')).then(
        (next) => {
          if (!live) return;
          setSettingsFailed(!next);
          if (next) setSettings(next);
        },
        () => {
          if (live) setSettingsFailed(true);
        }
      );
    };
    read();
    const unsubscribe = subscribeSetupChanges(read);
    window.addEventListener(REMOTE_CONNECTION_READY_EVENT, read);
    return () => {
      live = false;
      unsubscribe();
      window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, read);
    };
  }, [api]);
  useEffect(() => {
    let live = true;
    const read = () => {
      void Promise.resolve(readDesktopStatus(api, 'gitCli')).then(
        (next) => {
          if (!live) return;
          setGitFailed(!next);
          if (next) setGitStatus(next);
        },
        () => {
          if (live) setGitFailed(true);
        }
      );
    };
    read();
    window.addEventListener(REMOTE_CONNECTION_READY_EVENT, read);
    return () => {
      live = false;
      window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, read);
    };
  }, [api]);
  useEffect(() => {
    let live = true;
    const read = () => {
      // Opening Office must detect a dependency removed since the last host probe.
      void readDesktopStatus(api, 'libreOffice', officeDetailOpen)
        ?.then((next) => {
          if (live) setOfficeDependency(next);
        })
        .catch(() => {});
    };
    read();
    window.addEventListener(REMOTE_CONNECTION_READY_EVENT, read);
    return () => {
      live = false;
      window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, read);
    };
  }, [api, officeDetailOpen]);
  return {
    settings,
    setSettings,
    gitStatus,
    setGitStatus,
    officeDependency,
    setOfficeDependency,
    settingsFailed,
    gitFailed,
  };
}

type FeatureState = {
  feature: BuiltInFeatureDefinition;
  installed: boolean;
  enabled: boolean;
  ready: boolean;
  /** False only where this host has no build of the feature at all. */
  supported: boolean;
  available: boolean;
  /** Any card's action (or a panel-wide pending) blocks every control, so the
   *  visible state always matches the panel's single-action guard. */
  busy: boolean;
  action: FeatureAction | null;
  progressPercent: number | null;
  localProvider: RecordValue;
  info: RecordValue;
  /** Computer Use only: the OS still lacks something that blocks work. */
  readinessBlocking: boolean;
  statusError?: string;
  /** Code Tidy only: installed, but a core engine it should have is missing. */
  enginesMissing?: boolean;
};

/** Short list tag for noteworthy states (not installed, installing, failed, disabled). */
export function featureStatus({
  ready,
  installed,
  available,
  action,
  progressPercent,
  enabled,
  readinessBlocking,
  enginesMissing,
  statusError,
}: FeatureState): SidebarResourceTag | null {
  if (statusError) return { label: t('Unavailable'), tone: 'muted' };
  if (!ready) return null;
  if (!available) return { label: t('Unavailable'), tone: 'muted' };
  if (action?.status === 'installing') {
    const label = progressPercent === null ? t('Installing…') : `${t('Installing…')} ${progressPercent}%`;
    return { label, tone: 'muted' };
  }
  if (action?.status === 'failed') return { label: t('Failed'), tone: 'danger' };
  if (!installed) return { label: t('Not installed'), tone: 'muted' };
  if (!enabled) return { label: t('Disabled'), tone: 'muted' };
  if (readinessBlocking || enginesMissing) return { label: t('Setup needed'), tone: 'warn' };
  return null;
}

/** Header slot of the detail dialog: placeholder → progress → Install/Retry →
 *  switch, in the order the feature's own status source allows. */
function FeatureControl({
  state,
  onInstall,
  onToggle,
}: {
  state: FeatureState;
  onInstall(): void;
  onToggle(enabled: boolean): void;
}) {
  const { feature, installed, enabled, ready, available, busy, action, progressPercent, statusError } = state;
  const installing = action?.status === 'installing';
  const failed = action?.status === 'failed';
  const retryDesktopInstall = failed && action.retryDesktopInstall && installed && !enabled;
  let control = (
    <CompactSwitch
      label={t(feature.title)}
      checked={enabled}
      optimistic={false}
      disabled={!available || busy}
      onChange={onToggle}
    />
  );
  if (statusError || !available) {
    control = <span>{t('Unavailable')}</span>;
  } else if (!ready) {
    control = <span className="built-in-feature-control-placeholder" aria-hidden="true" />;
  } else if (installing) {
    control = <SlotProgress percent={progressPercent} label={t('Installing {{name}}…', { name: t(feature.title) })} />;
  } else if (!installed && feature.id === 'localProvider') {
    control = <span>{t('Install through chat')}</span>;
  } else if (!installed || retryDesktopInstall) {
    control = (
      <button
        type="button"
        className="extensions-action"
        disabled={!available || busy}
        aria-label={retryDesktopInstall ? t('Retry') : t('Install {{name}}', { name: t(feature.title) })}
        onClick={onInstall}
      >
        {t(failed ? 'Retry' : 'Install')}
      </button>
    );
  }
  return <span className="built-in-feature-control">{control}</span>;
}

/** The parent feature owns activation; bundled skills are read-only children. */
function FeatureDetailDialog({
  state,
  onInstall,
  onToggle,
  onClose,
  localActions,
  api,
  gitStatus,
  officeDependency,
  onRepairOfficeDependency,
  tidyStatus,
  tidyStatusUnavailable,
  tidyInstallStatus,
  onInstallTidyEngine,
  computerReadiness,
  media,
}: {
  api: PanelContext['api'];
  media: MediaGenerationData;
  state: FeatureState;
  computerReadiness: ReturnType<typeof useComputerReadiness>;
  gitStatus: DesktopGitCliStatus | null;
  officeDependency: DesktopLibreOfficeStatus | null;
  onRepairOfficeDependency(): void;
  tidyStatus: TidyEngineSnapshot | null;
  tidyStatusUnavailable: boolean;
  tidyInstallStatus: TidyInstallProgress | null;
  onInstallTidyEngine(id: string): void;
  onInstall(): void;
  onToggle(enabled: boolean): void;
  onClose(): void;
  localActions: LocalProviderActions;
}) {
  const { feature, action, ready, installed } = state;
  const repairingOffice = feature.id === 'office' && action?.status === 'repairing';
  const title = t(feature.title);
  const requirement = featureRequirement(feature.id);
  return (
    <ExtensionDetailDialog
      title={title}
      onClose={onClose}
      icon={<CapabilityIcon kind="builtin" name={feature.id} />}
      tagline={t(feature.description)}
      dataAttributes={{ 'data-feature-id': feature.id }}
      headerControl={<FeatureControl state={state} onInstall={onInstall} onToggle={onToggle} />}
    >
      {ready && installed && feature.id === 'computer' ? (
        <ComputerReadinessSection rows={computerReadiness.rows} api={api} refresh={computerReadiness.refresh} />
      ) : null}
      {ready && feature.id === 'autoEffort' && !state.supported ? (
        <ExtensionNote>{t('Auto effort is not supported on Intel Macs.')}</ExtensionNote>
      ) : null}
      {ready && feature.id === 'memory' && state.info.supported === false ? (
        <ExtensionNote>
          {t('Semantic search is unavailable on Intel Macs. Memory uses keyword search only.')}
        </ExtensionNote>
      ) : null}
      {feature.id === 'memory' && (
        <ExtensionNote>
          {t(
            'Turning Memory off stops recall and background summaries, and leaves memory out when prompts are built. Stored memories and past messages are kept.'
          )}
        </ExtensionNote>
      )}
      {feature.id === 'voice' && (
        <ExtensionNote>
          {t('Turning voice transcription off stops dictation without removing the downloaded runtime.')}
        </ExtensionNote>
      )}
      {ready && !installed && requirement ? (
        <ExtensionNote>{t('Requires {{name}}', { name: requirement })}</ExtensionNote>
      ) : null}
      <ErrorNotice
        errors={[
          state.statusError,
          action?.status === 'failed' ? action.message : '',
          feature.id === 'localProvider' && !state.localProvider.running ? state.localProvider.lastError : '',
          feature.id === 'localProvider' ? record(state.localProvider.hardware).error : '',
        ]}
      />
      {feature.id === 'git' && <GitPanel api={api} />}
      {ready && installed && feature.id === 'office' && (officeDependency?.installed === false || repairingOffice) && (
        <ExtensionSection
          title="LibreOffice"
          action={
            api.installLibreOffice && !repairingOffice ? (
              <ExtensionAction disabled={state.busy} onClick={onRepairOfficeDependency}>
                {t('Install {{name}}', { name: 'LibreOffice' })}
              </ExtensionAction>
            ) : null
          }
        >
          {repairingOffice ? (
            <ExtensionNote role="status">{t('Installing {{name}}…', { name: 'LibreOffice' })}</ExtensionNote>
          ) : !api.installLibreOffice ? (
            <ExtensionNote>{t('LibreOffice installation is unavailable on this host.')}</ExtensionNote>
          ) : null}
        </ExtensionSection>
      )}
      {feature.id === 'localProvider' && <LocalProviderModels status={state.localProvider} actions={localActions} />}
      {feature.id === 'tidy' && tidyStatusUnavailable && (
        <ExtensionNote>{t('Code Tidy engine status is unavailable on this host.')}</ExtensionNote>
      )}
      {feature.id === 'tidy' && tidyStatus && (
        <TidyEngines
          status={tidyStatus}
          installStatus={tidyInstallStatus}
          installed={installed}
          busy={state.busy || Boolean(state.statusError)}
          onInstallEngine={onInstallTidyEngine}
        />
      )}
      {/* Provider accounts live on the desktop, so a server window has no
          generators or accounts to choose from. */}
      {feature.id === 'media' && !serverWindow && <MediaGenerationSettings data={media} />}
      <BuiltInFeatureInfo
        state={state}
        gitStatus={gitStatus}
        officeDependency={officeDependency}
        linux={computerReadiness.readiness?.linux}
      />
    </ExtensionDetailDialog>
  );
}

export function BuiltInFeaturesPanel({
  data,
  snapshot,
  pending,
  active = true,
  run: runCapability,
  api,
  initialFeature = null,
  onDetailClose,
}: PanelContext & {
  initialFeature?: BuiltInFeatureId | null;
  /** Detail only: no list, just `initialFeature`'s card (the 커넥터 tab's
   *  caller owns dismissal). */
  onDetailClose?(): void;
}) {
  // `run` resolves undefined only after reporting its own error.
  const runFailed = useRef(false);
  const run: PanelContext['run'] = async <T,>(...args: Parameters<PanelContext['run']>) => {
    const value = await runCapability<T>(...args);
    if (value === undefined) runFailed.current = true;
    return value;
  };
  const localActions = useLocalProviderActions(run, pending || (!api.invokeCapability ? 'unavailable' : ''));
  const [openId, setOpenId] = useState<BuiltInFeatureId | null>(initialFeature);
  const {
    settings,
    setSettings,
    gitStatus,
    setGitStatus,
    officeDependency,
    setOfficeDependency,
    settingsFailed,
    gitFailed,
  } = useDesktopFeatureStatus(api, openId === 'office');
  const [action, setAction] = useState<FeatureAction | null>(null);
  // Optimistic toggle state: the switch flips immediately and rolls back if
  // the round trip fails, instead of sitting still until the daemon answers.
  const [optimistic, setOptimistic] = useState<{ id: BuiltInFeatureId; value: boolean } | null>(null);
  // Prefer the live feed. Keep the read path for hosts that can serve the feature but do not publish this section.
  const toolModulesSection = useSection<RecordValue>('toolModules');
  const requestedModules = sectionLoaded(data, 'toolModules') ? record(data.toolModules) : undefined;
  const [legacyModules, setLegacyModules] = useState<RecordValue>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new requested read supersedes the legacy answer
  useEffect(() => setLegacyModules(undefined), [requestedModules]);
  const fallbackModules = legacyModules ?? requestedModules;
  const toolModules = useMemo(
    () => ({ ...fallbackModules, ...record(toolModulesSection) }),
    [fallbackModules, toolModulesSection]
  );
  const localProvider = useLocalProviderStatus(toolModules.localProvider);
  const tidy = useTidyEngineStatus(
    api,
    openId === 'tidy' || action?.id === 'tidy' || record(toolModules.tidy).installed === true,
    action?.id === 'tidy' && action?.status === 'installing',
    openId === 'tidy'
  );
  const autoEffort = useAutoEffortStatus(fallbackModules?.autoEffort);
  const computerReadiness = useComputerReadiness(api, openId === 'computer');
  const media = useMediaGeneration(api, openId === 'media' && !serverWindow);
  const [voiceAnswer, setVoiceAnswer] = useState<RecordValue>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new voice read supersedes the last action's answer
  useEffect(() => setVoiceAnswer(undefined), [data.voice]);
  const voice = voiceAnswer ?? record(data.voice);
  const progress = voiceProgress(snapshot);
  // Without progress pushes, observe active installs through the read API;
  // do not poll once a job finishes or the user leaves this panel.
  const localJobActive =
    Array.isArray(localProvider.installations) &&
    localProvider.installations.some((entry) => installationActive(record(entry)));
  const localRuntimeInstall = localProviderInstallation(localProvider, 'runtime');
  const pollLegacy =
    active &&
    ((!record(toolModulesSection).localProvider &&
      (localJobActive || (openId === 'localProvider' && Boolean(pending)))) ||
      (!record(toolModulesSection).autoEffort &&
        (autoEffort.installing === true || (action?.id === 'autoEffort' && action.status === 'installing'))));
  useEffect(() => {
    if (!pollLegacy || !api.invokeCapability) return;
    let live = true;
    let timer: number;
    const read = async () => {
      try {
        const response = await api.invokeCapability?.<RecordValue>({ capability: 'getToolModuleSettings', args: [] });
        if (live && response?.value) setLegacyModules(response.value);
      } finally {
        if (live) timer = window.setTimeout(() => void read().catch(() => {}), 1500);
      }
    };
    timer = window.setTimeout(() => void read().catch(() => {}), 1500);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [api, pollLegacy]);

  const installed = useMemo<Record<BuiltInFeatureId, boolean>>(
    () => ({
      git: gitStatus?.installed === true && record(toolModules.git).installed === true,
      memory: record(toolModules.memory).installed === true,
      browser: settings?.browserInstalled === true,
      computer: settings?.computerInstalled === true,
      office: record(toolModules.office).installed === true,
      // Ships with the app and has no install step: toggle only.
      media: true,
      tidy: record(toolModules.tidy).installed === true,
      localProvider: localProvider.installed === true,
      autoEffort: autoEffort.installed === true,
      // Visualize ships with the app and has no install step: toggle only.
      visualize: true,
      voice: voice.installed === true,
    }),
    [gitStatus?.installed, settings, toolModules, localProvider, autoEffort, voice.installed]
  );
  const enabled = useMemo<Record<BuiltInFeatureId, boolean>>(
    () => ({
      git: record(toolModules.git).enabled !== false,
      memory: record(toolModules.memory).enabled !== false,
      browser: settings?.browserControl === true,
      computer: settings?.computerControl === true,
      office: record(toolModules.office).enabled !== false,
      media: record(toolModules.media).enabled !== false,
      tidy: record(toolModules.tidy).enabled !== false,
      localProvider: localProvider.enabled === true,
      autoEffort: autoEffort.enabled === true,
      visualize: record(toolModules.visualize).enabled !== false,
      voice: voice.enabled === true && installed.voice,
    }),
    [installed.voice, settings, toolModules, localProvider, autoEffort, voice.enabled]
  );

  const updateDesktopSetting = async (
    key: 'browserControl' | 'computerControl' | 'browserInstalled' | 'computerInstalled',
    next: boolean
  ): Promise<boolean> => {
    if (!api.updateSetting) return false;
    const saved = await writeDesktopStatus(api, 'settings', () => api.updateSetting?.(key, next));
    if (!saved) return false;
    // The newest value held: an answer overtaken by a newer read is not shown.
    setSettings(getCachedDesktopStatus(api, 'settings') ?? saved);
    // Session Browser surfaces follow the install markers live instead of polling.
    window.dispatchEvent(new Event('mixdog:built-in-features-changed'));
    return saved[key] === next;
  };

  const rememberModuleAnswer = (answer: RecordValue) =>
    setLegacyModules((current) => ({ ...requestedModules, ...current, ...answer }));

  const setEnabled = async (id: BuiltInFeatureId, next: boolean): Promise<boolean> => {
    if (id === 'browser') return updateDesktopSetting('browserControl', next);
    if (id === 'computer') return updateDesktopSetting('computerControl', next);
    if (id === 'memory') {
      const result = record(await run('setMemoryToolsEnabled', [next], `built-in-${id}`));
      if (result.memory) rememberModuleAnswer(result);
      return record(result.memory).enabled === next;
    }
    if (
      id === 'git' ||
      id === 'office' ||
      id === 'media' ||
      id === 'localProvider' ||
      id === 'tidy' ||
      id === 'autoEffort' ||
      id === 'visualize'
    ) {
      const result = record(await run('setBuiltinToolEnabled', [id, next], `built-in-${id}`));
      if (result[id]) rememberModuleAnswer(result);
      if (id === 'autoEffort') publishAutoEffort(result);
      return record(result[id]).enabled === next;
    }
    // Voice OFF preserves the managed runtime, so the authoritative installed
    // status keeps the card in its toggle state for an instant re-enable.
    const result = record(await run('toggleVoice', [next], `built-in-${id}`));
    if (typeof result.enabled === 'boolean') {
      setVoiceAnswer(result);
      window.dispatchEvent(new CustomEvent('mixdog:voice-runtime-changed', { detail: result }));
    }
    return result.enabled === next;
  };

  const toggle = (id: BuiltInFeatureId, next: boolean) => {
    if ((action && action.status !== 'failed') || pending) return;
    setAction({ id, status: 'toggling' });
    setOptimistic({ id, value: next });
    void setEnabled(id, next)
      .then((ok) => {
        if (!ok) throw new Error(t('The setting could not be saved.'));
        setAction(null);
      })
      .catch((error: unknown) => setAction({ id, status: 'failed', message: reason(error) }))
      .finally(() => setOptimistic(null));
  };
  const installOfficeDependency = async () => {
    const dependency = await api.installLibreOffice?.();
    if (dependency) setOfficeDependency(recordDesktopStatus(api, 'libreOffice', dependency));
    if (dependency?.installed !== true) throw new Error(t('LibreOffice installation did not complete.'));
  };
  const install = (id: BuiltInFeatureId) => {
    if (id === 'localProvider' || id === 'visualize' || id === 'media') return;
    if ((action && action.status !== 'failed') || pending) return;
    setAction({ id, status: 'installing' });
    runFailed.current = false;
    const desktopInstall = id === 'browser' || id === 'computer';
    const announce = !desktopInstall;
    const name = t(BUILT_IN_FEATURES.find((feature) => feature.id === id)?.title ?? id);
    void (async () => {
      if (id === 'git') {
        if (!gitStatus?.installed) {
          const next = await api.installGitCli?.();
          if (!next?.installed) throw new Error(t('Git installation did not complete.'));
          setGitStatus(recordDesktopStatus(api, 'gitCli', next));
        }
        if (!(await setEnabled('git', true))) throw new Error(t('Git could not be enabled.'));
      } else if (id === 'voice') {
        const result = record(await run('toggleVoice', [true], `built-in-${id}`));
        if (result.enabled !== true || result.installed !== true) {
          throw new Error(t('Voice transcription installation did not complete.'));
        }
        setVoiceAnswer(result);
        window.dispatchEvent(new CustomEvent('mixdog:voice-runtime-changed', { detail: result }));
      } else if (id === 'memory' || id === 'office' || id === 'tidy' || id === 'autoEffort') {
        // Office leans on LibreOffice for rendering and recalculation, so its
        // Install step brings the dependency in first (winget/brew) — the same
        // guided pattern the Git card uses for system Git.
        if (id === 'office' && officeDependency?.installed !== true && api.installLibreOffice) {
          await installOfficeDependency();
        }
        const result = record(await run('installBuiltinFeature', [id], `built-in-${id}`));
        const entry = record(result[id]);
        if (entry.installed !== true || entry.enabled !== true) {
          throw new Error(t('Installation did not complete.'));
        }
        rememberModuleAnswer(result);
        if (id === 'autoEffort') publishAutoEffort(result);
        if (id === 'tidy') {
          await tidy.refresh();
        }
      } else if (id === 'browser' || id === 'computer') {
        // The marker can already be saved after a failed activation. Retry
        // only the remaining write; never clear the marker or enable on readback.
        const marker = id === 'browser' ? ('browserInstalled' as const) : ('computerInstalled' as const);
        if ((!installed[id] && !(await updateDesktopSetting(marker, true))) || !(await setEnabled(id, true))) {
          throw new Error(t('The setting could not be saved.'));
        }
      }
      setAction(null);
      if (announce) showDesktopToast(t('{{name}} installed.', { name }), 'success');
    })().catch((error: unknown) => {
      setAction({ id, status: 'failed', retryDesktopInstall: desktopInstall, message: reason(error) });
      // A failed `run` already surfaced its error through the settings error toast.
      if (announce && !runFailed.current)
        showDesktopToast(t('Could not install {{name}}: {{error}}', { name, error: reason(error) }), 'error');
    });
  };
  // Retry/Install for one missing Code Tidy engine: only that engine is
  // downloaded, and the feature's installed/enabled state is left alone.
  const installTidyEngine = (engine: string) => {
    if ((action && action.status !== 'failed') || pending || tidy.installStatus?.active || !tidy.status) return;
    setAction({ id: 'tidy', status: 'installing' });
    void run('installBuiltinFeature', ['tidy', { engines: [engine] }], 'built-in-tidy', true, false, 'throw')
      .then((result) => {
        if (result === undefined) throw new Error(t('Installation did not complete.'));
        return tidy.refresh();
      })
      .then(() => setAction(null))
      .catch((error: unknown) => setAction({ id: 'tidy', status: 'failed', message: reason(error) }));
  };
  const busy = Boolean(pending) || (action !== null && action.status !== 'failed') || localJobActive;
  const repairOfficeDependency = () => {
    if (busy || !installed.office || officeDependency?.installed !== false || !api.installLibreOffice) return;
    // The feature is already installed; repairing LibreOffice must not enable it.
    setAction({ id: 'office', status: 'repairing' });
    void installOfficeDependency().then(
      () => {
        setAction(null);
        showDesktopToast(t('{{name}} installed.', { name: 'LibreOffice' }), 'success');
      },
      (error: unknown) => setAction({ id: 'office', status: 'failed', message: reason(error) })
    );
  };
  const stateOf = (feature: BuiltInFeatureDefinition): FeatureState => {
    // Local Provider runs where the runtime pins a llama.cpp build (Windows
    // CUDA, Apple Silicon Metal); its catalog says so for this host.
    // Auto effort needs onnxruntime-node, which has no Intel Mac binding.
    const supported =
      (feature.id !== 'localProvider' || localProvider.platformSupported !== false) &&
      (feature.id !== 'autoEffort' || autoEffort.supported !== false);
    const available =
      feature.id === 'localProvider'
        ? enabled.localProvider || (supported && localProvider.available !== false)
        : supported;
    // Every entry waits for its own status source before painting a control,
    // so an Install pill never flashes into a toggle (or back).
    const module = record(toolModules[feature.id]);
    let ready = typeof module.enabled === 'boolean' && typeof module.installed === 'boolean';
    let statusError = ready ? '' : sectionError(data, 'toolModules');
    if (!ready && (requestedModules || (!api.invokeCapability && !api.readCapabilities))) {
      statusError ||= t('This host did not provide feature status.');
    }
    if (feature.id === 'git') {
      ready &&= gitStatus !== null;
      if (!gitStatus && gitFailed) statusError = t('Git status is unavailable on this host.');
      if (!installed.git && !gitStatus?.installed && !api.installGitCli) {
        statusError = t('Git installation is unavailable on this host.');
      }
    } else if (feature.id === 'browser' || feature.id === 'computer') {
      ready = settings !== null;
      statusError =
        !api.updateSetting || (settingsFailed && !ready)
          ? t('Desktop feature settings are unavailable on this host.')
          : '';
    } else if (
      feature.id === 'office' &&
      !installed.office &&
      officeDependency?.installed === false &&
      !api.installLibreOffice
    ) {
      statusError = t('LibreOffice installation is unavailable on this host.');
    } else if (feature.id === 'voice') {
      ready = typeof voice.enabled === 'boolean' && typeof voice.installed === 'boolean';
      statusError = ready ? '' : sectionError(data, 'voice');
      if (!ready && (sectionLoaded(data, 'voice') || (!api.invokeCapability && !api.readCapabilities))) {
        statusError ||= t('Voice transcription is unavailable on this host.');
      }
    }
    if (!statusError && !api.invokeCapability && feature.id !== 'browser' && feature.id !== 'computer') {
      statusError = t('This feature cannot be changed on this host.');
    }
    let progressPercent: number | null = null;
    if (feature.id === 'localProvider') {
      progressPercent = installationPercent(localRuntimeInstall);
    } else if (feature.id === 'voice' || feature.id === 'memory') {
      progressPercent = progress.percent;
    } else if (feature.id === 'tidy') {
      progressPercent = tidy.installStatus?.percent ?? null;
    }
    return {
      feature,
      installed: installed[feature.id],
      enabled: optimistic?.id === feature.id ? optimistic.value : enabled[feature.id],
      ready,
      supported,
      available,
      statusError,
      busy,
      // Boot and chat installs have no panel action but still report progress.
      action:
        action?.id === feature.id
          ? action
          : (feature.id === 'autoEffort' && autoEffort.installing === true) ||
              (feature.id === 'localProvider' && installationActive(localRuntimeInstall))
            ? { id: feature.id, status: 'installing' }
            : null,
      progressPercent,
      localProvider,
      info:
        feature.id === 'media'
          ? { generators: mediaGeneratorNames(media.lanes) }
          : feature.id === 'memory'
            ? { ...record(module.info), supported: module.semanticSearchSupported ?? record(module.info).supported }
            : record(feature.id === 'voice' ? voice.info : module.info),
      readinessBlocking: feature.id === 'computer' && computerReadinessBlocking(computerReadiness.rows),
      enginesMissing:
        feature.id === 'tidy' &&
        tidy.status?.engines.some((engine) => engine.core && engine.installable && engine.source === 'missing'),
    };
  };
  const open = openId ? BUILT_IN_FEATURES.find((feature) => feature.id === openId) : undefined;
  const detail = open ? (
    <FeatureDetailDialog
      key={open.id}
      state={stateOf(open)}
      api={api}
      localActions={localActions}
      gitStatus={gitStatus}
      officeDependency={officeDependency}
      onRepairOfficeDependency={repairOfficeDependency}
      tidyStatus={tidy.status}
      tidyStatusUnavailable={tidy.unavailable}
      tidyInstallStatus={tidy.installStatus}
      onInstallTidyEngine={installTidyEngine}
      computerReadiness={computerReadiness}
      media={media}
      onInstall={() => install(open.id)}
      onToggle={(next) => toggle(open.id, next)}
      onClose={onDetailClose ?? (() => setOpenId(null))}
    />
  ) : null;
  if (onDetailClose) return detail;
  return (
    <Group title={t('Built-in')}>
      {BUILT_IN_FEATURES.filter((feature) => !(serverWindow && PC_ONLY_FEATURES.has(feature.id))).map((feature) => {
        const state = stateOf(feature);
        return (
          <ExtensionRow
            key={feature.id}
            icon={<CapabilityIcon kind="builtin" name={feature.id} />}
            title={t(feature.title)}
            description={t(feature.description)}
            status={featureStatus(state)}
            enabled={state.installed && state.enabled}
            busy={false}
            onOpen={() => setOpenId(feature.id)}
            dataAttributes={{ 'data-built-in-feature': feature.id }}
          />
        );
      })}
      {detail}
    </Group>
  );
}
