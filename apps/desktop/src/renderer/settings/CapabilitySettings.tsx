import React, { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  Box,
  Brain,
  ChevronRight,
  Check,
  Cloud,
  Plug,
  Search,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';

import type {
  DesktopApi,
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopReadCapability,
  DesktopModelOption,
  DesktopModelSelection,
  EngineSnapshot,
} from '../../shared/contract';
import type { SettingsSection } from './SettingsView';
import { SETTINGS_CATEGORIES, SETTINGS_ITEMS, type SettingsCategory } from './settings-items';
import { applyDesktopTheme } from '../desktop-theme';
import { OpenSelect } from '../OpenSelect';
import { modelDisplayName, modelOptionLabel, normalizeModelOptions, providerDisplayName } from '../provider-display';

type RecordValue = Record<string, unknown>;
type CapabilityApi = Partial<Pick<DesktopApi,
  'invokeCapability' | 'readCapabilities' | 'listProviderModels' | 'setModelRoute' | 'setFast' | 'getSnapshot'
  | 'subscribeState' | 'getZoomFactor' | 'setZoomFactor' | 'onZoomFactorChanged'>>;

interface CapabilitySettingsProps {
  api: CapabilityApi;
  category: SettingsCategory;
  section: SettingsSection | null;
  onOpen(section: SettingsSection): void;
  onCompose?: (text: string) => void;
}

interface PanelContext {
  data: Record<string, unknown>;
  snapshot: EngineSnapshot;
  pending: string;
  run<T = unknown>(capability: DesktopCapability, args?: unknown[], key?: string, refresh?: boolean): Promise<T | undefined>;
  route(model: DesktopModelOption): Promise<void>;
  setFast(enabled: boolean): Promise<void>;
  confirm(options: SettingsConfirmation): void;
  notice(message: string, tone?: 'info' | 'warn'): void;
  compose?: (text: string) => void;
}

interface SettingsConfirmation {
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm(): void | Promise<void>;
}

const SECTION_READS: ReadonlyArray<readonly [string, DesktopCapability, unknown[]?]> = [
  ['profile', 'getProfile'], ['autoClear', 'getAutoClear'], ['compaction', 'getCompactionSettings'],
  ['memory', 'getMemorySettings'], ['channels', 'getChannelSettings', [{ includeStatus: false }]],
  ['remote', 'isRemoteEnabled'], ['channelWorker', 'getChannelWorkerStatus'], ['channelSetup', 'getChannelSetup'],
  ['workflows', 'listWorkflows'], ['outputStyles', 'listOutputStyles'], ['themes', 'listThemes'], ['theme', 'getTheme'],
  ['searchRoute', 'getSearchRoute'], ['searchModels', 'listSearchModels', [{ quick: false }]],
  ['providerSetup', 'getProviderSetup'], ['mcp', 'mcpStatus'], ['plugins', 'pluginsStatus'],
  ['hooks', 'hooksStatus'], ['skills', 'skillsStatus'], ['disabledSkills', 'getDisabledSkills'],
  ['agents', 'listAgents'],
  ['update', 'getUpdateSettings'], ['updateStatus', 'getUpdateStatus'],
];

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function rows(value: unknown, ...keys: string[]): RecordValue[] {
  if (Array.isArray(value)) return value.map(record);
  const source = record(value);
  for (const key of keys) {
    if (Array.isArray(source[key])) return (source[key] as unknown[]).map(record);
  }
  return [];
}

function bool(value: unknown, fallback = true): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function label(value: unknown, fallback = 'Unknown'): string {
  const item = record(value);
  return String(item.label || item.title || item.name || item.display || item.id || fallback);
}

function providerLabel(value: unknown, fallback = 'Unknown provider'): string {
  const item = record(value);
  if (item.name || item.label) return String(item.name || item.label);
  const provider = String(item.id || item.provider || '');
  return provider ? providerDisplayName(provider) : label(item, fallback);
}

function count(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Intl.NumberFormat().format(numeric) : String(value ?? '—');
}

function formatDuration(value: unknown): string {
  if (!Number.isFinite(Number(value))) return '';
  const milliseconds = Math.max(0, Number(value) || 0);
  if (milliseconds < 60_000) {
    if (milliseconds < 1_000) return '';
    return `${Math.floor(milliseconds / 1_000)}s`;
  }
  const days = Math.floor(milliseconds / 86_400_000);
  const hours = Math.floor((milliseconds % 86_400_000) / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function durationTextInput(value: unknown): string {
  const milliseconds = Math.max(0, Math.round(Number(value) || 0));
  if (milliseconds > 0 && milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000}h`;
  if (milliseconds > 0 && milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  if (milliseconds > 0 && milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
}

export function CapabilitySettings({ api, category, section, onOpen, onCompose }: CapabilitySettingsProps) {
  const [data, setData] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ message: string; tone: 'info' | 'warn' } | null>(null);
  const [confirmation, setConfirmation] = useState<SettingsConfirmation | null>(null);
  const [liveSnapshot, setLiveSnapshot] = useState<EngineSnapshot>(null);
  const [revision, setRevision] = useState(0);
  const loadSequence = useRef(0);
  const updateChecked = useRef(false);

  const load = useCallback(async (force = false) => {
    const sequence = ++loadSequence.current;
    if (!api.invokeCapability && !api.readCapabilities) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    const next: Record<string, unknown> = {};
    let loadError = '';
    const prepared = SECTION_READS.map(([key, capability, args = []]) => ({
      key,
      request: {
        capability: capability as DesktopReadCapability,
        args: force && capability === 'listSearchModels'
          ? [{ ...record(args[0]), force: true }]
          : force && capability === 'getUsageDashboard'
            ? [{ ...record(args[0]), refresh: true }]
            : [...args],
      } satisfies DesktopCapabilityReadRequest,
    }));
    const loadReads = async () => {
      if (api.readCapabilities) {
        const results = await api.readCapabilities(prepared.map((entry) => entry.request));
        prepared.forEach((entry, index) => {
          const result = results[index];
          next[entry.key] = result?.ok
            ? result.value
            : { error: result && 'error' in result ? result.error : 'Capability read did not return a result.' };
        });
        return;
      }
      await Promise.all(prepared.map(async ({ key, request }) => {
        try {
          next[key] = (await api.invokeCapability!({ capability: request.capability, args: request.args }))?.value;
        } catch (reason) {
          next[key] = { error: reason instanceof Error ? reason.message : String(reason) };
        }
      }));
    };
    const modelSection = category === 'models' || section === 'model' || section === 'search';
    await Promise.all([
      loadReads(),
      modelSection ? (async () => {
        try { next.models = await api.listProviderModels?.({ quick: false, ...(force ? { force: true } : {}) }) || []; } catch (reason) {
          next.models = [];
          loadError = reason instanceof Error ? reason.message : String(reason);
        }
      })() : Promise.resolve(),
      modelSection ? api.getSnapshot?.().then((snapshot) => { next.snapshot = snapshot || null; })
        .catch(() => { next.snapshot = null; }) : Promise.resolve(),
    ]);
    if (sequence !== loadSequence.current) return;
    setData(next);
    setError(loadError);
    setLoading(false);
  }, [api, category, section]);

  useEffect(() => {
    void load();
    return () => { loadSequence.current += 1; };
  }, [load, revision]);
  useEffect(() => {
    let live = true;
    void api.getSnapshot?.().then((snapshot) => { if (live) setLiveSnapshot(snapshot); }).catch(() => {});
    const unsubscribe = api.subscribeState?.((snapshot) => { if (live) setLiveSnapshot(snapshot); });
    return () => { live = false; unsubscribe?.(); };
  }, [api]);

  const run = useCallback(async <T,>(
    capability: DesktopCapability,
    args: unknown[] = [],
    key: string = capability,
    refresh = true,
  ): Promise<T | undefined> => {
    if (!api.invokeCapability || pending) return undefined;
    setPending(key);
    setError('');
    try {
      const result = await api.invokeCapability<T>({ capability, args });
      if (refresh) setRevision((value) => value + 1);
      return result.value;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      setPending('');
    }
  }, [api, pending]);

  useEffect(() => {
    if (section !== 'update') {
      updateChecked.current = false;
      return;
    }
    if (loading || updateChecked.current) return;
    updateChecked.current = true;
    void run('checkForUpdate', [{}]);
  }, [loading, run, section]);

  const route = useCallback(async (model: DesktopModelOption) => {
    if (!api.setModelRoute || pending) return;
    setPending('model-route');
    setError('');
    try {
      const active = record(liveSnapshot);
      const isActiveRoute = active.provider === model.provider && active.model === model.model;
      const activeEffort = String(active.effort || '');
      const effort = isActiveRoute && model.effortOptions.some((entry) => entry.value === activeEffort)
        ? activeEffort
        : preferredEffort(model);
      const fast = model.fastCapable
        ? (isActiveRoute && typeof active.fast === 'boolean'
          ? active.fast === true
          : (typeof model.savedFast === 'boolean' ? model.savedFast : model.fastPreferred))
        : undefined;
      await api.setModelRoute({
        provider: model.provider,
        model: model.model,
        ...(effort ? { effort } : {}),
        ...(fast === undefined ? {} : { fast }),
      });
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setPending(''); }
  }, [api, liveSnapshot, pending]);

  const setFast = useCallback(async (enabled: boolean) => {
    if (!api.setFast || pending) return;
    setPending('fast');
    setError('');
    try {
      await api.setFast(enabled);
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setPending(''); }
  }, [api, pending]);

  const confirm = useCallback((options: SettingsConfirmation) => setConfirmation(options), []);
  const pushNotice = useCallback((message: string, tone: 'info' | 'warn' = 'info') => {
    setNotice({ message, tone });
  }, []);

  const context = useMemo<PanelContext>(() => ({
    data, snapshot: liveSnapshot, pending, run, route, setFast, confirm, notice: pushNotice, compose: onCompose,
  }), [confirm, data, liveSnapshot, onCompose, pending, pushNotice, route, run, setFast]);

  return <>
    {loading ? <p className="settings-loading" role="status">Loading settings…</p>
      : section ? renderSection(section, context) : <CategoryPanel api={api} category={category}
        context={context} onOpen={onOpen} />}
    {error && <p className="mixdog-settings__error" role="alert">{error}</p>}
    {notice && <p className={`settings-notice settings-notice--${notice.tone}`}
      role={notice.tone === 'warn' ? 'alert' : 'status'}>{notice.message}</p>}
    {confirmation && <SettingsConfirmDialog options={confirmation} onClose={() => setConfirmation(null)} />}
  </>;
}

function renderSection(section: SettingsSection, context: PanelContext): ReactNode {
  if (section === 'profile') return <ProfilePanel {...context} />;
  if (section === 'autoclear') return <AutoClearPanel {...context} />;
  if (section === 'channel-setting') return <ChannelSettingPanel {...context} />;
  if (section === 'output-style') return <OutputStylePanel {...context} />;
  if (section === 'theme') return <ThemePanel {...context} />;
  if (section === 'workflow') return <WorkflowPanel {...context} />;
  if (section === 'model') return <MainModelPanel {...context} />;
  if (section === 'search') return <SearchPanel {...context} />;
  if (section === 'providers') return <ProvidersPanel {...context} />;
  if (section === 'mcp') return <McpPanel {...context} />;
  if (section === 'skills') return <SkillsPanel {...context} />;
  if (section === 'plugins') return <PluginsPanel {...context} />;
  if (section === 'hooks') return <HooksPanel {...context} />;
  if (section === 'update') return <UpdatePanel {...context} />;
  return null;
}

function Group({ title, description, children }: { title?: string; description?: string; children: ReactNode }) {
  return <section className="settings-group">{(title || description) &&
    <header>{title && <h3>{title}</h3>}{description && <p>{description}</p>}</header>}
    <div className="settings-group-body">{children}</div></section>;
}

function ToggleRow({ title, description, checked, disabled, onChange }: {
  title: string; description: string; checked: boolean; disabled?: boolean; onChange(value: boolean): void;
}) {
  return <div className="mixdog-settings__row"><div className="mixdog-settings__copy">
    <span className="mixdog-settings__row-title">{title}</span><span className="mixdog-settings__description">{description}</span>
  </div><label className="mixdog-settings__switch"><input type="checkbox" aria-label={title} checked={checked}
    disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} /><span aria-hidden="true" /></label></div>;
}

function SelectRow({ title, description, value, disabled, options, onChange }: {
  title: string; description: string; value: string; disabled?: boolean;
  options: Array<{ value: string; label: string }>; onChange(value: string): void;
}) {
  const normalized = options.some((entry) => entry.value === value)
    ? options
    : [{ value, label: value || 'Select…' }, ...options];
  return <div className="mixdog-settings__row"><div className="mixdog-settings__copy">
    <span className="mixdog-settings__row-title">{title}</span><span className="mixdog-settings__description">{description}</span>
  </div><OpenSelect className="settings-select" ariaLabel={title} value={value} disabled={disabled}
    options={normalized} onChange={onChange} /></div>;
}

function routeOption(value: RecordValue): DesktopModelOption {
  const model = String(value.id || value.model || '');
  const effortOptions = rows(value.effortOptions).flatMap((entry) => {
    const optionValue = String(entry.value || '');
    if (!optionValue) return [];
    return [{ value: optionValue, label: String(entry.label || optionValue) }];
  });
  const savedEffort = String(value.savedEffort || '');
  const savedFast = typeof value.savedFast === 'boolean' ? value.savedFast : undefined;
  const fastCapable = value.fastCapable === true;
  return {
    provider: String(value.provider || ''),
    model,
    display: String(value.display || value.name || model),
    effortOptions,
    fastCapable,
    fastPreferred: fastCapable && (value.fastPreferred === true || savedFast === true),
    ...(savedEffort ? { savedEffort } : {}),
    ...(savedFast === undefined ? {} : { savedFast }),
  };
}

function preferredEffort(model: DesktopModelOption | undefined): string | undefined {
  if (!model?.effortOptions.length) return undefined;
  if (model.savedEffort && model.effortOptions.some((entry) => entry.value === model.savedEffort)) {
    return model.savedEffort;
  }
  for (const value of ['high', 'medium', 'low', 'none', 'xhigh', 'max', 'ultra']) {
    if (model.effortOptions.some((entry) => entry.value === value)) return value;
  }
  return model.effortOptions[0]?.value;
}

function routeOptionLabel(model: DesktopModelOption): string {
  return model.provider === 'default' && model.model === 'default'
    ? 'Default · follows Main'
    : modelOptionLabel(model);
}

function RouteEditor({ title, description, route, models, disabled, compact = false, onChange }: {
  title: string;
  description?: string;
  route: RecordValue;
  models: DesktopModelOption[];
  disabled?: boolean;
  compact?: boolean;
  onChange(selection: DesktopModelSelection): void;
}) {
  const currentKey = `${route.provider || ''}:${route.model || ''}`;
  const selected = models.find((entry) => `${entry.provider}:${entry.model}` === currentKey);
  const effort = selected?.effortOptions.some((entry) => entry.value === route.effort)
    ? String(route.effort)
    : preferredEffort(selected);
  const fast = selected?.fastCapable
    ? (typeof route.fast === 'boolean' ? route.fast === true : selected.fastPreferred)
    : false;
  const selectionFor = (model: DesktopModelOption, patch: Partial<DesktopModelSelection> = {}): DesktopModelSelection => {
    const nextEffort = patch.effort ?? (model === selected ? effort : preferredEffort(model));
    const nextFast = patch.fast ?? (model === selected ? fast : model.fastPreferred);
    return {
      provider: model.provider,
      model: model.model,
      ...(nextEffort ? { effort: nextEffort } : {}),
      ...(model.fastCapable ? { fast: nextFast === true } : {}),
    };
  };
  return <div className={`settings-route-editor ${compact ? 'compact' : ''}`}>
    {!compact && <div><b>{title}</b>{description && <small>{description}</small>}</div>}
    <div className="settings-route-controls">
      <OpenSelect className="settings-select" ariaLabel={title} value={currentKey} disabled={disabled}
        options={[
          ...(!selected ? [{ value: currentKey, label: route.model
            ? `${modelDisplayName(String(route.model), String(route.provider || ''))} · ${providerDisplayName(String(route.provider || ''))}` : 'Select model…' }] : []),
          ...models.map((model) => ({ value: `${model.provider}:${model.model}`, label: routeOptionLabel(model) })),
        ]}
        onChange={(value) => {
          const model = models.find((entry) => `${entry.provider}:${entry.model}` === value);
          if (model) onChange(selectionFor(model));
        }} />
      {selected && selected.effortOptions.length > 0 && <OpenSelect className="settings-select settings-select--effort"
        ariaLabel={`${title} effort`} value={effort} disabled={disabled} options={selected.effortOptions}
        onChange={(value) => onChange(selectionFor(selected, { effort: value }))} />}
      {selected?.fastCapable && <label className="settings-route-fast"><input type="checkbox" checked={fast}
        disabled={disabled} onChange={(event) => onChange(selectionFor(selected, { fast: event.currentTarget.checked }))} /> Fast</label>}
    </div>
  </div>;
}

function FormRow({ title, description, children, resetOnSubmit = false, onSubmit }: {
  title: string; description?: string; children: ReactNode; resetOnSubmit?: boolean; onSubmit(data: FormData): void;
}) {
  return <form className="settings-form-row" onSubmit={(event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    onSubmit(new FormData(form));
    if (resetOnSubmit) form.reset();
  }}><div><b>{title}</b>{description && <small>{description}</small>}</div><div className="settings-form-controls">{children}</div></form>;
}

function ActionButton({ children, danger, disabled, onClick }: {
  children: ReactNode; danger?: boolean; disabled?: boolean; onClick(): void;
}) {
  return <button type="button" className={`settings-action ${danger ? 'danger' : ''}`} disabled={disabled} onClick={onClick}>{children}</button>;
}

function SettingsConfirmDialog({ options, onClose }: { options: SettingsConfirmation; onClose(): void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  const accept = () => {
    onClose();
    void options.onConfirm();
  };
  return <div className="settings-confirm-layer" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="settings-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="settings-confirm-title"
      aria-describedby="settings-confirm-description" data-settings-nested-dialog>
      <header><h3 id="settings-confirm-title">{options.title}</h3>
        <button type="button" aria-label="Close confirmation" onClick={onClose}><X aria-hidden="true" size={15} /></button></header>
      <p id="settings-confirm-description">{options.description}</p>
      <footer><button ref={cancelRef} type="button" onClick={onClose}>Cancel</button>
        <button type="button" className={options.danger ? 'danger' : 'primary'} onClick={accept}>
          {options.confirmLabel || 'Continue'}
        </button></footer>
    </section>
  </div>;
}

function ResourceRow({ title, description, meta, actions }: {
  title: string; description?: string; meta?: string; actions?: ReactNode;
}) {
  return <div className="settings-resource"><div><b>{title}</b>{description && <p>{description}</p>}</div>
    {meta && <span className="settings-meta">{meta}</span>}{actions && <div className="settings-resource-actions">{actions}</div>}</div>;
}

function MetricGrid({ items }: { items: Array<{ label: string; value: unknown; tone?: string }> }) {
  const visible = items.filter((item) => item.value !== undefined && item.value !== null && item.value !== '');
  return visible.length ? <div className="settings-metric-grid">{visible.map((item) => <div key={item.label}
    className={item.tone ? `tone-${item.tone}` : ''}><span>{item.label}</span><b>{String(item.value)}</b></div>)}</div>
    : <Empty text="No status data available." />;
}

function ContextStatusView({ value }: { value: unknown }) {
  const context = record(value);
  const messages = record(context.messages);
  const request = record(context.request);
  const usage = record(context.usage);
  if (context.error) return <Empty text={String(context.error)} />;
  const used = Number(context.usedTokens || context.currentEstimatedTokens || 0);
  const window = Number(context.contextWindow || 0);
  const percent = window > 0 ? Math.min(100, Math.max(0, Math.round((used / window) * 100))) : 0;
  return <div className="settings-status-stack">
    <ResourceRow title={`${context.model
      ? modelDisplayName(String(context.model), String(context.provider || ''))
      : 'No model'} · ${context.provider ? providerDisplayName(String(context.provider)) : 'No provider'}`}
      description={String(context.cwd || 'No active project')} meta={String(context.toolMode || 'default tools')} />
    {window > 0 && <div className="settings-context-meter" aria-label={`Context ${percent}% used`}>
      <span style={{ width: `${percent}%` }} /><small>{count(used)} / {count(window)} tokens · {percent}%</small></div>}
    <MetricGrid items={[
      { label: 'Free tokens', value: count(context.freeTokens) },
      { label: 'Messages', value: count(messages.total ?? messages.count) },
      { label: 'Tool schema', value: `${count(request.toolSchemaTokens)} tokens` },
      { label: 'Request reserve', value: `${count(request.reserveTokens)} tokens` },
      { label: 'Last input', value: `${count(usage.lastInputTokens)} tokens` },
      { label: 'Last output', value: `${count(usage.lastOutputTokens)} tokens` },
    ]} />
  </div>;
}

function UsageDashboard({ value }: { value: unknown }) {
  const dashboard = record(value);
  const total = record(dashboard.total);
  const providers = rows(dashboard, 'rows');
  if (dashboard.error) return <Empty text={String(dashboard.error)} />;
  return <div className="settings-status-stack">
    <MetricGrid items={[
      { label: 'Providers', value: count(total.providerCount ?? providers.length) },
      { label: 'Known remaining', value: `$${Number(total.knownRemainingUsd || 0).toFixed(2)}` },
      { label: 'Not configured', value: count(total.notConfiguredCount) },
      { label: 'Errors', value: count(total.errorCount), tone: Number(total.errorCount) > 0 ? 'danger' : 'good' },
    ]} />
    {providers.length ? <div>{providers.map((provider, index) => <ResourceRow
      key={String(provider.id || provider.provider || index)} title={providerLabel(provider, `Provider ${index + 1}`)}
      description={String(provider.detail || provider.sourceLabel || '')}
      meta={String(provider.primary || provider.status || 'unknown')} />)}</div> : <Empty text="No provider usage rows." />}
  </div>;
}

function SettingsList({ category, context, onOpen }: {
  category: SettingsCategory;
  context: PanelContext;
  onOpen(section: SettingsSection): void;
}) {
  const { data, snapshot, pending, run, notice } = context;
  const profile = record(data.profile);
  const autoClear = record(data.autoClear);
  const compaction = record(data.compaction);
  const channels = record(data.channels);
  const worker = record(data.channelWorker);
  const setup = record(data.channelSetup);
  const output = record(data.outputStyles);
  const currentStyle = record(output.current);
  const workflows = rows(data.workflows);
  const currentWorkflow = workflows.find((entry) => entry.active);
  const themes = rows(data.themes);
  const currentTheme = themes.find((entry) => entry.id === data.theme);
  const mcp = record(data.mcp);
  const plugins = record(data.plugins);
  const hooks = record(data.hooks);
  const skills = record(data.skills);
  const update = record(data.update);
  const language = rows(profile.languages).find((entry) => entry.id === profile.language);
  const busy = Boolean(pending);
  const metaFor = (value: string): string => {
    if (value === 'profile') return profile.title
      ? `${profile.title} · ${label(language, 'System')}` : label(language, 'System');
    if (value === 'autoclear') return autoClear.enabled !== false ? `On (${formatDuration(autoClear.idleMs)})` : 'Off';
    if (value === 'autocompact') return compaction.auto !== false ? 'On' : 'Off';
    if (value === 'compact-type') return 'Fast-track (fixed)';
    if (value === 'channels') return channels.enabled !== false ? 'On' : 'Off';
    if (value === 'remote-runtime') return data.remote === true ? 'On' : 'Off';
    if (value === 'channel-backend') return setup.backend === 'telegram' ? 'Telegram' : 'Discord';
    if (value === 'output-style') return String(currentStyle.label || currentStyle.id || output.configured || 'Default');
    if (value === 'theme') return label(currentTheme, String(data.theme || 'Default'));
    if (value === 'workflow') return label(currentWorkflow, 'Default');
    if (value === 'model') return snapshot && record(snapshot).model
      ? modelDisplayName(String(record(snapshot).model), String(record(snapshot).provider || '')) : 'Default';
    if (value === 'search') {
      const route = record(data.searchRoute);
      return route.model ? modelDisplayName(String(route.model), String(route.provider || '')) : 'Default';
    }
    if (value === 'update') {
      const current = String(update.currentVersion || 'unknown');
      return update.updateAvailable && update.latestVersion ? `${current} → ${update.latestVersion}`
        : update.currentVersion ? `${current} (latest)` : 'unknown';
    }
    return '';
  };
  const descriptionFor = (value: string, fallback: string): string => {
    if (value === 'autoclear') return autoClear.enabled !== false
      ? `Clear idle sessions after ${formatDuration(autoClear.idleMs)}${autoClear.custom ? '' : ` (${autoClear.provider || 'default'} default)`}. Enter for options.`
      : 'Idle auto-clear disabled. Enter for options.';
    if (value === 'compact-type') return record(data.memory).enabled === false
      ? 'Injects raw transcript lines (memory off: no LLM chunking).'
      : 'Uses Memory recall to rebuild context faster on large histories.';
    if (value === 'channels') return channels.enabled === false ? 'Channel tools disabled.' : 'Discord, schedules, and webhooks.';
    if (value === 'remote-runtime') return worker.running ? `runtime running · pid ${worker.pid}` : 'runtime stopped';
    if (value === 'mcp') return `${mcp.connectedCount || 0}/${mcp.configuredCount || 0} connected${mcp.failedCount ? ` · ${mcp.failedCount} failed` : ''}`;
    if (value === 'plugins') return `${plugins.count || rows(plugins, 'plugins').length} detected`;
    if (value === 'hooks') return `${hooks.ruleCount || 0} before-tool rules`;
    if (value === 'skills') return `${skills.count || rows(skills, 'skills').length} available`;
    return fallback;
  };
  const categoryItems = SETTINGS_CATEGORIES.find((entry) => entry.value === category)?.items || [];
  return <section className="mixdog-settings__picker-list" aria-label={`${category} settings`}>
    {SETTINGS_ITEMS.filter((item) => (categoryItems as readonly string[]).includes(item.value)).map((item) => {
      const description = descriptionFor(item.value, item.description);
      const copy = <span className="mixdog-settings__picker-copy">
        <span className="mixdog-settings__row-title">{item.label}</span>
        <span className="mixdog-settings__description">{description}</span>
      </span>;
      if (item.kind === 'toggle') {
        const checked = item.value === 'autoclear' ? autoClear.enabled !== false
          : item.value === 'autocompact' ? compaction.auto !== false
            : item.value === 'channels' ? channels.enabled !== false : data.remote === true;
        const toggle = async (enabled: boolean) => {
          if (item.value === 'autoclear') {
            const next = await run<RecordValue>('setAutoClear', [{ enabled }]);
            notice(next ? (next.enabled !== false ? `Auto-clear on · idle ${formatDuration(next.idleMs)}` : 'Auto-clear off')
              : 'autoclear unavailable', next ? 'info' : 'warn');
          } else if (item.value === 'autocompact') {
            const next = await run<RecordValue>('setCompactionSettings', [{ auto: enabled }]);
            notice(next
              ? `Compaction ${next.auto !== false ? 'auto on' : 'auto off'} · ${next.compactType === 'recall-fasttrack' ? 'Fast-track' : 'Default'}`
              : 'compaction setting is busy', next ? 'info' : 'warn');
          } else if (item.value === 'channels') {
            const next = await run<RecordValue>('setChannelsEnabled', [enabled]);
            notice(next ? `Channels ${next.enabled !== false ? 'on' : 'off'}` : 'channel setting is busy', next ? 'info' : 'warn');
          } else {
            const next = await run<boolean>('toggleRemote');
            notice(next === true ? 'Remote mode ON' : 'Remote mode OFF');
          }
        };
        return <div className="mixdog-settings__picker-row" key={item.value}>
          {item.value === 'autoclear'
            ? <button type="button" className="mixdog-settings__picker-open" onClick={() => onOpen(item.value)}>{copy}</button>
            : copy}
          <span className="mixdog-settings__picker-meta">{metaFor(item.value)}</span>
          <label className="mixdog-settings__switch"><input type="checkbox" aria-label={item.label} checked={checked}
            disabled={busy} onChange={(event) => toggle(event.currentTarget.checked)} /><span aria-hidden="true" /></label>
          {item.value === 'autoclear' && <button type="button" className="mixdog-settings__chevron"
            aria-label="Open Auto-clear options" onClick={() => onOpen(item.value)}><ChevronRight size={16} /></button>}
        </div>;
      }
      if (item.kind === 'cycle') return <div className="mixdog-settings__picker-row" key={item.value}>
        {copy}<OpenSelect className="settings-select settings-select--cycle" ariaLabel={item.label}
          value={String(setup.backend || 'discord')} disabled={busy}
          options={[{ value: 'discord', label: 'Discord' }, { value: 'telegram', label: 'Telegram' }]}
          onChange={(value) => {
            void run('setBackend', [value]).then((result) => {
              if (result === undefined) return;
              const channelLabel = value === 'telegram' ? 'Telegram' : 'Discord';
              notice(data.remote === true || worker.running
                ? `Channel set to ${channelLabel}. Restart remote to apply.`
                : `Channel set to ${channelLabel}.`);
            });
          }} />
      </div>;
      if (item.kind === 'static') return <div className="mixdog-settings__picker-row" key={item.value}>
        {copy}<span className="mixdog-settings__picker-meta">{metaFor(item.value)}</span>
      </div>;
      return <button type="button" className="mixdog-settings__picker-row mixdog-settings__picker-open-row"
        key={item.value} onClick={() => onOpen(item.value)}>{copy}
        {metaFor(item.value) && <span className="mixdog-settings__picker-meta">{metaFor(item.value)}</span>}
        <ChevronRight aria-hidden="true" size={16} /></button>;
    })}
  </section>;
}

function CategoryPanel({ api, category, context, onOpen }: {
  api: CapabilityApi;
  category: SettingsCategory;
  context: PanelContext;
  onOpen(section: SettingsSection): void;
}) {
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    let live = true;
    void api.getZoomFactor?.().then((value) => { if (live) setZoom(value); }).catch(() => {});
    const unsubscribe = api.onZoomFactorChanged?.((value) => { if (live) setZoom(value); });
    return () => { live = false; unsubscribe?.(); };
  }, [api]);
  const { data, pending, run } = context;
  const busy = Boolean(pending);
  const agents = rows(data.agents);
  const models = normalizeModelOptions(Array.isArray(data.models) ? data.models as DesktopModelOption[] : []);
  return <>
    <SettingsList category={category} context={context} onOpen={onOpen} />
    {category === 'general' && <Group title="Display">
      <SelectRow title="Zoom" description="Scale the Mixdog desktop interface." value={String(zoom)}
        options={[0.75, 0.9, 1, 1.1, 1.25, 1.5].map((value) => ({
          value: String(value),
          label: `${Math.round(value * 100)}%`,
        }))}
        onChange={(value) => {
          const factor = Number(value);
          setZoom(factor);
          void api.setZoomFactor?.(factor).then(setZoom).catch(() => {});
        }} />
    </Group>}
    {category === 'models' && <Group title="Agent routes" description="Per-agent model, effort, and fast-mode routing.">
      {agents.length ? agents.map((agent) => <ResourceRow key={String(agent.id)} title={label(agent)}
        description={String(agent.description || record(agent.definition).description || '')}
        actions={<RouteEditor compact title={`${label(agent)} route`} route={record(agent.route)}
          models={models} disabled={busy}
          onChange={(selection) => void run('setAgentRoute', [agent.id, selection], `agent-${agent.id}`)} />} />)
        : <Empty text="No configurable agent routes found." />}
    </Group>}
    {category === 'channels' && <AutomationPanel {...context} />}
    {category === 'capabilities' && <Group title="Memory">
      <ToggleRow title="Memory" description="Enable recap and curated core memories across sessions."
        checked={record(data.memory).enabled !== false} disabled={busy}
        onChange={(enabled) => void run('setMemoryEnabled', [enabled])} />
    </Group>}
    {category === 'system' && <Group title="Doctor">
      <ResourceRow title="Diagnostics" description="Check the runtime, providers, integrations, and local installation."
        actions={<ActionButton disabled={busy} onClick={() => void run('runDoctor')}>Run doctor</ActionButton>} />
    </Group>}
  </>;
}

function ProfilePanel({ data, pending, run }: PanelContext) {
  const profile = record(data.profile);
  const languages = rows(profile.languages);
  return <Group>
    <FormRow title="Title" description="Preferred form of address. Enter to edit."
      onSubmit={(form) => void run('setProfile', [{ title: form.get('title') }])}>
      <input name="title" defaultValue={String(profile.title || '')} placeholder="Your name or role" />
      <button disabled={Boolean(pending)}>Save</button>
    </FormRow>
    <SelectRow title="Language" description="Response language." value={String(profile.language || 'system')}
      disabled={Boolean(pending)} options={languages.map((entry) => ({ value: String(entry.id), label: label(entry) }))}
      onChange={(language) => void run('setProfile', [{ language }])} />
  </Group>;
}

function AutoClearPanel({ data, pending, run }: PanelContext) {
  const current = record(data.autoClear);
  const busy = Boolean(pending);
  return <>
    <Group>
      <ToggleRow title="Auto-clear" description={current.enabled !== false
        ? `Clear idle sessions after ${formatDuration(current.idleMs)}.`
        : 'Idle auto-clear disabled.'} checked={current.enabled !== false} disabled={busy}
        onChange={(enabled) => void run('setAutoClear', [{ enabled }])} />
    </Group>
    <Group title="Advanced" description="Provider default idle windows.">
      {rows(current.providerDefaults).map((entry) => <FormRow key={String(entry.provider)}
        title={String(entry.provider)} description={`Default idle window for ${entry.provider}.`}
        onSubmit={(form) => void run('setAutoClear', [{ provider: entry.provider, duration: form.get('duration') }])}>
        <input name="duration" defaultValue={durationTextInput(entry.idleMs)} required />
        <button disabled={busy}>Save</button>
        {Boolean(entry.custom) ? <ActionButton disabled={busy} onClick={() => void run('setAutoClear', [
          { provider: entry.provider, resetProvider: true },
        ])}>Reset</ActionButton> : null}
      </FormRow>)}
    </Group>
  </>;
}

function ChannelSettingPanel({ data, pending, run }: PanelContext) {
  const setup = record(data.channelSetup);
  const channel = record(setup.channel);
  const busy = Boolean(pending);
  return <>{(['discord', 'telegram'] as const).map((backend) => {
    const telegram = backend === 'telegram';
    const status = record(setup[backend]);
    const target = telegram
      ? channel.telegramChatId || (setup.backend === backend ? channel.channelId : '')
      : channel.discordChannelId || (setup.backend === backend ? channel.channelId : '');
    return <Group key={backend} title={telegram ? 'Telegram' : 'Discord'}
      description={`${setup.backend === backend ? 'Selected · ' : ''}${status.authenticated && target ? 'Ready' : 'Needs setup'}`}>
      <SecretForm title="Bot token" status={status} disabled={busy}
        onSave={(secret) => void run(telegram ? 'saveTelegramToken' : 'saveDiscordToken', [secret])} />
      <FormRow title={telegram ? 'Main chat' : 'Main channel'}
        description={target ? `${telegram ? 'Chat' : 'Channel'} ID ${target}` : `Not set · Enter ${telegram ? 'Telegram chat' : 'Discord channel'} ID`}
        onSubmit={(form) => void run('setChannel', [{ backend, channelId: form.get('channelId') }])}>
        <input name="channelId" defaultValue={String(target || '')} required />
        <button disabled={busy}>Save</button>
      </FormRow>
    </Group>;
  })}</>;
}

function ChoicePanel({ title, values, active, pending, onChoose }: {
  title: string; values: RecordValue[]; active: string; pending: string; onChoose(id: string): void;
}) {
  return <Group title={title}>{values.length ? values.map((entry) => {
    const id = String(entry.id);
    return <ResourceRow key={id} title={label(entry)} description={String(entry.description || entry.source || '')}
      meta={id === active || entry.active ? 'Active' : undefined}
      actions={id !== active && !entry.active && <ActionButton disabled={Boolean(pending)} onClick={() => onChoose(id)}>Choose</ActionButton>} />;
  }) : <Empty text={`No ${title.toLowerCase()} available.`} />}</Group>;
}

function OutputStylePanel({ data, pending, run }: PanelContext) {
  const output = record(data.outputStyles);
  return <ChoicePanel title="" values={rows(output, 'styles')}
    active={String(record(output.current).id || output.configured || 'default')} pending={pending}
    onChoose={(id) => void run('setOutputStyle', [id])} />;
}

function ThemePanel({ data, pending, run, notice }: PanelContext) {
  const original = useRef(String(data.theme || 'basic'));
  const committed = useRef(false);
  const preview = (id: string) => {
    if (pending) return;
    void run('setTheme', [id, { persist: false }], 'theme-preview', false)
      .then((result) => { if (result !== undefined) applyDesktopTheme(result || id); });
  };
  useEffect(() => () => {
    if (committed.current || !original.current) return;
    applyDesktopTheme(original.current);
    void run('setTheme', [original.current, { persist: false }], 'theme-restore', false);
  }, []);
  const themes = rows(data.themes);
  const active = String(data.theme || '');
  return <Group>{themes.length ? themes.map((entry) => {
    const id = String(entry.id);
    return <div key={id} onMouseEnter={() => preview(id)} onFocus={() => preview(id)}>
      <ResourceRow title={label(entry)} description={String(entry.description || 'color theme')}
        meta={id === active ? 'Active' : undefined} actions={<ActionButton disabled={Boolean(pending)} onClick={() => {
          committed.current = true;
          void run('setTheme', [id, { persist: true }]).then((result) => {
            if (result !== undefined) {
              applyDesktopTheme(result || id);
              notice(`Theme set to ${label(result || entry)}`);
            }
          });
        }}>Choose</ActionButton>} />
    </div>;
  }) : <Empty text="No themes available." />}</Group>;
}

function WorkflowPanel({ data, pending, run }: PanelContext) {
  return <ChoicePanel title="" values={rows(data.workflows)}
    active={String(rows(data.workflows).find((entry) => entry.active)?.id || '')} pending={pending}
    onChoose={(id) => void run('setWorkflow', [id])} />;
}

function MainModelPanel(context: PanelContext) {
  const { data, snapshot, pending, run, route, setFast } = context;
  const models = normalizeModelOptions(Array.isArray(data.models) ? data.models as DesktopModelOption[] : []);
  const active = record(snapshot);
  const current = `${active.provider || ''}:${active.model || ''}`;
  const selected = models.find((entry) => `${entry.provider}:${entry.model}` === current);
  return <Group>
    <SelectRow title="Model" description="Main chat model." value={current} disabled={Boolean(pending)}
      options={models.map((entry) => ({ value: `${entry.provider}:${entry.model}`, label: modelOptionLabel(entry) }))}
      onChange={(value) => { const next = models.find((entry) => `${entry.provider}:${entry.model}` === value); if (next) void route(next); }} />
    {selected?.effortOptions.length ? <SelectRow title="Reasoning effort" description="Effort level for the selected route."
      value={String(active.effort || preferredEffort(selected))} disabled={Boolean(pending)} options={selected.effortOptions}
      onChange={(value) => void run('setEffort', [value])} /> : null}
    {selected?.fastCapable && <ToggleRow title="Fast mode" description="Use the provider's priority service tier when available."
      checked={active.fast === true} disabled={Boolean(pending)} onChange={(enabled) => void setFast(enabled)} />}
  </Group>;
}

function SearchPanel({ data, pending, run }: PanelContext) {
  const models = normalizeModelOptions(rows(data.searchModels).map(routeOption));
  return <Group><RouteEditor title="Search model" description="Native search model."
    route={record(data.searchRoute)} models={models} disabled={Boolean(pending)}
    onChange={(selection) => void run('setSearchRoute', [selection])} /></Group>;
}

function UpdatePanel({ data, pending, run }: PanelContext) {
  const update = record(data.update);
  const status = record(data.updateStatus);
  const busy = Boolean(pending);
  return <Group>
    <ResourceRow title="Current version" description={status.phase === 'installed'
      ? `v${status.version || update.latestVersion} installed — restart mixdog to apply.`
      : 'Installed mixdog version.'} meta={String(update.currentVersion || 'unknown')} />
    <ResourceRow title="Latest version" description="Enter to re-check now." meta={String(update.latestVersion || 'unknown')}
      actions={<ActionButton disabled={busy} onClick={() => void run('checkForUpdate', [{ force: true }])}>Check now</ActionButton>} />
    <ToggleRow title="Auto-update" description="Enter to toggle automatic updates." checked={update.autoUpdate === true}
      disabled={busy} onChange={(enabled) => void run('setAutoUpdate', [enabled])} />
    <div className="settings-button-row"><ActionButton disabled={busy} onClick={() => void run('runUpdateNow')}>
      {status.phase === 'installed' ? `v${status.version || update.latestVersion} installed — restart to apply`
        : update.updateAvailable ? `Update to v${update.latestVersion || 'latest'}` : 'Update now'}</ActionButton></div>
  </Group>;
}

function GeneralPanel({ data, pending, run }: PanelContext) {
  const profile = record(data.profile);
  const autoClear = record(data.autoClear);
  const compaction = record(data.compaction);
  const channels = record(data.channels);
  const workflows = rows(data.workflows);
  const output = record(data.outputStyles);
  const styles = rows(output, 'styles');
  const themes = rows(data.themes);
  const providerDefaults = rows(autoClear.providerDefaults);
  const languageOptions = rows(profile.languages).map((entry) => ({ value: String(entry.id || entry.value || 'system'), label: label(entry) }));
  const busy = Boolean(pending);
  return <>
    <Group title="Profile"><FormRow title="Identity and response language" description="Injected into new responses through the core profile configuration."
      onSubmit={(form) => void run('setProfile', [{ title: form.get('title'), language: form.get('language') }])}>
      <input name="title" defaultValue={String(profile.title || '')} placeholder="Your name or role" />
      <OpenSelect name="language" ariaLabel="Response language" defaultValue={String(profile.language || 'system')}
        options={languageOptions} /><button disabled={busy}>Save</button></FormRow></Group>
    <Group title="Session lifecycle">
      <ToggleRow title="Auto-clear" description={`Clear idle sessions after ${Math.round(Number(autoClear.idleMs || 0) / 60000) || 'the provider default'} minutes.`}
        checked={autoClear.enabled !== false} disabled={busy} onChange={(enabled) => void run('setAutoClear', [{ enabled }])} />
      {providerDefaults.map((entry) => <FormRow key={String(entry.provider)}
        title={`${providerDisplayName(String(entry.provider || 'default'))} idle window`}
    description={entry.custom ? `Custom · built-in ${durationTextInput(entry.builtInMs)}` : 'Using the built-in provider default.'}
        onSubmit={(form) => void run('setAutoClear', [{ provider: entry.provider, duration: form.get('duration') }], `autoclear-${entry.provider}`)}>
        <input name="duration" defaultValue={durationTextInput(entry.idleMs)} placeholder={durationTextInput(entry.builtInMs)} required />
        <button disabled={busy}>Save</button>
        {Boolean(entry.custom) && <ActionButton disabled={busy} onClick={() => void run('setAutoClear', [
          { provider: entry.provider, resetProvider: true },
        ], `autoclear-reset-${entry.provider}`)}>Reset</ActionButton>}
      </FormRow>)}
      <ToggleRow title="Auto-compact" description="Compact automatically as the active context reaches its limit."
        checked={compaction.auto !== false} disabled={busy} onChange={(enabled) => void run('setCompactionSettings', [{ auto: enabled }])} />
      <ResourceRow title="Compaction strategy"
        description="Main sessions use memory recall to rebuild large histories efficiently."
        meta="Recall fast-track · fixed" />
      <ToggleRow title="Channels module" description="Enable Discord, Telegram, webhook, and scheduled channel services."
        checked={channels.enabled !== false} disabled={busy} onChange={(enabled) => void run('setChannelsEnabled', [enabled])} />
      <ToggleRow title="Remote runtime" description="Claim the configured channel bridge for this desktop session."
        checked={data.remote === true} disabled={busy} onChange={() => void run('toggleRemote')} />
    </Group>
    <Group title="Response behavior">
      <SelectRow title="Workflow" description="Select the active workflow pack." value={String(workflows.find((entry) => entry.active)?.id || '')}
        disabled={busy} options={workflows.map((entry) => ({ value: String(entry.id), label: label(entry) }))}
        onChange={(value) => void run('setWorkflow', [value])} />
      <SelectRow title="Output style" description="Controls the system output-style prompt." value={String(record(output.current).id || output.configured || 'default')}
        disabled={busy} options={styles.map((entry) => ({ value: String(entry.id), label: label(entry) }))}
        onChange={(value) => void run('setOutputStyle', [value])} />
      <SelectRow title="Theme" description="Persist the palette used by Mixdog surfaces." value={String(data.theme || '')}
        disabled={busy} options={themes.map((entry) => ({ value: String(entry.id), label: label(entry) }))}
        onChange={(value) => void run('setTheme', [value, { persist: true }]).then((result) => {
          if (result) applyDesktopTheme(result);
        })} />
    </Group>
  </>;
}

function ModelsPanel({ data, snapshot: liveSnapshot, pending, run, route, setFast }: PanelContext) {
  const models = normalizeModelOptions(Array.isArray(data.models) ? data.models as DesktopModelOption[] : []);
  const snapshot = Object.keys(record(liveSnapshot)).length
    ? record(liveSnapshot)
    : record(data.snapshot as EngineSnapshot);
  const currentKey = `${snapshot.provider || ''}:${snapshot.model || ''}`;
  const selected = models.find((model) => `${model.provider}:${model.model}` === currentKey);
  const mainModelOptions = models.map((model) => ({
    value: `${model.provider}:${model.model}`,
    label: modelOptionLabel(model),
  }));
  if (!selected && snapshot.provider && snapshot.model) {
    mainModelOptions.unshift({
      value: currentKey,
      label: `${modelDisplayName(String(snapshot.model), String(snapshot.provider))} · ${providerDisplayName(String(snapshot.provider))}`,
    });
  }
  const searchRoute = record(data.searchRoute);
  const searchModels = normalizeModelOptions(rows(data.searchModels).map(routeOption));
  const busy = Boolean(pending);
  return <>
    <Group title="Main route">
      <SelectRow title="Main model" description="Switch the model used for subsequent turns in this session." value={currentKey}
        disabled={busy} options={mainModelOptions}
        onChange={(value) => { const model = models.find((entry) => `${entry.provider}:${entry.model}` === value); if (model) void route(model); }} />
      <SelectRow title="Reasoning effort" description="Effort level for the selected route." value={String(snapshot.effort || 'auto')}
        disabled={busy} options={(selected?.effortOptions || [{ value: 'auto', label: 'Auto' }]).map((entry) => ({ value: entry.value, label: entry.label }))}
        onChange={(value) => void run('setEffort', [value])} />
      <ToggleRow title="Fast mode" description="Use the provider's priority service tier when available."
        checked={snapshot.fast === true} disabled={busy || snapshot.fastCapable !== true}
        onChange={(enabled) => void setFast(enabled)} />
    </Group>
    <Group title="Search route">
      <RouteEditor title="Web-search model" description="Dedicated model used for search synthesis."
        route={searchRoute} models={searchModels} disabled={busy}
        onChange={(selection) => void run('setSearchRoute', [selection])} />
    </Group>
  </>;
}

function AgentsPanel({ data, pending, run }: PanelContext) {
  const agents = rows(data.agents);
  const workflows = rows(data.workflows);
  const models = normalizeModelOptions(Array.isArray(data.models) ? data.models as DesktopModelOption[] : []);
  const busy = Boolean(pending);
  return <>
    <Group title="Workflow packs">{workflows.length ? workflows.map((workflow) => <ResourceRow key={String(workflow.id)}
      title={label(workflow)} description={String(workflow.description || '')} meta={workflow.active ? 'Active' : String(workflow.source || '')}
      actions={!workflow.active && <ActionButton disabled={busy} onClick={() => void run('setWorkflow', [workflow.id])}>Activate</ActionButton>} />)
      : <Empty text="No workflows found." />}</Group>
    <Group title="Agent routes">{agents.map((agent) => {
      const route = record(agent.route);
      return <ResourceRow key={String(agent.id)} title={label(agent)} description={String(agent.description || record(agent.definition).description || '')}
        meta={String(agent.workflowSlot || 'fixed slot')} actions={<RouteEditor compact title={`${label(agent)} route`}
          route={route} models={models} disabled={busy}
          onChange={(selection) => void run('setAgentRoute', [agent.id, selection], `agent-${agent.id}`)} />} />;
    })}</Group>
  </>;
}

function ProvidersPanel({ data, pending, run, confirm }: PanelContext) {
  const setup = record(data.providerSetup);
  const apiProviders = rows(setup.api);
  const oauthProviders = rows(setup.oauth);
  const localProviders = rows(setup.local);
  const busy = Boolean(pending);
  return <>
    <Group title="API-key providers">{apiProviders.map((provider) => <ResourceRow key={String(provider.id)} title={providerLabel(provider)}
      description={String(provider.detail || provider.envName || '')} meta={provider.authenticated ? 'Connected' : String(provider.status || 'Not connected')}
      actions={<>{String(provider.id) === 'opencode-go' && <ActionButton disabled={busy}
        onClick={() => void run('loginOpenCodeGoUsage')}>Usage sign-in</ActionButton>}
        {Boolean(provider.stored || (!provider.env && provider.authenticated)) &&
          <ActionButton danger disabled={busy} onClick={() => {
        confirm({ title: 'Forget provider authentication?', description: `Remove the saved authentication for ${providerLabel(provider)}.`,
          confirmLabel: 'Forget', danger: true, onConfirm: () => void run('forgetProviderAuth', [provider.id]) });
      }}>Forget</ActionButton>}</>} />)}
      <FormRow title="Save API key" description="Secrets are sent directly to the main process and are never echoed back." resetOnSubmit
        onSubmit={(form) => void run('saveProviderApiKey', [form.get('provider'), form.get('secret')])}>
        <OpenSelect name="provider" ariaLabel="API provider" defaultValue={String(apiProviders[0]?.id || '')}
          options={apiProviders.map((provider) => ({ value: String(provider.id), label: providerLabel(provider) }))} />
        <input name="secret" type="password" autoComplete="off" placeholder="API key" required />
        <button disabled={busy}>Save</button></FormRow>
    </Group>
    <Group title="OAuth providers">{oauthProviders.length ? oauthProviders.map((provider) => <ResourceRow key={String(provider.id)} title={providerLabel(provider)}
      description={String(provider.detail || '')} meta={provider.authenticated ? 'Connected' : String(provider.status || 'Not connected')}
      actions={<><OAuthControl provider={provider} disabled={busy} run={run} />
        {provider.authenticated && <ActionButton danger disabled={busy} onClick={() => {
          confirm({ title: 'Forget provider authentication?', description: `Remove the saved authentication for ${providerLabel(provider)}.`,
            confirmLabel: 'Forget', danger: true, onConfirm: () => void run('forgetProviderAuth', [provider.id]) });
        }}>Forget</ActionButton>}</>} />) : <Empty text="No OAuth providers available." />}</Group>
    <Group title="Local providers">{localProviders.map((provider) => <React.Fragment key={String(provider.id)}>
      <ResourceRow title={providerLabel(provider)} description={String(provider.baseURL || provider.detail || '')}
        meta={String(provider.status || (provider.detected ? 'Detected' : 'Off'))}
        actions={<ActionButton disabled={busy} onClick={() => void run('setLocalProvider', [provider.id, {
          enabled: provider.enabled !== true, baseURL: provider.baseURL,
        }])}>{provider.enabled ? 'Disable' : 'Enable'}</ActionButton>} />
      <FormRow title={`${providerLabel(provider)} endpoint`} description="Update the OpenAI-compatible base URL and enable this provider."
        onSubmit={(form) => void run('setLocalProvider', [provider.id, {
          enabled: true, baseURL: form.get('baseURL'),
        }], `local-${provider.id}`)}>
        <input name="baseURL" type="url" defaultValue={String(provider.baseURL || provider.defaultURL || '')}
          placeholder={String(provider.defaultURL || 'http://127.0.0.1:11434/v1')} required />
        <button disabled={busy}>Save & enable</button>
      </FormRow>
    </React.Fragment>)}</Group>
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
  const providerId = String(provider.id || '');
  const refresh = async () => {
    if (!flow?.flowId) return;
    const next = await run<RecordValue>('getOAuthProviderLoginStatus', [flow.flowId], `oauth-status-${providerId}`, false);
    if (next) setFlow(record(next));
  };
  const start = async () => {
    setError('');
    const next = await run<RecordValue>('beginOAuthProviderLogin', [providerId], `oauth-begin-${providerId}`, false);
    if (next) setFlow(record(next));
  };
  const close = () => {
    const completed = flow?.state === 'complete';
    setFlow(null);
    if (completed) void run('getProviderSetup', [], `oauth-refresh-${providerId}`, true).then(() => onComplete?.());
  };
  return <>
    <ActionButton disabled={disabled} onClick={() => void start()}>{provider.authenticated ? 'Reconnect' : 'Connect'}</ActionButton>
    {flow && <div className="settings-oauth-layer" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}><section className="settings-oauth-dialog" role="dialog" aria-modal="true" data-settings-nested-dialog
      aria-label={`${providerLabel(provider)} OAuth login`}>
      <header><div><b>{providerLabel(provider)} OAuth</b><small>Complete the browser login or paste the returned code.</small></div>
        <button type="button" aria-label="Close OAuth login" autoFocus onClick={close}>×</button></header>
      <ResourceRow title="Status" description={String(flow.error || '')} meta={String(flow.state || 'pending')} />
      {Boolean(flow.manualUrl || flow.url) && <label className="settings-oauth-url">Manual login URL
        <textarea readOnly value={String(flow.manualUrl || flow.url)} /></label>}
      {Boolean(flow.manualCodeSupported) && flow.state !== 'complete' && <form className="settings-oauth-code" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const code = new FormData(form).get('code');
        form.reset();
        void run<RecordValue>('completeOAuthProviderLogin', [flow.flowId, code], `oauth-complete-${providerId}`, false)
          .then((next) => { if (next) setFlow(record(next)); })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      }}><input name="code" placeholder="Authorization code or redirect URL" required /><button disabled={disabled}>Complete</button></form>}
      {error && <p className="settings-field-error">{error}</p>}
      <footer><ActionButton disabled={disabled} onClick={() => void refresh()}>Check status</ActionButton>
        {flow.state !== 'complete' && <ActionButton danger disabled={disabled} onClick={() => {
          void run<RecordValue>('cancelOAuthProviderLogin', [flow.flowId], `oauth-cancel-${providerId}`, false)
            .then((next) => { if (next) setFlow(record(next)); });
        }}>Cancel login</ActionButton>}
        <ActionButton onClick={close}>Close</ActionButton></footer>
    </section></div>}
  </>;
}

function McpPanel({ data, pending, run }: PanelContext) {
  const status = record(data.mcp);
  const servers = rows(status, 'servers');
  const busy = Boolean(pending);
  return <>
    <Group title="Servers" description={`${status.connectedCount || 0} connected · ${status.failedCount || 0} failed`}>
      {servers.length ? servers.map((server) => <ResourceRow key={String(server.name)} title={String(server.name)}
        description={`${server.transport || 'transport unknown'}${server.error ? ` · ${server.error}` : ''}`}
        meta={`${server.status || 'unknown'} · ${server.toolCount || 0} tools`}
        actions={<ActionButton disabled={busy} onClick={() => void run('setMcpServerEnabled', [server.name, server.enabled === false])}>
          {server.enabled === false ? 'Enable' : 'Disable'}</ActionButton>} />) : <Empty text="No MCP servers configured." />}
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
    <Group title="Available skills">{skills.length ? skills.map((skill) => <ResourceRow key={String(skill.name)} title={String(skill.name)}
      description={String(skill.description || skill.filePath || '')} meta={`${skill.source || 'skill'} · ${disabled.has(String(skill.name)) ? 'Disabled' : 'Enabled'}`}
      actions={<ActionButton disabled={busy} onClick={() => toggle(String(skill.name))}>{disabled.has(String(skill.name)) ? 'Enable' : 'Disable'}</ActionButton>} />)
        : <Empty text="No skills found." />}
    </Group>
  </>;
}

function PluginsPanel({ data, pending, run, confirm }: PanelContext) {
  const status = record(data.plugins);
  const plugins = rows(status, 'plugins');
  const busy = Boolean(pending);
  return <>
    <Group title="Installed plugins">{plugins.length ? plugins.map((plugin) => <ResourceRow key={String(plugin.id || plugin.name)} title={label(plugin)}
      description={String(plugin.description || plugin.root || '')} meta={`${plugin.version || 'unversioned'} · ${plugin.skillCount || 0} skills`}
      actions={<><ActionButton disabled={busy} onClick={() => void run('updatePlugin', [plugin])}>
        {plugin.sourceType === 'local' ? 'Refresh metadata' : 'Update plugin'}</ActionButton>
        {plugin.mcpScript && <ActionButton disabled={busy}
          onClick={() => void run('enablePluginMcp', [plugin])}>{plugin.mcpEnabled ? 'Refresh MCP' : 'Enable MCP'}</ActionButton>}
        {Boolean(plugin.root) && <ActionButton disabled={busy} onClick={() => {
          void navigator.clipboard?.writeText(String(plugin.root));
        }}>Copy root</ActionButton>}
        {Boolean(plugin.mcpServerName) && <ActionButton disabled={busy} onClick={() => {
          void navigator.clipboard?.writeText(String(plugin.mcpServerName));
        }}>Copy MCP name</ActionButton>}
        <ActionButton danger disabled={busy} onClick={() => {
          confirm({ title: 'Remove plugin?', description: `${label(plugin)} will be removed from Mixdog.`,
            confirmLabel: 'Remove', danger: true, onConfirm: () => void run('removePlugin', [plugin]) });
        }}><Trash2 size={13} /></ActionButton></>} />) : <Empty text="No plugins installed." />}
    </Group>
    <Group title="Install plugin"><FormRow title="Plugin source" description="Local path, Git URL, or supported registry source."
      onSubmit={(form) => void run('addPlugin', [form.get('source')])}>
      <input name="source" placeholder="https://github.com/org/plugin or C:\path" required /><button disabled={busy}>Install</button>
    </FormRow></Group>
  </>;
}

function HooksPanel({ data, pending, run }: PanelContext) {
  const status = record(data.hooks);
  const rules = rows(status, 'rules');
  const busy = Boolean(pending);
  return <>
    <Group title="Policy rules" description={`${status.ruleCount || rules.length} rules · ${status.configMode || 'standalone'}`}>
      {rules.length ? rules.map((rule, index) => <ResourceRow key={String(rule.index ?? index)} title={`${rule.tool || '*'} → ${rule.action || 'ask'}`}
        description={String(rule.match || rule.reason || '')} meta={rule.enabled === false ? 'Disabled' : 'Enabled'}
        actions={<ActionButton disabled={busy} onClick={() => void run('setHookRuleEnabled', [Number(rule.index ?? index), rule.enabled === false])}>
          {rule.enabled === false ? 'Enable' : 'Disable'}</ActionButton>} />) : <Empty text="No hook rules configured." />}
    </Group>
  </>;
}

function MemoryPanel({ data, pending, run, confirm }: PanelContext) {
  const memory = record(data.memory);
  const busy = Boolean(pending);
  return <>
    <Group title="Memory settings"><ToggleRow title="Memory" description="Enable memory recap and curated core memories."
      checked={memory.enabled !== false} disabled={busy} onChange={(enabled) => void run('setMemoryEnabled', [enabled])} /></Group>
    <Group title="Core memories" description="User-curated memories shared across Mixdog sessions.">
      <CoreMemoryManager pending={pending} run={run} confirm={confirm} />
    </Group>
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
  return entries;
}

function memoryResultError(value: unknown): string {
  const text = String(value || '').trim();
  return /^(?:core (?:add|edit|delete|promote|dismiss)(?::| failed)|core:.*(?:not initialized|failed|error)|(?:error|failed)\b)/i.test(text)
    ? text
    : '';
}

function CoreMemoryManager({ pending, run, confirm }: {
  pending: string;
  run: PanelContext['run'];
  confirm: PanelContext['confirm'];
}) {
  const [entries, setEntries] = useState<CoreMemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const loaded = useRef(false);
  const refresh = async () => {
    setLoading(true);
    const result = await run<unknown>('memoryControl', [
      { action: 'core', op: 'list', project_id: '*' }, { silent: true },
    ], 'core-memory-list', false);
    if (result !== undefined) setEntries(parseCoreMemoryEntries(result));
    setLoading(false);
  };
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void refresh();
  }, []);
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
    <form className="core-memory-add" onSubmit={(event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const sentence = String(new FormData(form).get('sentence') || '').trim();
      if (!sentence) return;
      void mutate({ action: 'core', op: 'add', project_id: 'common', element: sentence, summary: sentence })
        .then((ok) => { if (ok) form.reset(); });
    }}><input name="sentence" placeholder="Add a memory Mixdog should retain" maxLength={2000} required />
      <button disabled={Boolean(pending)}>Add memory</button></form>
    {loading ? <p className="settings-loading">Loading core memories…</p> : entries.length ? <div className="core-memory-list">
      {entries.map((entry) => editing === entry.id ? <form className="core-memory-edit" key={entry.id} onSubmit={(event) => {
        event.preventDefault();
        const summary = String(new FormData(event.currentTarget).get('summary') || '').trim();
        if (!summary) return;
        const payload: RecordValue = { action: 'core', op: 'edit', id: entry.id, project_id: entry.projectId, summary };
        if (entry.singleSentence) payload.element = summary;
        void mutate(payload).then((ok) => { if (ok) setEditing(null); });
      }}><input name="summary" defaultValue={entry.summary} maxLength={2000} required autoFocus />
        <button disabled={Boolean(pending)}>Save</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></form>
        : <div className="core-memory-row" key={entry.id}><span>#{entry.id}</span><div><b>{entry.summary}</b>
          <small>{entry.projectId || 'Common'}</small></div><button disabled={Boolean(pending)} onClick={() => setEditing(entry.id)}>Edit</button>
          <button className="danger" disabled={Boolean(pending)} onClick={() => {
            confirm({ title: 'Delete memory?', description: `Memory #${entry.id} will be removed permanently.`,
              confirmLabel: 'Delete', danger: true,
              onConfirm: () => void mutate({ action: 'core', op: 'delete', id: entry.id, project_id: entry.projectId }) });
          }}>Delete</button></div>)}
    </div> : <Empty text="No core memories yet." />}
    {error && <p className="settings-field-error">{error}</p>}
    <ActionButton disabled={Boolean(pending)} onClick={() => void refresh()}>Refresh memories</ActionButton>
  </div>;
}

function ChannelsPanel({ data, snapshot, pending, run }: PanelContext) {
  const setup = record(data.channelSetup);
  const worker = record(data.channelWorker);
  const channel = record(setup.channel);
  const webhook = record(setup.webhook);
  const voice = record(data.voice);
  const progress = record(record(snapshot).progressHint);
  const voiceComponents = record(voice.components);
  const busy = Boolean(pending);
  const persistedBackend = String(setup.backend || 'discord');
  const [backend, setBackendChoice] = useState(persistedBackend);
  const optimisticBackend = useRef<string | null>(null);
  useEffect(() => {
    if (optimisticBackend.current && optimisticBackend.current !== persistedBackend) return;
    optimisticBackend.current = null;
    setBackendChoice(persistedBackend);
  }, [persistedBackend]);
  return <>
    <Group title="Runtime">
      <ToggleRow title="Remote session" description={worker.running ? `Worker running · PID ${worker.pid || '?'}` : 'Worker stopped'}
        checked={data.remote === true} disabled={busy} onChange={() => void run('toggleRemote')} />
      <SelectRow title="Backend" description="Primary outbound channel backend." value={backend} disabled={busy}
        options={[{ value: 'discord', label: 'Discord' }, { value: 'telegram', label: 'Telegram' }]}
        onChange={(value) => {
          optimisticBackend.current = value;
          setBackendChoice(value);
          void run('setBackend', [value], 'channel-backend', false).then((result) => {
            if (result !== undefined) return;
            optimisticBackend.current = null;
            setBackendChoice(persistedBackend);
          });
        }} />
      <ActionButton disabled={busy} onClick={() => void run('claimRemote')}>Claim remote bridge</ActionButton>
      <ResourceRow title="Voice transcription"
        description={progress.text ? String(progress.text) : voice.installed
          ? 'Managed Whisper and ffmpeg runtime is ready for incoming channel voice messages.'
          : `Runtime components · Whisper ${voiceComponents.whisper ? 'ready' : 'missing'} · model ${voiceComponents.model ? 'ready' : 'missing'} · ffmpeg ${voiceComponents.ffmpeg ? 'ready' : 'missing'}`}
        meta={voice.enabled ? 'On' : progress.text || voice.busy ? 'Installing…' : 'Off'}
        actions={<ActionButton disabled={busy || voice.busy === true}
          onClick={() => void run('toggleVoice', [], 'voice-toggle')}>
          {voice.enabled ? 'Disable voice' : voice.installed ? 'Enable voice' : 'Install & enable'}
        </ActionButton>} />
    </Group>
    <Group title="Authentication">
      <SecretForm title="Discord bot token" status={record(setup.discord)} disabled={busy}
        onSave={(secret) => void run('saveDiscordToken', [secret])} />
      <SecretForm title="Telegram bot token" status={record(setup.telegram)} disabled={busy}
        onSave={(secret) => void run('saveTelegramToken', [secret])} />
      <SecretForm title="Webhook / ngrok auth token" status={record(setup.webhook)} disabled={busy}
        onSave={(secret) => void run('saveWebhookAuthtoken', [secret])} />
    </Group>
    <Group title="Channel targets">
      <FormRow title="Discord channel" description="Channel ID retained independently when switching backends."
        onSubmit={(form) => void run('setChannel', [{ backend: 'discord', channelId: form.get('channelId') }])}>
        <input name="channelId" defaultValue={String(channel.discordChannelId || (setup.backend !== 'telegram' ? channel.channelId || '' : ''))}
          placeholder="Discord channel ID" required /><button disabled={busy}>Save</button>
      </FormRow>
      <FormRow title="Telegram chat" description="Chat ID retained independently when switching backends."
        onSubmit={(form) => void run('setChannel', [{ backend: 'telegram', channelId: form.get('channelId') }])}>
        <input name="channelId" defaultValue={String(channel.telegramChatId || (setup.backend === 'telegram' ? channel.channelId || '' : ''))}
          placeholder="Telegram chat ID" required /><button disabled={busy}>Save</button>
      </FormRow>
    </Group>
    <Group title="Webhook ingress">
      <FormRow title="ngrok domain" description="Reserved domain used by the configured webhook endpoint."
        onSubmit={(form) => void run('setWebhookConfig', [{ ngrokDomain: form.get('ngrokDomain') }])}>
        <input name="ngrokDomain" defaultValue={String(webhook.ngrokDomain || webhook.domain || '')}
          placeholder="my-app.ngrok-free.app" required />
        <button disabled={busy}>Save</button>
      </FormRow>
    </Group>
  </>;
}

function SecretForm({ title, status, disabled, onSave }: {
  title: string; status: RecordValue; disabled: boolean; onSave(secret: string): void;
}) {
  return <FormRow title={title} description={String(status.problem || status.status || 'Not configured')} resetOnSubmit
    onSubmit={(form) => onSave(String(form.get('secret') || ''))}>
    <input name="secret" type="password" autoComplete="off" placeholder="Secret" required /><button disabled={disabled}>Save</button>
  </FormRow>;
}

function AutomationPanel({ data, pending, run }: PanelContext) {
  const setup = record(data.channelSetup);
  const schedules = rows(setup.schedules);
  const webhooks = rows(setup.webhooks);
  const busy = Boolean(pending);
  const remoteEnabled = data.remote === true;
  return <>
    <Group title="Schedules">{schedules.length ? schedules.map((schedule) => <ResourceRow key={String(schedule.name)} title={String(schedule.name)}
      description={`${schedule.time || '(no cron)'} · ${schedule.route || ''}${schedule.model ? ` · ${schedule.model}` : ''}${remoteEnabled ? '' : ' · channel off'}`}
      meta={schedule.enabled === false ? 'Disabled' : 'Enabled'}
      actions={<ActionButton disabled={busy || !remoteEnabled} onClick={() => void run('setScheduleEnabled', [schedule.name, schedule.enabled === false])}>
        {schedule.enabled === false ? 'Enable' : 'Disable'}</ActionButton>} />) : <Empty text="No schedules configured." />}
    </Group>
    <Group title="Webhook endpoints">{webhooks.length ? webhooks.map((webhook) => <ResourceRow key={String(webhook.name)} title={String(webhook.name)}
      description={`${webhook.parser || 'github'} · ${webhook.route || ''} · secret:${webhook.secretSet ? 'set' : 'missing'}${remoteEnabled ? '' : ' · channel off'}`}
      meta={webhook.enabled === false ? 'Disabled' : 'Enabled'}
      actions={<ActionButton disabled={busy || !remoteEnabled} onClick={() => void run('setWebhookEnabled', [webhook.name, webhook.enabled === false])}>
        {webhook.enabled === false ? 'Enable' : 'Disable'}</ActionButton>} />) : <Empty text="No webhook endpoints configured." />}
    </Group>
  </>;
}

function DiagnosticsPanel({ data, pending, run, confirm }: PanelContext) {
  const update = record(data.update);
  const status = record(data.updateStatus);
  const busy = Boolean(pending);
  return <>
    <Group title="Updates">
      <ToggleRow title="Automatic updates" description={`Current ${update.currentVersion || 'unknown'}${update.latestVersion ? ` · latest ${update.latestVersion}` : ''}`}
        checked={update.autoUpdate === true} disabled={busy} onChange={(enabled) => void run('setAutoUpdate', [enabled])} />
      <div className="settings-button-row"><ActionButton disabled={busy} onClick={() => void run('checkForUpdate', [{ force: true }])}>Check now</ActionButton>
        {Boolean(update.updateAvailable) && <ActionButton disabled={busy} onClick={() => {
          confirm({ title: 'Install available update?', description: 'Mixdog may need to restart after the update is installed.',
            confirmLabel: 'Install update', onConfirm: () => void run('runUpdateNow') });
        }}>Install update</ActionButton>}</div>
      {Boolean(status.phase) && <ResourceRow title="Update process" description={String(status.message || status.detail || '')} meta={String(status.phase)} />}
    </Group>
    <Group title="Doctor"><ActionButton disabled={busy} onClick={() => void run('runDoctor')}>Run full diagnostics</ActionButton></Group>
    <Group title="Context status"><ContextStatusView value={data.context} /></Group>
    <Group title="Provider usage"><UsageDashboard value={data.usage} /></Group>
  </>;
}

function Empty({ text }: { text: string }) {
  return <p className="settings-empty">{text}</p>;
}
