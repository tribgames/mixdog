import {
  Brain,
  Cpu,
  FileSpreadsheet,
  GitBranch,
  Globe2,
  Mic,
  Monitor,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type {
  DesktopGitCliStatus,
  DesktopLibreOfficeStatus,
  DesktopSettings,
} from '../../shared/contract';
import { t } from '../i18n';
import { ErrorNotice } from '../ErrorNotice';
import { record } from '../record-utils';
import { CompactSwitch, Group } from './capability-controls';
import { sectionLoaded, type PanelContext, type RecordValue } from './capability-data';
import {
  ExtensionDetailDialog,
  ExtensionFacts,
  ExtensionHero,
  ExtensionItemRow,
  ExtensionRow,
  ExtensionSection,
} from './extension-detail';
import {
  BUILT_IN_FEATURES,
  type BuiltInFeatureDefinition,
  type BuiltInFeatureId,
} from './built-in-feature-registry';
import { SlotProgress } from './built-in-install-progress';
import { LocalProviderModels, localProviderFileSize as fileSize } from './local-provider-models';
import { installationPercent, localProviderInstallation, useLocalProviderStatus } from './local-provider-status';
import { useLocalProviderActions } from './local-provider-actions';
import type { LocalProviderActions } from './local-provider-operations';
import { ComputerAuthorizationPanel } from './computer-authorization-panel';
import { GitPanel } from './git-panel';

const FEATURE_ICONS: Readonly<Record<BuiltInFeatureId, LucideIcon>> = {
  git: GitBranch,
  memory: Brain,
  browser: Globe2,
  computer: Monitor,
  office: FileSpreadsheet,
  localProvider: Cpu,
  voice: Mic,
};

type FeatureAction = {
  id: BuiltInFeatureId;
  status: 'installing' | 'failed' | 'toggling';
  /** Failure reason, shown under the card next to the Retry pill. */
  message?: string;
};

const reason = (error: unknown): string =>
  String((error as Error)?.message || error || '') || t('Something went wrong');

const desktopSettingsCache = new WeakMap<object, DesktopSettings>();

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

type FeatureState = {
  feature: BuiltInFeatureDefinition;
  /** Built-in skills that install and toggle with this feature. */
  bundledSkills: RecordValue[];
  installed: boolean;
  enabled: boolean;
  ready: boolean;
  available: boolean;
  /** Any card's action (or a panel-wide pending) blocks every control, so the
   *  visible state always matches the panel's single-action guard. */
  busy: boolean;
  action: FeatureAction | null;
  progressPercent: number | null;
  localProvider: RecordValue;
};

/** Short list badge for the state the row cannot show as a switch. */
function featureBadge({ ready, installed, available, action, progressPercent }: FeatureState): string {
  if (!available) return t('Windows only');
  if (!ready) return '';
  if (action?.status === 'installing') {
    return progressPercent === null ? t('Installing…') : `${t('Installing…')} ${progressPercent}%`;
  }
  if (action?.status === 'failed') return t('Failed');
  if (!installed) return t('Not installed');
  return '';
}

/** Header slot of the detail dialog: placeholder → progress → Install/Retry →
 *  switch, in the order the feature's own status source allows. */
function FeatureControl({ state, onInstall, onToggle }: {
  state: FeatureState;
  onInstall(): void;
  onToggle(enabled: boolean): void;
}) {
  const { feature, installed, enabled, ready, available, busy, action, progressPercent } = state;
  const installing = action?.status === 'installing';
  const failed = action?.status === 'failed';
  return <span className="built-in-feature-control">
    {!ready
      ? <span className="built-in-feature-control-placeholder" aria-hidden="true" />
      : installing
      ? <SlotProgress percent={progressPercent} label={t('Installing {{name}}…', { name: t(feature.title) })} />
      : !installed && feature.id === 'localProvider'
      ? <span>{t('Install through chat')}</span>
      : !installed
      ? <button type="button" disabled={!available || busy}
          aria-label={t('Install {{name}}', { name: t(feature.title) })} onClick={onInstall}>
          {t(failed ? 'Retry' : 'Install')}
        </button>
      : <CompactSwitch label={t(feature.title)} checked={enabled} optimistic={false}
          disabled={!available || busy} onChange={onToggle} />}
  </span>;
}

/** External component a feature's Install step brings in; '' when none. */
function featureRequirement(id: BuiltInFeatureId): string {
  if (id === 'git') return 'Git CLI · GitHub CLI';
  if (id === 'office') return 'LibreOffice';
  if (id === 'localProvider') return t('NVIDIA RTX GPU · 24 GB VRAM');
  return '';
}

/** One-line status for the Info list — the same states the header control
 *  cycles through, spelled out so the dialog reads even without a switch. */
function featureStatus({ ready, installed, enabled, available, action }: FeatureState): string {
  if (!available) return t('Windows only');
  if (!ready) return '';
  if (action?.status === 'installing') return t('Installing…');
  if (action?.status === 'failed') return t('Failed');
  if (!installed) return t('Not installed');
  return enabled ? t('Installed · On') : t('Installed · Off');
}

/** Detail for one built-in feature: the same dialog grammar as plugins —
 *  icon and title on the header line with the install/enable control, the
 *  tagline, then Contents (each bundled skill switching on its own) only when
 *  the feature ships skills, and an Info list in every case. */
function FeatureDetailDialog({ state, disabledSkills, onInstall, onToggle, onSkillToggle, onClose, localActions, api }: {
  api: PanelContext['api'];
  state: FeatureState;
  disabledSkills: ReadonlySet<string>;
  onInstall(): void;
  onToggle(enabled: boolean): void;
  onSkillToggle(name: string, enabled: boolean): void;
  onClose(): void;
  localActions: LocalProviderActions;
}) {
  const { feature, bundledSkills, busy, action } = state;
  const Icon = FEATURE_ICONS[feature.id];
  const title = t(feature.title);
  const requirement = featureRequirement(feature.id);
  const infoFacts: Array<readonly [string, string]> = [
    ['Status', featureStatus(state)],
    ['Platform', feature.platform === 'windows' ? t('Windows only') : t('All platforms')],
    ['Requires', requirement],
  ];
  if (feature.id === 'localProvider') {
    const runtime = record(state.localProvider.runtime);
    infoFacts.push(
      ['Runtime', [
        String(runtime.version || ''),
        fileSize(runtime.downloadBytes),
      ].filter(Boolean).join(' · ')],
      ['GPU', String(record(state.localProvider.gpu).name
        || record(record(state.localProvider.hardware).gpu).name || t('Not detected'))],
      ['Server', state.localProvider.starting ? t('Loading model…')
        : state.localProvider.running ? t('Running') : t('Stopped')],
    );
  }
  return <ExtensionDetailDialog title={title} onClose={onClose}
    icon={<Icon size={16} aria-hidden="true" />}
    dataAttributes={{ 'data-feature-id': feature.id }}
    headerControl={<FeatureControl state={state} onInstall={onInstall} onToggle={onToggle} />}>
    <ExtensionHero tagline={t(feature.description)} />
    {feature.id === 'git' && <GitPanel api={api} />}
    {feature.id === 'computer' && <ComputerAuthorizationPanel api={api} enabled={state.enabled && !busy} />}
    <ErrorNotice errors={[
      action?.status === 'failed' ? action.message : '',
      feature.id === 'localProvider' && !state.localProvider.running ? state.localProvider.lastError : '',
      feature.id === 'localProvider' ? record(state.localProvider.hardware).error : '',
    ]} />
    {feature.id === 'localProvider'
      ? <>
        <LocalProviderModels status={state.localProvider} actions={localActions} />
      </>
      : null}
    {bundledSkills.length > 0 && <ExtensionSection title={t('Skills')} count={bundledSkills.length}>
      <div className="extensions-item-list">
        {bundledSkills.map((skill) => {
          const name = String(skill.name);
          const off = disabledSkills.has(name);
          return <ExtensionItemRow key={name} icon={<Sparkles size={15} aria-hidden="true" />}
            title={name} description={String(skill.description || '').trim()}
            tone={off ? 'off' : 'ok'}
            control={<CompactSwitch label={`${name} · ${t('Enabled')}`} checked={!off}
              disabled={busy} onChange={(next) => onSkillToggle(name, next)} />} />;
        })}
      </div>
    </ExtensionSection>}
    <ExtensionSection title={t('Info')}>
      <ExtensionFacts facts={infoFacts} />
    </ExtensionSection>
  </ExtensionDetailDialog>;
}

export function BuiltInFeaturesPanel({ data, snapshot, pending, run, api, initialFeature = null }: PanelContext & {
  initialFeature?: BuiltInFeatureId | null;
}) {
  const localActions = useLocalProviderActions(run, pending);
  const [settings, setSettings] = useState<DesktopSettings | null>(
    () => desktopSettingsCache.get(api as object) ?? null,
  );
  const [gitStatus, setGitStatus] = useState<DesktopGitCliStatus | null>(null);
  const [officeDependency, setOfficeDependency] = useState<DesktopLibreOfficeStatus | null>(null);
  const [action, setAction] = useState<FeatureAction | null>(null);
  // Optimistic toggle state: the switch flips immediately and rolls back if
  // the round trip fails, instead of sitting still until the daemon answers.
  const [optimistic, setOptimistic] = useState<{ id: BuiltInFeatureId; value: boolean } | null>(null);
  const [voiceInstalled, setVoiceInstalled] = useState(false);
  const [openId, setOpenId] = useState<BuiltInFeatureId | null>(initialFeature);
  const toolModules = record(data.toolModules);
  const localProvider = useLocalProviderStatus(api, toolModules.localProvider,
    openId === 'localProvider' || action?.id === 'localProvider');
  const voice = record(data.voice);
  const progress = voiceProgress(snapshot);
  const windows = navigator.userAgent.includes('Windows');
  // Built-in skills ride their feature's Install and toggle, so the card names
  // them instead of the Skills panel listing them as loose entries.
  const bundledSkills = useMemo<Partial<Record<BuiltInFeatureId, RecordValue[]>>>(() => {
    const byFeature: Partial<Record<BuiltInFeatureId, RecordValue[]>> = {};
    const skills = record(data.skills).skills;
    for (const skill of Array.isArray(skills) ? skills : []) {
      const owner = record(record(skill).owner);
      if (owner.kind !== 'builtin' || typeof owner.feature !== 'string') continue;
      const feature = owner.feature as BuiltInFeatureId;
      (byFeature[feature] ??= []).push(record(skill));
    }
    return byFeature;
  }, [data.skills]);
  const disabledSkills = useMemo(() => new Set((Array.isArray(record(data.disabledSkills).disabled)
    ? record(data.disabledSkills).disabled as unknown[] : []).map(String)), [data.disabledSkills]);
  const setSkillEnabled = (name: string, next: boolean) => {
    const nextSet = new Set(disabledSkills);
    if (next) nextSet.delete(name); else nextSet.add(name);
    void run('setDisabledSkills', [[...nextSet]]);
  };
  useEffect(() => {
    if (voice.installed === true) setVoiceInstalled(true);
  }, [voice.installed]);
  useEffect(() => {
    let live = true;
    void api.readSettings?.().then((next) => {
      desktopSettingsCache.set(api as object, next);
      if (live) setSettings(next);
    }).catch(() => {});
    return () => { live = false; };
  }, [api]);
  useEffect(() => {
    let live = true;
    void api.gitCliStatus?.().then((next) => {
      if (live) setGitStatus(next);
    }).catch(() => {});
    void api.libreOfficeStatus?.().then((next) => {
      if (live) setOfficeDependency(next);
    }).catch(() => {});
    return () => { live = false; };
  }, [api]);

  const installed = useMemo<Record<BuiltInFeatureId, boolean>>(() => ({
    git: gitStatus?.installed === true && record(toolModules.git).installed === true,
    memory: record(toolModules.memory).installed === true,
    browser: settings?.browserInstalled === true,
    computer: settings?.computerInstalled === true,
    office: record(toolModules.office).installed === true,
    localProvider: localProvider.installed === true,
    voice: voiceInstalled || voice.installed === true,
  }), [gitStatus?.installed, settings, toolModules, localProvider, voice.installed, voiceInstalled]);
  const enabled = useMemo<Record<BuiltInFeatureId, boolean>>(() => ({
    git: record(toolModules.git).enabled !== false,
    memory: record(toolModules.memory).enabled !== false,
    browser: settings?.browserControl === true,
    computer: settings?.computerControl === true,
    office: record(toolModules.office).enabled !== false,
    localProvider: localProvider.enabled === true,
    voice: voice.enabled === true && installed.voice,
  }), [installed.voice, settings, toolModules, localProvider, voice.enabled]);

  const updateDesktopSetting = async (
    key: 'browserControl' | 'computerControl' | 'browserInstalled' | 'computerInstalled',
    next: boolean,
  ): Promise<boolean> => {
    if (!api.updateSetting) return false;
    const saved = await api.updateSetting(key, next);
    setSettings(saved);
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
    if (id === 'git' || id === 'office' || id === 'localProvider') {
      const result = record(await run('setBuiltinToolEnabled', [id, next], `built-in-${id}`));
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
    if (id === 'localProvider') return;
    if ((action && action.status !== 'failed') || pending) return;
    setAction({ id, status: 'installing' });
    void (async () => {
      if (id === 'git') {
        const next = await api.installGitCli?.();
        if (!next?.installed) throw new Error(t('Git installation did not complete.'));
        setGitStatus(next);
        if (!(await setEnabled('git', true))) throw new Error(t('Git could not be enabled.'));
      } else if (id === 'voice') {
        const result = record(await run('toggleVoice', [true], `built-in-${id}`));
        if (result.enabled !== true || result.installed !== true) {
          throw new Error(t('Voice transcription installation did not complete.'));
        }
        setVoiceInstalled(true);
        window.dispatchEvent(new Event('mixdog:voice-runtime-changed'));
      } else if (id === 'memory' || id === 'office') {
        // Office leans on LibreOffice for rendering and recalculation, so its
        // Install step brings the dependency in first (winget/brew) — the same
        // guided pattern the Git card uses for system Git.
        if (id === 'office' && officeDependency?.installed !== true && api.installLibreOffice) {
          const dependency = await api.installLibreOffice();
          if (!dependency?.installed) {
            throw new Error(t('LibreOffice installation did not complete.'));
          }
          setOfficeDependency(dependency);
        }
        const result = record(await run('installBuiltinFeature', [id], `built-in-${id}`));
        const entry = record(result[id]);
        if (entry.installed !== true || entry.enabled !== true) {
          throw new Error(t('Installation did not complete.'));
        }
      } else {
        // Browser Use / Computer Use ship bundled: install marks the feature
        // activated, then turns its control on.
        const marker = id === 'browser' ? 'browserInstalled' as const : 'computerInstalled' as const;
        const control = id === 'browser' ? 'browserControl' as const : 'computerControl' as const;
        if (!(await updateDesktopSetting(marker, true)) || !(await updateDesktopSetting(control, true))) {
          throw new Error(t('The setting could not be saved.'));
        }
      }
      setAction(null);
    })().catch((error: unknown) => setAction({ id, status: 'failed', message: reason(error) }));
  };
  const localInstalling = Array.isArray(localProvider.installations)
    && localProvider.installations.some((entry) => ['running', 'cancelling'].includes(String(record(entry).state)));
  const busy = Boolean(pending) || (action !== null && action.status !== 'failed') || localInstalling;
  const stateOf = (feature: BuiltInFeatureDefinition): FeatureState => {
    const available = feature.id === 'localProvider'
      ? windows && localProvider.available !== false
      : feature.platform !== 'windows' || windows;
    // Every entry waits for its own status source before painting a control,
    // so an Install pill never flashes into a toggle (or back).
    const ready = feature.id === 'git'
      ? gitStatus !== null && sectionLoaded(data, 'toolModules')
      : feature.id === 'browser' || feature.id === 'computer' ? settings !== null
      : feature.id === 'voice' ? sectionLoaded(data, 'voice')
      : sectionLoaded(data, 'toolModules');
    return {
      feature,
      bundledSkills: bundledSkills[feature.id] || [],
      installed: installed[feature.id],
      enabled: optimistic?.id === feature.id ? optimistic.value : enabled[feature.id],
      ready,
      available,
      busy,
      action: action?.id === feature.id ? action : null,
      progressPercent: feature.id === 'localProvider'
        ? installationPercent(localProviderInstallation(localProvider, 'runtime'))
        : feature.id === 'voice' || feature.id === 'memory' ? progress.percent : null,
      localProvider,
    };
  };
  const open = openId ? BUILT_IN_FEATURES.find((feature) => feature.id === openId) : undefined;
  return <Group title="Built-in">
    {BUILT_IN_FEATURES.map((feature) => {
      const state = stateOf(feature);
      const Icon = FEATURE_ICONS[feature.id];
      return <ExtensionRow key={feature.id} icon={<Icon size={16} aria-hidden="true" />}
        title={t(feature.title)} description={t(feature.description)}
        badge={featureBadge(state)}
        enabled={state.installed && state.enabled}
        busy={false} onOpen={() => setOpenId(feature.id)}
        dataAttributes={{ 'data-built-in-feature': feature.id }} />;
    })}
    {open && <FeatureDetailDialog key={open.id} state={stateOf(open)}
      api={api}
      localActions={localActions}
      disabledSkills={disabledSkills}
      onInstall={() => install(open.id)}
      onToggle={(next) => toggle(open.id, next)}
      onSkillToggle={setSkillEnabled}
      onClose={() => setOpenId(null)} />}
  </Group>;
}
