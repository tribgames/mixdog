import React, { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Trash2,
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
import type { SettingsCategory } from './settings-items';
import {
  desktopThemePreferenceForTheme,
  getDesktopThemePreference,
  setDesktopThemePreference,
  type DesktopThemePreference,
} from '../desktop-theme';
import { OpenSelect } from '../OpenSelect';
import { filterConfiguredModels, ModelPicker } from '../ModelPicker';
import { modelDisplayName, modelOptionLabel, normalizeModelOptions, providerDisplayName } from '../provider-display';

type RecordValue = Record<string, unknown>;
type CapabilityApi = Partial<Pick<DesktopApi,
  'invokeCapability' | 'readCapabilities' | 'listProviderModels' | 'setModelRoute' | 'setFast' | 'getSnapshot'
  | 'subscribeState'>>;

interface CapabilitySettingsProps {
  api: CapabilityApi;
  category: SettingsCategory;
  onCompose?: (text: string) => void;
  onOpenCategory?: (category: SettingsCategory) => void;
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
  openCategory?: (category: SettingsCategory) => void;
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
  ['voice', 'getVoiceStatus'],
  ['workflows', 'listWorkflows'], ['outputStyles', 'listOutputStyles'], ['theme', 'getTheme'],
  ['searchRoute', 'getSearchRoute'], ['searchModels', 'listSearchModels', [{ quick: false }]],
  ['providerSetup', 'getProviderSetup'], ['mcp', 'mcpStatus'], ['plugins', 'pluginsStatus'],
  ['hooks', 'hooksStatus'], ['skills', 'skillsStatus'], ['disabledSkills', 'getDisabledSkills'],
  ['agents', 'listAgents'],
  ['update', 'getUpdateSettings'], ['updateStatus', 'getUpdateStatus'],
];

export interface CachedCapabilitySettings {
  data: Record<string, unknown>;
  error: string;
  loadedAt: number;
}

interface CapabilitySettingsCacheEntry {
  value?: CachedCapabilitySettings;
  inFlight?: Promise<CachedCapabilitySettings>;
}

const CAPABILITY_SETTINGS_CACHE = new WeakMap<object, CapabilitySettingsCacheEntry>();

function settingsCacheEntry(api: CapabilityApi): CapabilitySettingsCacheEntry {
  const key = api as object;
  const cached = CAPABILITY_SETTINGS_CACHE.get(key);
  if (cached) return cached;
  const created: CapabilitySettingsCacheEntry = {};
  CAPABILITY_SETTINGS_CACHE.set(key, created);
  return created;
}

export function getCachedCapabilitySettings(api: CapabilityApi): CachedCapabilitySettings | undefined {
  return CAPABILITY_SETTINGS_CACHE.get(api as object)?.value;
}

async function readAllCapabilitySettings(
  api: CapabilityApi,
  force: boolean,
  previous?: CachedCapabilitySettings,
): Promise<CachedCapabilitySettings> {
  if (!api.invokeCapability && !api.readCapabilities) {
    return { data: previous?.data || {}, error: '', loadedAt: Date.now() };
  }
  const next: Record<string, unknown> = { ...(previous?.data || {}) };
  let loadError = '';
  const prepared = SECTION_READS.map(([key, capability, args = []]) => ({
    key,
    request: {
      capability: capability as DesktopReadCapability,
      args: force && capability === 'listSearchModels'
        ? [{ ...record(args[0]), force: true }]
        : force && capability === 'getProviderSetup'
          ? [{ refresh: true }]
          : [...args],
    } satisfies DesktopCapabilityReadRequest,
  }));
  const readIndividually = async () => {
    if (!api.invokeCapability) return;
    await Promise.all(prepared.map(async ({ key, request }) => {
      try {
        next[key] = (await api.invokeCapability!({
          capability: request.capability,
          args: request.args,
        }))?.value;
      } catch (reason) {
        next[key] = { error: reason instanceof Error ? reason.message : String(reason) };
      }
    }));
  };
  const loadReads = async () => {
    if (!api.readCapabilities) {
      await readIndividually();
      return;
    }
    try {
      const results = await api.readCapabilities(prepared.map((entry) => entry.request));
      prepared.forEach((entry, index) => {
        const result = results[index];
        next[entry.key] = result?.ok
          ? result.value
          : { error: result && 'error' in result ? result.error : 'Capability read did not return a result.' };
      });
    } catch (reason) {
      if (api.invokeCapability) {
        await readIndividually();
      } else {
        loadError = reason instanceof Error ? reason.message : String(reason);
      }
    }
  };
  await Promise.all([
    loadReads(),
    (async () => {
      try {
        next.models = await api.listProviderModels?.({
          quick: false,
          ...(force ? { force: true } : {}),
        }) || [];
      } catch (reason) {
        next.models = previous?.data.models || [];
        loadError = reason instanceof Error ? reason.message : String(reason);
      }
    })(),
    api.getSnapshot?.().then((snapshot) => { next.snapshot = snapshot || null; })
      .catch(() => { next.snapshot = previous?.data.snapshot || null; }) || Promise.resolve(),
    api.invokeCapability?.({
      capability: 'memoryControl',
      args: [{ action: 'core', op: 'list', project_id: '*' }, { silent: true }],
    }).then((result) => { next.coreMemory = result.value; })
      .catch(() => { next.coreMemory = previous?.data.coreMemory; }) || Promise.resolve(),
  ]);
  return { data: next, error: loadError, loadedAt: Date.now() };
}

export function preloadCapabilitySettings(
  api: CapabilityApi,
  force = false,
): Promise<CachedCapabilitySettings> {
  const entry = settingsCacheEntry(api);
  if (entry.inFlight) return entry.inFlight;
  if (entry.value && !force) return Promise.resolve(entry.value);
  const request = readAllCapabilitySettings(api, force, entry.value);
  entry.inFlight = request;
  void request.then((value) => {
    entry.value = value;
    if (entry.inFlight === request) entry.inFlight = undefined;
  }, () => {
    if (entry.inFlight === request) entry.inFlight = undefined;
  });
  return request;
}

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

export function CapabilitySettings({ api, category, onCompose, onOpenCategory }: CapabilitySettingsProps) {
  const initialCache = getCachedCapabilitySettings(api);
  const [data, setData] = useState<Record<string, unknown>>(() => initialCache?.data || {});
  const [hydrating, setHydrating] = useState(() => !initialCache);
  const [pending, setPending] = useState('');
  const [error, setError] = useState(() => initialCache?.error || '');
  const [notice, setNotice] = useState<{ message: string; tone: 'info' | 'warn' } | null>(null);
  const [confirmation, setConfirmation] = useState<SettingsConfirmation | null>(null);
  const [liveSnapshot, setLiveSnapshot] = useState<EngineSnapshot>(null);
  const [revision, setRevision] = useState(0);
  const loadSequence = useRef(0);
  const updateChecked = useRef(false);

  const load = useCallback(async (force = false) => {
    const sequence = ++loadSequence.current;
    const startedAt = performance.now();
    const cached = getCachedCapabilitySettings(api);
    if (cached) {
      setData(cached.data);
      setError(cached.error);
      setHydrating(false);
    } else {
      setError('');
      setHydrating(true);
    }
    const next = await preloadCapabilitySettings(api, force);
    if (sequence !== loadSequence.current) return;
    setData(next.data);
    setError(next.error);
    setHydrating(false);
    // Perf diagnostics (dropped unless MIXDOG_DESKTOP_PERF=1): how long the
    // panel showed skeleton/stale values before real data landed.
    if (!cached) {
      window.mixdogDesktop?.perfLog?.(`settings-hydrate ms=${(performance.now() - startedAt).toFixed(0)}`);
    }
  }, [api]);

  useEffect(() => {
    const cached = getCachedCapabilitySettings(api);
    const stale = Boolean(cached && Date.now() - cached.loadedAt >= 15_000);
    void load(revision > 0 || stale);
    return () => { loadSequence.current += 1; };
  }, [api, load, revision]);
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
    if (!api.invokeCapability || pending || hydrating) return undefined;
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
  }, [api, hydrating, pending]);

  useEffect(() => {
    if (category !== 'system') {
      updateChecked.current = false;
      return;
    }
    if (hydrating || updateChecked.current) return;
    updateChecked.current = true;
    void run('checkForUpdate', [{}]);
  }, [category, hydrating, run]);

  const route = useCallback(async (model: DesktopModelOption) => {
    if (!api.setModelRoute || pending || hydrating) return;
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
  }, [api, hydrating, liveSnapshot, pending]);

  const setFast = useCallback(async (enabled: boolean) => {
    if (!api.setFast || pending || hydrating) return;
    setPending('fast');
    setError('');
    try {
      await api.setFast(enabled);
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setPending(''); }
  }, [api, hydrating, pending]);

  const confirm = useCallback((options: SettingsConfirmation) => setConfirmation(options), []);
  const pushNotice = useCallback((message: string, tone: 'info' | 'warn' = 'info') => {
    setNotice({ message, tone });
  }, []);

  const effectivePending = hydrating ? 'settings-hydrating' : pending;
  const context = useMemo<PanelContext>(() => ({
    data, snapshot: liveSnapshot, pending: effectivePending, run, route, setFast, confirm, notice: pushNotice,
    compose: onCompose, openCategory: onOpenCategory,
  }), [confirm, data, effectivePending, liveSnapshot, onCompose, onOpenCategory, pushNotice, route, run, setFast]);

  return <>
    <CategoryPanel category={category} context={context} />
    {error && <p className="mixdog-settings__error" role="alert">{error}</p>}
    {notice && <p className={`settings-notice settings-notice--${notice.tone}`}
      role={notice.tone === 'warn' ? 'alert' : 'status'}>{notice.message}</p>}
    {confirmation && <SettingsConfirmDialog options={confirmation} onClose={() => setConfirmation(null)} />}
  </>;
}

function Group({ title, description, children }: {
  title?: string; description?: string; children: ReactNode;
}) {
  return <section className="settings-group">
    {(title || description) &&
    <header>{title && <h3>{title}</h3>}
      {description && <p>{description}</p>}</header>}
    <div className="settings-group-body">{children}</div></section>;
}

function ToggleRow({ title, description: _description, checked, disabled, onChange }: {
  title: string; description?: string; checked: boolean; disabled?: boolean; onChange(value: boolean): void;
}) {
  return <div className="mixdog-settings__row"><div className="mixdog-settings__copy">
    <span className="mixdog-settings__row-title">{title}</span>
  </div><div className="settings-row-control"><label className="mixdog-settings__switch"><input type="checkbox" aria-label={title} checked={checked}
    disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} /><span aria-hidden="true" /></label></div></div>;
}

function SelectRow({ title, description: _description, value, disabled, options, onChange }: {
  title: string; description?: string; value: string; disabled?: boolean;
  options: ReadonlyArray<{ value: string; label: string }>; onChange(value: string): void;
}) {
  const normalized = options.some((entry) => entry.value === value)
    ? options
    : [{ value, label: value || 'Select…' }, ...options];
  return <div className="mixdog-settings__row"><div className="mixdog-settings__copy">
    <span className="mixdog-settings__row-title">{title}</span>
  </div><div className="settings-row-control"><OpenSelect className="settings-select" ariaLabel={title} value={value} disabled={disabled}
    options={normalized} onChange={onChange} /></div></div>;
}

function QuietSelectRow({ title, value, disabled, options, kind, onChange }: {
  title: string;
  value: string;
  disabled?: boolean;
  options: ReadonlyArray<{ value: string; label: string }>;
  kind: 'effort' | 'fast';
  onChange(value: string): void;
}) {
  const normalized = options.some((entry) => entry.value === value)
    ? options
    : [{ value, label: value || 'Select…' }, ...options];
  return <div className="mixdog-settings__row"><div className="mixdog-settings__copy">
    <span className="mixdog-settings__row-title">{title}</span>
  </div><div className="settings-row-control"><div className={`${kind}-control`}>
    <OpenSelect ariaLabel={title} value={value} disabled={disabled}
      options={normalized} onChange={onChange} />
  </div></div></div>;
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

function RouteEditor({ title, description: _description, route, models, disabled, compact = false,
  onChange, onOpenProviders }: {
  title: string;
  description?: string;
  route: RecordValue;
  models: DesktopModelOption[];
  disabled?: boolean;
  compact?: boolean;
  onChange(selection: DesktopModelSelection): unknown;
  onOpenProviders?: () => void;
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
  const modelSelect = <ModelPicker models={models}
    provider={String(route.provider || '')} model={String(route.model || '')}
    triggerLabel={selected
      ? modelDisplayName(selected.model, selected.provider, selected.display)
      : route.model ? modelDisplayName(String(route.model), String(route.provider || '')) : 'Select model…'}
    ariaLabel={title} triggerClassName="model-trigger settings-model-trigger"
    disabled={disabled} onSelect={(model) => onChange(selectionFor(model))}
    onOpenProviders={onOpenProviders} />;
  if (!compact) {
    return <>
      <div className="mixdog-settings__row settings-route-row">
        <div className="mixdog-settings__copy">
          <span className="mixdog-settings__row-title">Model</span>
        </div>
        <div className="settings-row-control">{modelSelect}</div>
      </div>
      {selected && selected.effortOptions.length > 0 && <QuietSelectRow title="Effort" kind="effort"
        value={effort || selected.effortOptions[0]?.value || 'auto'} disabled={disabled}
        options={selected.effortOptions}
        onChange={(value) => onChange(selectionFor(selected, { effort: value }))} />}
      {selected?.fastCapable && <QuietSelectRow title="Fast mode" kind="fast"
        value={fast ? 'on' : 'off'} disabled={disabled}
        options={[{ value: 'on', label: 'Fast On' }, { value: 'off', label: 'Fast Off' }]}
        onChange={(value) => onChange(selectionFor(selected, { fast: value === 'on' }))} />}
    </>;
  }
  return <div className="settings-route-editor compact">
    <div className="settings-route-controls">
      {modelSelect}
      {selected && selected.effortOptions.length > 0 && <div className="effort-control">
        <OpenSelect ariaLabel={`${title} effort`} value={effort} disabled={disabled}
          options={selected.effortOptions}
          onChange={(value) => onChange(selectionFor(selected, { effort: value }))} />
      </div>}
      {selected?.fastCapable && <div className="fast-control">
        <OpenSelect ariaLabel={`${title} fast mode`} value={fast ? 'on' : 'off'} disabled={disabled}
          options={[{ value: 'on', label: 'Fast On' }, { value: 'off', label: 'Fast Off' }]}
          onChange={(value) => onChange(selectionFor(selected, { fast: value === 'on' }))} />
      </div>}
    </div>
  </div>;
}

function FormRow({ title, description: _description, status, children, resetOnSubmit = false, onSubmit }: {
  title: string; description?: string; status?: string; children: ReactNode; resetOnSubmit?: boolean; onSubmit(data: FormData): void;
}) {
  const state = status ? settingsStatus(status) : null;
  return <form className="settings-form-row" onSubmit={(event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    onSubmit(new FormData(form));
    if (resetOnSubmit) form.reset();
  }}><div className="settings-resource-title"><b>{title}</b>
      {state && <span className={`settings-status settings-status--${state.tone}`}><i aria-hidden="true" />{state.label}</span>}
    </div><div className="settings-form-controls">{children}</div></form>;
}

function AutoSaveRow({ title, value, name, placeholder, required = false, disabled, actions, onSave }: {
  title: string;
  value: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  actions?: ReactNode;
  onSave(value: string): void;
}) {
  const commit = (input: HTMLInputElement) => {
    if (input.value === value) return;
    if (required && !input.reportValidity()) return;
    onSave(input.value);
  };
  return <div className="settings-form-row"><div><b>{title}</b></div><div className="settings-form-controls">
    <input key={value} name={name} aria-label={title} defaultValue={value} placeholder={placeholder}
      required={required} disabled={disabled}
      onBlur={(event) => commit(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.currentTarget.value = value;
          event.currentTarget.blur();
        }
      }} />
    {actions}
  </div></div>;
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

type SettingsStatusTone = 'positive' | 'warning' | 'danger' | 'neutral';

function settingsStatus(value: string): { label: string; tone: SettingsStatusTone } {
  const text = value.replace(/[_-]+/g, ' ').trim();
  const label = text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : 'Unknown';
  const normalized = label.toLowerCase();
  if (/(failed|error|invalid|missing|rejected)/.test(normalized)) return { label, tone: 'danger' };
  if (/(pending|installing|checking|starting|connecting|updating|running update)/.test(normalized)) {
    return { label, tone: 'warning' };
  }
  if (/(not connected|disabled|off|stopped|unknown|idle)/.test(normalized)) return { label, tone: 'neutral' };
  if (/(connected|enabled|ready|detected|complete|installed|running|active|on|saved|^set$)/.test(normalized)) {
    return { label, tone: 'positive' };
  }
  return { label, tone: 'neutral' };
}

function ResourceRow({ title, description: _description, meta, status, selected = false, actions, className = '' }: {
  title: string; description?: string; meta?: string; status?: string; selected?: boolean; actions?: ReactNode; className?: string;
}) {
  const state = status ? settingsStatus(status) : selected ? settingsStatus('Active') : null;
  return <div className={`settings-resource ${className}`.trim()} aria-current={selected ? 'true' : undefined}><div>
    <div className="settings-resource-title"><b>{title}</b>
      {state && <span className={`settings-status settings-status--${state.tone}`}><i aria-hidden="true" />{state.label}</span>}
    </div>
    {meta && <small className="settings-resource-meta">{meta}</small>}
  </div>
    <div className="settings-resource-control">
      {actions && <div className="settings-resource-actions">{actions}</div>}</div></div>;
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
      meta={provider.primary ? String(provider.primary) : undefined}
      status={String(provider.status || 'unknown')} />)}</div> : <Empty text="No provider usage rows." />}
  </div>;
}

function CategoryPanel({ category, context }: {
  category: SettingsCategory;
  context: PanelContext;
}) {
  if (category === 'output-style') return <OutputStylePanel {...context} />;
  if (category === 'models') return <ModelsPanel {...context} />;
  if (category === 'workflows') return <AgentsPanel {...context} />;
  if (category === 'providers') return <ProvidersPanel {...context} />;
  if (category === 'channels') return <><ChannelsPanel {...context} /><AutomationPanel {...context} /></>;
  if (category === 'mcp') return <McpPanel {...context} />;
  if (category === 'plugins') return <PluginsPanel {...context} />;
  if (category === 'hooks') return <HooksPanel {...context} />;
  if (category === 'skills') return <SkillsPanel {...context} />;
  if (category === 'memory') return <MemoryPanel {...context} />;
  if (category === 'system') return <SystemPanel {...context} />;
  if (category === 'shortcuts') return <ShortcutsPanel />;
  return <GeneralPanel {...context} />;
}

// OpenCode-style keybind reference (read-only). Bindings live in App.tsx's
// global keydown handler and the composer key map; keep this list in sync.
const SHORTCUT_GROUPS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  ['Workspace', [
    ['Ctrl+N', 'New task'],
    ['Ctrl+Q', 'Close tab'],
    ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
    ['Ctrl+← / →', 'Switch tab'],
    ['Ctrl+B', 'Toggle sidebar'],
  ['Ctrl+Shift+B', 'Toggle utility panel'],
    ['Ctrl+,', 'Open settings'],
    ['Esc', 'Close menus and popovers'],
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
          <span>{label}</span>
          <kbd>{keys}</kbd>
        </div>)}
      </div>
    </Group>)}
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
  return <ChoicePanel title="" values={rows(output, 'styles')}
    active={String(record(output.current).id || output.configured || 'default')} pending={pending}
    emptyText="No output styles available." onChoose={(id) => void run('setOutputStyle', [id])} />;
}

function UpdatePanel({ data, pending, run }: PanelContext) {
  const update = record(data.update);
  const status = record(data.updateStatus);
  const busy = Boolean(pending);
  return <Group title="Update">
    <ResourceRow title="Current version" description={status.phase === 'installed'
      ? `v${status.version || update.latestVersion} installed — restart mixdog to apply.`
      : 'Installed mixdog version.'} meta={String(update.currentVersion || 'unknown')} />
    <ResourceRow title="Latest version" meta={String(update.latestVersion || 'unknown')}
      actions={<ActionButton disabled={busy} onClick={() => void run('checkForUpdate', [{ force: true }])}>Check now</ActionButton>} />
    <ToggleRow title="Auto-update" checked={update.autoUpdate === true}
      disabled={busy} onChange={(enabled) => void run('setAutoUpdate', [enabled])} />
    <ResourceRow title="Install update" actions={<ActionButton disabled={busy} onClick={() => void run('runUpdateNow')}>
      {status.phase === 'installed' ? `v${status.version || update.latestVersion} installed — restart to apply`
        : update.updateAvailable ? `Update to v${update.latestVersion || 'latest'}` : 'Update now'}</ActionButton>} />
  </Group>;
}

function ThemeChoices({ data, pending, run }: Pick<PanelContext, 'data' | 'pending' | 'run'>) {
  const backendTheme = String(data.theme || 'basic');
  const [preference, setPreference] = useState<DesktopThemePreference>(() =>
    getDesktopThemePreference() || desktopThemePreferenceForTheme(backendTheme));
  useEffect(() => {
    setPreference(getDesktopThemePreference() || desktopThemePreferenceForTheme(backendTheme));
  }, [backendTheme]);
  const choose = async (next: string) => {
    const selected = next as DesktopThemePreference;
    const previous = preference;
    setPreference(selected);
    const resolved = setDesktopThemePreference(selected);
    const result = await run('setTheme', [resolved, { persist: true }], `theme-${selected}`);
    if (result !== undefined) return;
    setPreference(previous);
    setDesktopThemePreference(previous);
  };
  return <Group title="Theme">
    <SelectRow title="Theme" value={preference} disabled={Boolean(pending)}
      options={[
        { value: 'system', label: 'System' },
        { value: 'white', label: 'White' },
        { value: 'dark', label: 'Dark' },
      ]}
      onChange={(next) => void choose(next)} />
  </Group>;
}

function GeneralPanel({ data, pending, run }: PanelContext) {
  const profile = record(data.profile);
  const autoClear = record(data.autoClear);
  const compaction = record(data.compaction);
  const providerDefaults = rows(autoClear.providerDefaults);
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
    <ThemeChoices data={data} pending={pending} run={run} />
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

function ModelsPanel({ data, snapshot: liveSnapshot, pending, run, route, setFast, openCategory }: PanelContext) {
  const models = filterConfiguredModels(
    normalizeModelOptions(Array.isArray(data.models) ? data.models as DesktopModelOption[] : []),
    data.providerSetup,
  );
  const snapshot = Object.keys(record(liveSnapshot)).length
    ? record(liveSnapshot)
    : record(data.snapshot as EngineSnapshot);
  const currentKey = `${snapshot.provider || ''}:${snapshot.model || ''}`;
  const selected = models.find((model) => `${model.provider}:${model.model}` === currentKey);
  const mainFastCapable = snapshot.fastCapable === true || selected?.fastCapable === true;
  const searchRoute = record(data.searchRoute);
  const searchModels = filterConfiguredModels(
    normalizeModelOptions(rows(data.searchModels).map(routeOption)),
    data.providerSetup,
  );
  const busy = Boolean(pending);
  return <>
    <Group title="Main route">
      <div className="mixdog-settings__row settings-route-row">
        <div className="mixdog-settings__copy"><span className="mixdog-settings__row-title">Model</span></div>
        <div className="settings-row-control"><ModelPicker models={models}
          provider={String(snapshot.provider || '')} model={String(snapshot.model || '')}
          triggerLabel={selected
            ? modelDisplayName(selected.model, selected.provider, selected.display)
            : snapshot.model ? modelDisplayName(String(snapshot.model), String(snapshot.provider || '')) : 'Select model…'}
          ariaLabel="Model" triggerClassName="model-trigger settings-model-trigger"
          disabled={busy} onSelect={(model) => route(model)}
          onOpenProviders={() => openCategory?.('providers')} /></div>
      </div>
      <QuietSelectRow title="Effort" kind="effort" value={String(snapshot.effort || 'auto')}
        disabled={busy} options={(selected?.effortOptions || [{ value: 'auto', label: 'Auto' }]).map((entry) => ({ value: entry.value, label: entry.label }))}
        onChange={(value) => void run('setEffort', [value])} />
      <QuietSelectRow title="Fast mode" kind="fast"
        value={snapshot.fast === true ? 'on' : 'off'} disabled={busy || !mainFastCapable}
        options={[{ value: 'on', label: 'Fast On' }, { value: 'off', label: 'Fast Off' }]}
        onChange={(value) => void setFast(value === 'on')} />
    </Group>
    <Group title="Search route">
      <RouteEditor title="Web-search model"
        route={searchRoute} models={searchModels} disabled={busy}
        onChange={(selection) => run('setSearchRoute', [selection])}
        onOpenProviders={() => openCategory?.('providers')} />
    </Group>
  </>;
}

function AgentsPanel({ data, pending, run, openCategory }: PanelContext) {
  const agents = rows(data.agents);
  const workflows = rows(data.workflows);
  const models = filterConfiguredModels(
    normalizeModelOptions(Array.isArray(data.models) ? data.models as DesktopModelOption[] : []),
    data.providerSetup,
  );
  const busy = Boolean(pending);
  return <>
    <Group title="Workflow packs">{workflows.length ? workflows.map((workflow) => <ResourceRow key={String(workflow.id)}
      title={label(workflow)} description={String(workflow.description || '')} selected={workflow.active === true}
      actions={!workflow.active && <ActionButton disabled={busy} onClick={() => void run('setWorkflow', [workflow.id])}>Activate</ActionButton>} />)
      : <ListEmpty text="No workflows found." />}</Group>
    <Group title="Agent routes">{agents.length ? agents.map((agent) => {
      const route = record(agent.route);
      return <ResourceRow key={String(agent.id)} className="settings-agent-route" title={label(agent)}
        description={String(agent.description || record(agent.definition).description || '')}
        actions={<RouteEditor compact title={`${label(agent)} route`}
          route={route} models={models} disabled={busy}
          onChange={(selection) => run('setAgentRoute', [agent.id, selection], `agent-${agent.id}`)}
          onOpenProviders={() => openCategory?.('providers')} />} />;
    }) : <ListEmpty text="No agent routes found." />}</Group>
  </>;
}

function ProvidersPanel({ data, pending, run, confirm }: PanelContext) {
  const setup = record(data.providerSetup);
  const apiProviders = rows(setup.api);
  const oauthProviders = rows(setup.oauth);
  const localProviders = rows(setup.local);
  const busy = Boolean(pending);
  return <>
    <Group title="OAuth providers">{oauthProviders.length ? oauthProviders.map((provider) => <ResourceRow key={String(provider.id)} title={providerLabel(provider)}
      description={String(provider.detail || '')}
      status={provider.authenticated ? 'Connected' : String(provider.status || 'Not connected')}
      actions={<><OAuthControl provider={provider} disabled={busy} run={run} />
        {provider.authenticated && <ActionButton danger disabled={busy} onClick={() => {
          confirm({ title: 'Forget provider authentication?', description: `Remove the saved authentication for ${providerLabel(provider)}.`,
            confirmLabel: 'Forget', danger: true, onConfirm: () => void run('forgetProviderAuth', [provider.id]) });
        }}>Forget</ActionButton>}</>} />) : <ListEmpty text="No OAuth providers available." />}</Group>
    <Group title="API-key providers">{apiProviders.length ? apiProviders.map((provider) => <ResourceRow key={String(provider.id)} title={providerLabel(provider)}
      description={String(provider.detail || provider.envName || '')}
      status={provider.authenticated ? 'Connected' : String(provider.status || 'Not connected')}
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
        confirm({ title: 'Forget provider authentication?', description: `Remove the saved authentication for ${providerLabel(provider)}.`,
          confirmLabel: 'Forget', danger: true, onConfirm: () => void run('forgetProviderAuth', [provider.id]) });
      }}>Forget</ActionButton>}</>} />) : <ListEmpty text="No API-key providers available." />}</Group>
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
    </React.Fragment>) : <ListEmpty text="No local providers available." />}</Group>
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
      <ResourceRow title="Status" description={String(flow.error || '')} status={String(flow.state || 'pending')} />
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
    <Group title="Servers"
      description={`${status.connectedCount || 0} connected · ${status.failedCount || 0} failed`}>
      {servers.length ? servers.map((server) => <ResourceRow key={String(server.name)} title={String(server.name)}
        description={`${server.transport || 'transport unknown'}${server.error ? ` · ${server.error}` : ''}`}
        meta={`${server.toolCount || 0} tools`}
        status={String(server.status || 'unknown')}
        actions={<ActionButton disabled={busy} onClick={() => void run('setMcpServerEnabled', [server.name, server.enabled === false])}>
          {server.enabled === false ? 'Enable' : 'Disable'}
        </ActionButton>} />) : <ListEmpty text="No MCP servers configured." />}
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
        : <ListEmpty text="No skills found." />}
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
          confirm({ title: 'Remove plugin?', description: `${label(plugin)} will be removed from Mixdog.`,
            confirmLabel: 'Remove', danger: true, onConfirm: () => void run('removePlugin', [plugin]) });
        }}><Trash2 size={13} /></ActionButton></>} />) : <ListEmpty text="No plugins installed." />}
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
      description={`${status.ruleCount || rules.length} rules · ${status.configMode || 'standalone'}`}>
      {rules.length ? rules.map((rule, index) => <ResourceRow key={String(rule.index ?? index)} title={`${rule.tool || '*'} → ${rule.action || 'ask'}`}
        description={String(rule.match || rule.reason || '')} status={rule.enabled === false ? 'Disabled' : 'Enabled'}
        actions={<ActionButton disabled={busy} onClick={() => void run('setHookRuleEnabled', [Number(rule.index ?? index), rule.enabled === false])}>
          {rule.enabled === false ? 'Enable' : 'Disable'}
        </ActionButton>} />) : <ListEmpty text="No hook rules configured." />}
    </Group>
  </>;
}

function MemoryPanel({ data, pending, run, confirm }: PanelContext) {
  const memory = record(data.memory);
  const busy = Boolean(pending);
  return <>
    <Group><ToggleRow title="Memory enabled" description="Enable memory recap and curated core memories."
      checked={memory.enabled !== false} disabled={busy} onChange={(enabled) => void run('setMemoryEnabled', [enabled])} /></Group>
    <section className="settings-group core-memory-section">
      <header><h3>Core memories</h3><p>User-curated memories shared across Mixdog sessions.</p></header>
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
      <header><b>Add memory</b><small>Save a durable fact or preference for future sessions.</small></header>
      <form className="core-memory-add" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const sentence = String(new FormData(form).get('sentence') || '').trim();
        if (!sentence) return;
        void mutate({ action: 'core', op: 'add', project_id: 'common', element: sentence, summary: sentence })
          .then((ok) => { if (ok) form.reset(); });
      }}><input name="sentence" aria-label="Memory to add" placeholder="What should Mixdog remember?" maxLength={2000} required />
        <button disabled={Boolean(pending)}>Add memory</button></form>
    </section>
    {entries.length ? <div className="core-memory-list">
      {entries.map((entry) => editing === entry.id ? <form className="core-memory-edit" key={entry.id} onSubmit={(event) => {
        event.preventDefault();
        const summary = String(new FormData(event.currentTarget).get('summary') || '').trim();
        if (!summary) return;
        const payload: RecordValue = { action: 'core', op: 'edit', id: entry.id, project_id: entry.projectId, summary };
        if (entry.singleSentence) payload.element = summary;
        void mutate(payload).then((ok) => { if (ok) setEditing(null); });
      }}><input name="summary" aria-label="Memory text" defaultValue={entry.summary} maxLength={2000} required autoFocus />
        <span className="core-memory-scope">{entry.projectId || 'Common'}</span>
        <div className="core-memory-actions"><button disabled={Boolean(pending)}>Save</button>
          <button type="button" onClick={() => setEditing(null)}>Cancel</button></div></form>
        : <div className="core-memory-row" key={entry.id}><div className="core-memory-copy"><b>{entry.summary}</b></div>
          <span className="core-memory-scope">{entry.projectId || 'Common'}</span>
          <div className="core-memory-actions"><button disabled={Boolean(pending)} onClick={() => setEditing(entry.id)}>Edit</button>
          <button className="danger" disabled={Boolean(pending)} onClick={() => {
            confirm({ title: 'Delete memory?', description: `Memory #${entry.id} will be removed permanently.`,
              confirmLabel: 'Delete', danger: true,
              onConfirm: () => void mutate({ action: 'core', op: 'delete', id: entry.id, project_id: entry.projectId }) });
          }}>Delete</button></div></div>)}
    </div> : <div className="core-memory-list core-memory-list--empty"><Empty text="No core memories yet." /></div>}
    {error && <p className="settings-field-error">{error}</p>}
  </div>;
}

function ChannelsPanel({ data, snapshot, pending, run, notice }: PanelContext) {
  const channels = record(data.channels);
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
    <Group title="Channel service">
      <ToggleRow title="Channels enabled" description={channels.enabled === false
        ? 'Discord, Telegram, schedules, and webhooks are disabled.'
        : 'Discord, Telegram, schedules, and webhooks are enabled.'}
        checked={channels.enabled !== false} disabled={busy}
        onChange={(enabled) => void run('setChannelsEnabled', [enabled])} />
      <SelectRow title="Channel" description="Primary outbound channel backend." value={backend} disabled={busy}
        options={[{ value: 'discord', label: 'Discord' }, { value: 'telegram', label: 'Telegram' }]}
        onChange={(value) => {
          optimisticBackend.current = value;
          setBackendChoice(value);
          void run('setBackend', [value], 'channel-backend', false).then((result) => {
            if (result === undefined) {
              optimisticBackend.current = null;
              setBackendChoice(persistedBackend);
              return;
            }
            const channelLabel = value === 'telegram' ? 'Telegram' : 'Discord';
            notice(data.remote === true || worker.running
              ? `Channel set to ${channelLabel}. Restart remote to apply.`
              : `Channel set to ${channelLabel}.`);
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
        value={String(channel.discordChannelId || (setup.backend !== 'telegram' ? channel.channelId || '' : ''))}
        placeholder="Discord channel ID" required disabled={busy}
        onSave={(channelId) => void run('setChannel', [{ backend: 'discord', channelId }])} />
    </Group>
    <Group title="Telegram">
      <SecretForm title="Telegram bot token" status={record(setup.telegram)} disabled={busy}
        onSave={(secret) => void run('saveTelegramToken', [secret])} />
      <AutoSaveRow title="Main chat" name="telegramChatId"
        value={String(channel.telegramChatId || (setup.backend === 'telegram' ? channel.channelId || '' : ''))}
        placeholder="Telegram chat ID" required disabled={busy}
        onSave={(channelId) => void run('setChannel', [{ backend: 'telegram', channelId }])} />
    </Group>
    <Group title="Webhook ingress">
      <SecretForm title="ngrok auth token" status={record(setup.webhook)} disabled={busy}
        onSave={(secret) => void run('saveWebhookAuthtoken', [secret])} />
      <AutoSaveRow title="ngrok domain" name="ngrokDomain"
        value={String(webhook.ngrokDomain || webhook.domain || '')}
        placeholder="my-app.ngrok-free.app" required disabled={busy}
        onSave={(ngrokDomain) => void run('setWebhookConfig', [{ ngrokDomain }])} />
    </Group>
  </>;
}

function SystemPanel(context: PanelContext) {
  const { data, pending, run } = context;
  const worker = record(data.channelWorker);
  const busy = Boolean(pending);
  return <>
    <Group>
      <ToggleRow title="Remote runtime" description={worker.running
        ? `Channel runtime running · PID ${worker.pid || '?'}`
        : 'Channel runtime stopped.'}
        checked={data.remote === true} disabled={busy} onChange={() => void run('toggleRemote')} />
    </Group>
    <UpdatePanel {...context} />
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
    description={String(status.problem || status.status || 'Not configured')} resetOnSubmit
    onSubmit={(form) => onSave(String(form.get('secret') || ''))}>
    <input name="secret" type="password" autoComplete="off" aria-label={title}
      placeholder={saved ? '••••••••  Saved' : 'Secret'} required disabled={disabled} />
    <button disabled={disabled}>{saved ? 'Replace' : 'Save'}</button>
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
      status={schedule.enabled === false ? 'Disabled' : 'Enabled'}
      actions={<ActionButton disabled={busy || !remoteEnabled} onClick={() => void run('setScheduleEnabled', [schedule.name, schedule.enabled === false])}>
        {schedule.enabled === false ? 'Enable' : 'Disable'}</ActionButton>} />) : <ListEmpty text="No schedules configured." />}
    </Group>
    <Group title="Webhook endpoints">{webhooks.length ? webhooks.map((webhook) => <ResourceRow key={String(webhook.name)} title={String(webhook.name)}
      description={`${webhook.parser || 'github'} · ${webhook.route || ''} · secret:${webhook.secretSet ? 'set' : 'missing'}${remoteEnabled ? '' : ' · channel off'}`}
      status={webhook.enabled === false ? 'Disabled' : 'Enabled'}
      actions={<ActionButton disabled={busy || !remoteEnabled} onClick={() => void run('setWebhookEnabled', [webhook.name, webhook.enabled === false])}>
        {webhook.enabled === false ? 'Enable' : 'Disable'}</ActionButton>} />) : <ListEmpty text="No webhook endpoints configured." />}
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
      {Boolean(status.phase) && <ResourceRow title="Update process" description={String(status.message || status.detail || '')}
        status={String(status.phase)} />}
    </Group>
    <Group title="Doctor"><ActionButton disabled={busy} onClick={() => void run('runDoctor')}>Run full diagnostics</ActionButton></Group>
    <Group title="Context status"><ContextStatusView value={data.context} /></Group>
    <Group title="Provider usage"><UsageDashboard value={data.usage} /></Group>
  </>;
}

function Empty({ text }: { text: string }) {
  return <p className="settings-empty">{text}</p>;
}

function ListEmpty({ text }: { text: string }) {
  return <p className="settings-empty settings-empty-list">{text}</p>;
}
