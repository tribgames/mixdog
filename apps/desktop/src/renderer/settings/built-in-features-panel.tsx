import { CapabilityIcon } from '../CapabilityIcon';
import { useEffect, useMemo, useState } from 'react';

import type {
  DesktopGitCliStatus,
  DesktopLibreOfficeStatus,
  DesktopSettings,
  DesktopTidyEngineStatus,
  DesktopTidyInstallStatus,
} from '../../shared/contract';
import { t } from '../i18n';
import { ErrorNotice } from '../ErrorNotice';
import { record } from '../record-utils';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { publishAutoEffort } from '../auto-effort-store';
import type { SidebarResourceTag } from '../sidebar-resource-row';
import { CompactSwitch, Group } from './capability-controls';
import { sectionLoaded, type PanelContext, type RecordValue } from './capability-data';
import { ExtensionDetailDialog, ExtensionNote, ExtensionRow } from './extension-detail';
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
import { getCachedDesktopStatus, readDesktopStatus, storeDesktopStatus } from './desktop-status-cache';
import { useTidyEngineStatus } from './tidy-status';
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
  status: 'installing' | 'failed' | 'toggling';
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
function useDesktopFeatureStatus(api: PanelContext['api']) {
  const [settings, setSettings] = useState<DesktopSettings | null>(
    () => getCachedDesktopStatus(api, 'settings') ?? null
  );
  const [gitStatus, setGitStatus] = useState<DesktopGitCliStatus | null>(
    () => getCachedDesktopStatus(api, 'gitCli') ?? null
  );
  const [officeDependency, setOfficeDependency] = useState<DesktopLibreOfficeStatus | null>(
    () => getCachedDesktopStatus(api, 'libreOffice') ?? null
  );
  useEffect(() => {
    let live = true;
    const read = () =>
      void readDesktopStatus(api, 'settings')
        ?.then((next) => {
          if (live) setSettings(next);
        })
        .catch(() => {});
    read();
    const unsubscribe = subscribeSetupChanges(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [api]);
  useEffect(() => {
    let live = true;
    void readDesktopStatus(api, 'gitCli')
      ?.then((next) => {
        if (live) setGitStatus(next);
      })
      .catch(() => {});
    void readDesktopStatus(api, 'libreOffice')
      ?.then((next) => {
        if (live) setOfficeDependency(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);
  return { settings, setSettings, gitStatus, setGitStatus, officeDependency, setOfficeDependency };
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
  /** Code Tidy only: installed, but a core engine it should have is missing. */
  enginesMissing?: boolean;
};

/** Short list tag for noteworthy states (not installed, installing, failed, disabled). */
export function featureStatus({
  ready,
  installed,
  supported,
  available,
  action,
  progressPercent,
  enabled,
  readinessBlocking,
  enginesMissing,
}: FeatureState): SidebarResourceTag | null {
  if (!ready) return null;
  if (!available) return supported ? null : { label: t('Unavailable'), tone: 'muted' };
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
  const { feature, installed, enabled, ready, supported, available, busy, action, progressPercent } = state;
  const installing = action?.status === 'installing';
  const failed = action?.status === 'failed';
  let control = (
    <CompactSwitch
      label={t(feature.title)}
      checked={enabled}
      optimistic={false}
      disabled={!available || busy}
      onChange={onToggle}
    />
  );
  if (!ready) {
    control = <span className="built-in-feature-control-placeholder" aria-hidden="true" />;
  } else if (installing) {
    control = <SlotProgress percent={progressPercent} label={t('Installing {{name}}…', { name: t(feature.title) })} />;
  } else if (!installed && feature.id === 'localProvider') {
    control = <span>{t(available || supported ? 'Install through chat' : 'Unavailable')}</span>;
  } else if (!installed) {
    control = (
      <button
        type="button"
        className="extensions-action"
        disabled={!available || busy}
        aria-label={t('Install {{name}}', { name: t(feature.title) })}
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
  tidyStatus,
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
  tidyStatus: DesktopTidyEngineStatus | null;
  tidyInstallStatus: DesktopTidyInstallStatus | null;
  onInstallTidyEngine(id: string): void;
  onInstall(): void;
  onToggle(enabled: boolean): void;
  onClose(): void;
  localActions: LocalProviderActions;
}) {
  const { feature, action, ready, installed } = state;
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
      {ready && !installed && requirement ? (
        <ExtensionNote>{t('Requires {{name}}', { name: requirement })}</ExtensionNote>
      ) : null}
      <ErrorNotice
        errors={[
          action?.status === 'failed' ? action.message : '',
          feature.id === 'localProvider' && !state.localProvider.running ? state.localProvider.lastError : '',
          feature.id === 'localProvider' ? record(state.localProvider.hardware).error : '',
        ]}
      />
      {feature.id === 'git' && <GitPanel api={api} />}
      {feature.id === 'localProvider' && <LocalProviderModels status={state.localProvider} actions={localActions} />}
      {feature.id === 'tidy' && (
        <TidyEngines
          status={tidyStatus}
          installStatus={tidyInstallStatus}
          installed={installed}
          busy={state.busy}
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
  run,
  api,
  initialFeature = null,
  onDetailClose,
}: PanelContext & {
  initialFeature?: BuiltInFeatureId | null;
  /** Detail only: no list, just `initialFeature`'s card (the 커넥터 tab's
   *  GitHub row opens Git & GitHub here); called when it closes. */
  onDetailClose?(): void;
}) {
  const localActions = useLocalProviderActions(run, pending);
  const { settings, setSettings, gitStatus, setGitStatus, officeDependency, setOfficeDependency } =
    useDesktopFeatureStatus(api);
  const [action, setAction] = useState<FeatureAction | null>(null);
  // Optimistic toggle state: the switch flips immediately and rolls back if
  // the round trip fails, instead of sitting still until the daemon answers.
  const [optimistic, setOptimistic] = useState<{ id: BuiltInFeatureId; value: boolean } | null>(null);
  const [voiceInstalled, setVoiceInstalled] = useState(false);
  const [openId, setOpenId] = useState<BuiltInFeatureId | null>(initialFeature);
  const toolModules = record(data.toolModules);
  const localProvider = useLocalProviderStatus(
    api,
    toolModules.localProvider,
    openId === 'localProvider' || action?.id === 'localProvider'
  );
  const tidy = useTidyEngineStatus(
    api,
    openId === 'tidy' || action?.id === 'tidy' || record(toolModules.tidy).installed === true,
    action?.id === 'tidy' && action?.status === 'installing',
    openId === 'tidy'
  );
  const autoEffort = useAutoEffortStatus(api, toolModules.autoEffort);
  const computerReadiness = useComputerReadiness(api, openId === 'computer');
  const media = useMediaGeneration(api, openId === 'media' && !serverWindow);
  const voice = record(data.voice);
  const progress = voiceProgress(snapshot);
  useEffect(() => {
    if (voice.installed === true) setVoiceInstalled(true);
  }, [voice.installed]);

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
      voice: voiceInstalled || voice.installed === true,
    }),
    [gitStatus?.installed, settings, toolModules, localProvider, autoEffort, voice.installed, voiceInstalled]
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
    const saved = await api.updateSetting(key, next);
    setSettings(storeDesktopStatus(api, 'settings', saved));
    // Session Browser surfaces follow the install markers live instead of polling.
    window.dispatchEvent(new Event('mixdog:built-in-features-changed'));
    return saved[key] === next;
  };

  const setEnabled = async (id: BuiltInFeatureId, next: boolean): Promise<boolean> => {
    if (id === 'browser') return updateDesktopSetting('browserControl', next);
    if (id === 'computer') return updateDesktopSetting('computerControl', next);
    if (id === 'memory') {
      const result = record(await run('setMemoryToolsEnabled', [next], `built-in-${id}`));
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
      if (id === 'autoEffort') publishAutoEffort(result);
      return record(result[id]).enabled === next;
    }
    // Voice OFF preserves the managed runtime, so the authoritative installed
    // status keeps the card in its toggle state for an instant re-enable.
    const result = record(await run('toggleVoice', [next], `built-in-${id}`));
    setVoiceInstalled(result.installed === true);
    window.dispatchEvent(new Event('mixdog:voice-runtime-changed'));
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
  const install = (id: BuiltInFeatureId) => {
    if (id === 'localProvider' || id === 'visualize' || id === 'media') return;
    if ((action && action.status !== 'failed') || pending) return;
    setAction({ id, status: 'installing' });
    void (async () => {
      if (id === 'git') {
        const next = await api.installGitCli?.();
        if (!next?.installed) throw new Error(t('Git installation did not complete.'));
        setGitStatus(storeDesktopStatus(api, 'gitCli', next));
        if (!(await setEnabled('git', true))) throw new Error(t('Git could not be enabled.'));
      } else if (id === 'voice') {
        const result = record(await run('toggleVoice', [true], `built-in-${id}`));
        if (result.enabled !== true || result.installed !== true) {
          throw new Error(t('Voice transcription installation did not complete.'));
        }
        setVoiceInstalled(true);
        window.dispatchEvent(new Event('mixdog:voice-runtime-changed'));
      } else if (id === 'memory' || id === 'office' || id === 'tidy' || id === 'autoEffort') {
        // Office leans on LibreOffice for rendering and recalculation, so its
        // Install step brings the dependency in first (winget/brew) — the same
        // guided pattern the Git card uses for system Git.
        if (id === 'office' && officeDependency?.installed !== true && api.installLibreOffice) {
          const dependency = await api.installLibreOffice();
          if (!dependency?.installed) {
            throw new Error(t('LibreOffice installation did not complete.'));
          }
          setOfficeDependency(storeDesktopStatus(api, 'libreOffice', dependency));
        }
        const result = record(await run('installBuiltinFeature', [id], `built-in-${id}`));
        const entry = record(result[id]);
        if (entry.installed !== true || entry.enabled !== true) {
          throw new Error(t('Installation did not complete.'));
        }
        if (id === 'autoEffort') publishAutoEffort(result);
        if (id === 'tidy') {
          await tidy.refresh();
        }
      } else {
        // Browser Use / Computer Use ship bundled: install marks the
        // feature activated, then turns its control on.
        const marker = id === 'browser' ? ('browserInstalled' as const) : ('computerInstalled' as const);
        const control = id === 'browser' ? ('browserControl' as const) : ('computerControl' as const);
        if (!(await updateDesktopSetting(marker, true)) || !(await updateDesktopSetting(control, true))) {
          throw new Error(t('The setting could not be saved.'));
        }
      }
      setAction(null);
    })().catch((error: unknown) => setAction({ id, status: 'failed', message: reason(error) }));
  };
  // Retry/Install for one missing Code Tidy engine: only that engine is
  // downloaded, and the feature's installed/enabled state is left alone.
  const installTidyEngine = (engine: string) => {
    if ((action && action.status !== 'failed') || pending) return;
    setAction({ id: 'tidy', status: 'installing' });
    void run('installBuiltinFeature', ['tidy', { engines: [engine] }], 'built-in-tidy')
      .then(() => tidy.refresh())
      .then(() => setAction(null))
      .catch((error: unknown) => setAction({ id: 'tidy', status: 'failed', message: reason(error) }));
  };
  const localInstalling =
    Array.isArray(localProvider.installations) &&
    localProvider.installations.some((entry) => installationActive(record(entry)));
  const busy = Boolean(pending) || (action !== null && action.status !== 'failed') || localInstalling;
  const stateOf = (feature: BuiltInFeatureDefinition): FeatureState => {
    // Local Provider runs where the runtime pins a llama.cpp build (Windows
    // CUDA, Apple Silicon Metal); its catalog says so for this host.
    // Auto effort needs onnxruntime-node, which has no Intel Mac binding.
    const supported =
      (feature.id !== 'localProvider' || localProvider.platformSupported !== false) &&
      (feature.id !== 'autoEffort' || autoEffort.supported !== false);
    const available = supported && (feature.id !== 'localProvider' || localProvider.available !== false);
    // Every entry waits for its own status source before painting a control,
    // so an Install pill never flashes into a toggle (or back).
    let ready = sectionLoaded(data, 'toolModules');
    if (feature.id === 'git') ready = gitStatus !== null && sectionLoaded(data, 'toolModules');
    else if (feature.id === 'browser' || feature.id === 'computer') {
      ready = settings !== null;
    } else if (feature.id === 'voice') ready = sectionLoaded(data, 'voice');
    let progressPercent: number | null = null;
    if (feature.id === 'localProvider') {
      progressPercent = installationPercent(localProviderInstallation(localProvider, 'runtime'));
    } else if (feature.id === 'voice' || feature.id === 'memory') {
      progressPercent = progress.percent;
    } else if (feature.id === 'tidy') {
      progressPercent = tidy.installStatus?.percent ?? tidy.status?.installing?.percent ?? null;
    }
    return {
      feature,
      installed: installed[feature.id],
      enabled: optimistic?.id === feature.id ? optimistic.value : enabled[feature.id],
      ready,
      supported,
      available,
      busy,
      // Auto reasoning also installs in the background (boot download), which
      // the card shows as its own Install step.
      action:
        action?.id === feature.id
          ? action
          : feature.id === 'autoEffort' && autoEffort.installing === true
            ? { id: feature.id, status: 'installing' }
            : null,
      progressPercent,
      localProvider,
      info:
        feature.id === 'media'
          ? { generators: mediaGeneratorNames(media.lanes) }
          : record(feature.id === 'voice' ? voice.info : record(toolModules[feature.id]).info),
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
      tidyStatus={tidy.status}
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
