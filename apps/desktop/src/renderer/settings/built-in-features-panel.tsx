import {
  Brain,
  FileSpreadsheet,
  GitBranch,
  Globe2,
  Mic,
  Monitor,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type {
  DesktopGitCliStatus,
  DesktopLibreOfficeStatus,
  DesktopSettings,
} from '../../shared/contract';
import { t } from '../i18n';
import { record } from '../record-utils';
import { CompactSwitch, Group } from './capability-controls';
import { sectionLoaded, type PanelContext } from './capability-data';
import {
  BUILT_IN_FEATURES,
  type BuiltInFeatureDefinition,
  type BuiltInFeatureId,
} from './built-in-feature-registry';

const FEATURE_ICONS: Readonly<Record<BuiltInFeatureId, LucideIcon>> = {
  git: GitBranch,
  memory: Brain,
  browser: Globe2,
  computer: Monitor,
  office: FileSpreadsheet,
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

// Install progress lives IN the control slot, where the toggle will appear
// once the install lands — the card never grows a second progress band.
function SlotProgress({ percent, label }: { percent: number | null; label: string }) {
  return <span className="built-in-feature-slot-progress" role="progressbar"
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}
    aria-valuetext={label}>
    {percent !== null && <small aria-hidden="true">{percent}%</small>}
    <span className={`built-in-feature-progress-bar${percent === null ? ' is-indeterminate' : ''}`}>
      <span style={percent === null ? undefined : { width: `${percent}%` }} />
    </span>
  </span>;
}

function FeatureCard({
  feature,
  bundledSkills,
  installed,
  enabled,
  ready,
  available,
  busy,
  action,
  progressPercent,
  onInstall,
  onToggle,
}: {
  feature: BuiltInFeatureDefinition;
  /** Names of the built-in skills that install and toggle with this feature. */
  bundledSkills: string[];
  installed: boolean;
  enabled: boolean;
  ready: boolean;
  available: boolean;
  /** Any card's action (or a panel-wide pending) blocks every control, so the
   *  visible state always matches the panel's single-action guard. */
  busy: boolean;
  action: FeatureAction | null;
  progressPercent: number | null;
  onInstall(): void;
  onToggle(enabled: boolean): void;
}) {
  const Icon = FEATURE_ICONS[feature.id];
  const installing = action?.status === 'installing';
  const failed = action?.status === 'failed';
  return <article className="built-in-feature-card" data-feature-id={feature.id}
    aria-busy={installing || action?.status === 'toggling' || undefined}>
    <header>
      <span className="built-in-feature-title">
        <Icon className="built-in-feature-title-icon" size={14} aria-hidden="true" />
        <b>{t(feature.title)}</b>
      </span>
      <span className="built-in-feature-control">
        {!ready
          ? <span className="built-in-feature-control-placeholder" aria-hidden="true" />
          : installing
          ? <SlotProgress percent={progressPercent} label={t('Installing {{name}}…', { name: t(feature.title) })} />
          : !installed
          ? <button type="button" disabled={!available || busy}
              aria-label={t('Install {{name}}', { name: t(feature.title) })} onClick={onInstall}>
              {t(failed ? 'Retry' : 'Install')}
            </button>
          : <CompactSwitch label={t(feature.title)} checked={enabled} optimistic={false}
              disabled={!available || busy} onChange={onToggle} />}
      </span>
      <small className="built-in-feature-description">
        {t(feature.description)}
        {bundledSkills.length > 0 && <> {t('Includes skills: {{names}}', { names: bundledSkills.join(', ') })}</>}
      </small>
    </header>
    {failed && action?.message
      ? <div className="built-in-feature-error" role="alert">{action.message}</div>
      : null}
  </article>;
}

export function BuiltInFeaturesPanel({ data, snapshot, pending, run, api }: PanelContext) {
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
  const toolModules = record(data.toolModules);
  const voice = record(data.voice);
  const progress = voiceProgress(snapshot);
  const windows = navigator.userAgent.includes('Windows');
  // Built-in skills ride their feature's Install and toggle, so the card names
  // them instead of the Skills panel listing them as loose entries.
  const bundledSkills = useMemo<Partial<Record<BuiltInFeatureId, string[]>>>(() => {
    const byFeature: Partial<Record<BuiltInFeatureId, string[]>> = {};
    const skills = record(data.skills).skills;
    for (const skill of Array.isArray(skills) ? skills : []) {
      const owner = record(record(skill).owner);
      if (owner.kind !== 'builtin' || typeof owner.feature !== 'string') continue;
      const feature = owner.feature as BuiltInFeatureId;
      (byFeature[feature] ??= []).push(String(record(skill).name));
    }
    return byFeature;
  }, [data.skills]);

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
    voice: voiceInstalled || voice.installed === true,
  }), [gitStatus?.installed, settings, toolModules, voice.installed, voiceInstalled]);
  const enabled = useMemo<Record<BuiltInFeatureId, boolean>>(() => ({
    git: record(toolModules.git).enabled !== false,
    memory: record(toolModules.memory).enabled !== false,
    browser: settings?.browserControl === true,
    computer: settings?.computerControl === true,
    office: record(toolModules.office).enabled !== false,
    voice: voice.enabled === true && installed.voice,
  }), [installed.voice, settings, toolModules, voice.enabled]);

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
    if (id === 'git' || id === 'office') {
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

  const busy = Boolean(pending) || (action !== null && action.status !== 'failed');
  return <Group title="Built-in">
    <div className="built-in-feature-list">
      {BUILT_IN_FEATURES.map((feature) => {
        const available = feature.platform !== 'windows' || windows;
        // Every card waits for its own status source before painting a
        // control, so an Install pill never flashes into a toggle (or back).
        const ready = feature.id === 'git'
          ? gitStatus !== null && sectionLoaded(data, 'toolModules')
          : feature.id === 'browser' || feature.id === 'computer' ? settings !== null
          : feature.id === 'voice' ? sectionLoaded(data, 'voice')
          : sectionLoaded(data, 'toolModules');
        return <FeatureCard key={feature.id} feature={feature}
          bundledSkills={bundledSkills[feature.id] || []}
          installed={installed[feature.id]}
          enabled={optimistic?.id === feature.id ? optimistic.value : enabled[feature.id]}
          ready={ready} available={available} busy={busy}
          action={action?.id === feature.id ? action : null}
          progressPercent={feature.id === 'voice' || feature.id === 'memory' ? progress.percent : null}
          onInstall={() => install(feature.id)}
          onToggle={(next) => toggle(feature.id, next)} />;
      })}
    </div>
  </Group>;
}
