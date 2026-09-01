
import type {
  DesktopApi,
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopModelOption,
  DesktopReadCapability,
  DesktopUpdaterState,
  SessionSnapshot
} from '../../shared/contract';
import { providerDisplayName } from '../provider-display';
import { record } from '../record-utils';
import type { SettingsCategory } from './settings-items';

export type CapabilityCategory = SettingsCategory | 'builtins';

export type RecordValue = Record<string, unknown>;
export type CapabilityApi = Partial<Pick<DesktopApi,
  'invokeCapability' | 'readCapabilities' | 'listProviderModels' | 'setModelRoute' | 'setFast' | 'getSnapshot'
  | 'subscribeState' | 'getUpdaterState' | 'subscribeUpdaterState' | 'checkForDesktopUpdate'
  | 'showDesktopUpdate' | 'getRemoteAccessInfo' | 'rotateRemoteAccess' | 'revokeRemoteAccessClient'
  | 'readSettings' | 'updateSetting' | 'gitCliStatus' | 'installGitCli'
  | 'libreOfficeStatus' | 'installLibreOffice'>>;

export interface CapabilitySettingsProps {
  api: CapabilityApi;
  category: CapabilityCategory;
  refreshNonce?: number;
  onCompose?: (text: string) => void;
  onOpenCategory?: (category: SettingsCategory) => void;
  /** Extensions rail: the panel HEADER owns the create action, so the add
   *  form opens from outside the list instead of sitting permanently inside
   *  it. Hosts that never pass these keep the list-only rendering. */
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
}

export interface PanelContext {
  api: CapabilityApi;
  data: Record<string, unknown>;
  snapshot: SessionSnapshot;
  pending: string;
  run<T = unknown>(
    capability: DesktopCapability,
    args?: unknown[],
    key?: string,
    refresh?: boolean,
    silent?: boolean,
  ): Promise<T | undefined>;
  route(model: DesktopModelOption): Promise<void>;
  setFast(enabled: boolean): Promise<void>;
  confirm(options: SettingsConfirmation): void;
  notice(message: string, tone?: 'info' | 'warn'): void;
  updaterState: DesktopUpdaterState;
  checkDesktopUpdate(): Promise<void>;
  installDesktopUpdate(): Promise<void>;
  compose?: (text: string) => void;
  openCategory?: (category: SettingsCategory) => void;
  /** Create-form disclosure driven by the host's header action. */
  createOpen?: boolean;
  closeCreate?(): void;
}

export interface SettingsConfirmation {
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm(): void | Promise<void>;
}

// Ordered by what the user sees first, cheapest first: the sweep runs in
// chunks and paints as each returns, so a slow getter (channel setup probes a
// live worker) belongs at the end instead of blocking the opening screen.
export const SECTION_READS: ReadonlyArray<readonly [string, DesktopCapability, unknown[]?]> = [
  ['profile', 'getProfile'], ['theme', 'getTheme'], ['autoClear', 'getAutoClear'],
  ['compaction', 'getCompactionSettings'],
  ['outputStyles', 'listOutputStyles'], ['providerSetup', 'getProviderSetup'],
  ['recap', 'getRecapSettings'], ['toolModules', 'getToolModuleSettings'], ['update', 'getUpdateSettings'],
  ['updateStatus', 'getUpdateStatus'], ['mcp', 'mcpStatus'], ['plugins', 'pluginsStatus'],
  ['skills', 'skillsStatus'], ['disabledSkills', 'getDisabledSkills'],
  ['voice', 'getVoiceStatus'],
];

export interface CachedCapabilitySettings {
  data: Record<string, unknown>;
  error: string;
  loadedAt: number;
}

/** Keys whose read has landed. Panels use it to tell "nothing configured"
 *  apart from "not loaded yet" while the slower reads are still in flight. */
const LOADED_SECTIONS_KEY = '__loadedSections';

export function sectionLoaded(data: Record<string, unknown>, key: string): boolean {
  const loaded = data[LOADED_SECTIONS_KEY];
  return Array.isArray(loaded) ? loaded.includes(key) : Boolean(data[key]);
}

/** A failed section keeps its reason so the panel can say what went wrong
 *  instead of pretending the surface is empty. */
export function sectionError(data: Record<string, unknown>, key: string): string {
  if (sectionLoaded(data, key)) return '';
  const value = data[key];
  const error = value && typeof value === 'object' ? (value as Record<string, unknown>).error : null;
  return typeof error === 'string' ? error : '';
}

// Small enough that a slow getter only holds back its own group, large enough
// that the whole sweep is still a handful of IPC round-trips.
const READ_BATCH_SIZE = 4;

// Opt-in tracing for the settings sweep (localStorage.mixdogSettingsDebug='1'):
// hydration bugs are timing-shaped and otherwise invisible in a packaged app.
function trace(event: string, detail: Record<string, unknown> = {}): void {
  try {
    if (window.localStorage.getItem('mixdogSettingsDebug') !== '1') return;
    const host = window as unknown as { __mixdogSettingsTrace?: unknown[] };
    host.__mixdogSettingsTrace ??= [];
    host.__mixdogSettingsTrace.push({ at: Date.now(), event, ...detail });
  } catch { /* tracing never breaks settings */ }
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
  onPartial?: (data: Record<string, unknown>) => void,
): Promise<CachedCapabilitySettings> {
  if (!api.invokeCapability && !api.readCapabilities) {
    return { data: previous?.data || {}, error: '', loadedAt: Date.now() };
  }
  const next: Record<string, unknown> = { ...(previous?.data || {}) };
  let loadError = '';
  const loadedSections = new Set<string>(
    Array.isArray(previous?.data[LOADED_SECTIONS_KEY]) ? previous.data[LOADED_SECTIONS_KEY] as string[] : [],
  );
  // A read that failed (engine still booting on the very first open) must not
  // cache as an authoritative "nothing configured": it stays unloaded so the
  // panel keeps its loading state, and the sweep retries it once at the end.
  const failed = new Set<string>();
  // Publish every read the moment it lands: a slow one (provider secrets, the
  // full model catalog) must never keep the whole panel on empty values.
  const publish = (key: string, value: unknown, ok = true) => {
    next[key] = value;
    trace('publish', { key, ok });
    if (ok) {
      loadedSections.add(key);
      failed.delete(key);
    } else {
      loadedSections.delete(key);
      failed.add(key);
    }
    next[LOADED_SECTIONS_KEY] = [...loadedSections];
    onPartial?.({ ...next });
  };
  const prepared = SECTION_READS.map(([key, capability, args = []]) => ({
    key,
    request: {
      capability: capability as DesktopReadCapability,
      args: force && capability === 'listWebSearchModels'
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
        publish(key, (await api.invokeCapability!({
          capability: request.capability,
          args: request.args,
        }))?.value);
      } catch (reason) {
        publish(key, { error: reason instanceof Error ? reason.message : String(reason) }, false);
      }
    }));
  };
  const loadReads = async () => {
    if (!api.readCapabilities) {
      await readIndividually();
      return;
    }
    // The engine runs a batch as one ordered sweep, so a single batch only
    // lands when its slowest getter finishes. Sending several small batches in
    // order keeps that sweep semantics while letting each group paint as soon
    // as it returns.
    try {
      for (let index = 0; index < prepared.length; index += READ_BATCH_SIZE) {
        const chunk = prepared.slice(index, index + READ_BATCH_SIZE);
        trace('chunk-start', { keys: chunk.map((entry) => entry.key) });
        const results = await api.readCapabilities(chunk.map((entry) => entry.request));
        trace('chunk-done', { keys: chunk.map((entry) => entry.key), ok: results.map((entry) => entry?.ok === true) });
        chunk.forEach((entry, position) => {
          const result = results[position];
          publish(entry.key, result?.ok
            ? result.value
            : { error: result && 'error' in result ? result.error : 'Capability read did not return a result.' },
          result?.ok === true);
        });
      }
    } catch (reason) {
      trace('chunk-failed', { error: reason instanceof Error ? reason.message : String(reason) });
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
        publish('models', await api.listProviderModels?.({
          quick: false,
        }) || []);
      } catch (reason) {
        publish('models', previous?.data.models || []);
        loadError = reason instanceof Error ? reason.message : String(reason);
      }
    })(),
    api.getSnapshot?.().then((snapshot) => publish('snapshot', snapshot || null))
      .catch(() => publish('snapshot', previous?.data.snapshot || null)) || Promise.resolve(),
  ]);
  // One bounded retry for whatever failed while the engine was still coming up,
  // so a transient boot error never leaves a section permanently "empty".
  if (failed.size > 0 && api.invokeCapability) {
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    await Promise.all([...failed].map(async (key) => {
      const entry = prepared.find((candidate) => candidate.key === key);
      if (!entry) return;
      try {
        publish(key, (await api.invokeCapability!({
          capability: entry.request.capability,
          args: entry.request.args,
        }))?.value);
      } catch {
        // Keep the failure visible as a loading section rather than as "none".
      }
    }));
  }
  return { data: next, error: loadError, loadedAt: Date.now() };
}

export function preloadCapabilitySettings(
  api: CapabilityApi,
  force = false,
  onPartial?: (data: Record<string, unknown>) => void,
): Promise<CachedCapabilitySettings> {
  const entry = settingsCacheEntry(api);
  if (entry.inFlight) {
    // A second opener joins the in-flight sweep. Cold partials stay private:
    // exposing them as cache entries made rows pop into the dialog in batches.
    return entry.inFlight;
  }
  if (entry.value && !force) return Promise.resolve(entry.value);
  const request = readAllCapabilitySettings(api, force, entry.value, (partial) => {
    onPartial?.(partial);
  });
  entry.inFlight = request;
  void request.then((value) => {
    entry.value = value;
    if (entry.inFlight === request) entry.inFlight = undefined;
  }, () => {
    if (entry.inFlight === request) entry.inFlight = undefined;
  });
  return request;
}

export function rows(value: unknown, ...keys: string[]): RecordValue[] {
  if (Array.isArray(value)) return value.map(record);
  const source = record(value);
  for (const key of keys) {
    if (Array.isArray(source[key])) return (source[key] as unknown[]).map(record);
  }
  return [];
}

export function bool(value: unknown, fallback = true): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function label(value: unknown, fallback = 'Unknown'): string {
  const item = record(value);
  return String(item.label || item.title || item.name || item.display || item.id || fallback);
}

export function providerLabel(value: unknown, fallback = 'Unknown provider'): string {
  const item = record(value);
  if (item.name || item.label) return String(item.name || item.label);
  const provider = String(item.id || item.provider || '');
  return provider ? providerDisplayName(provider) : label(item, fallback);
}

export function count(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Intl.NumberFormat().format(numeric) : String(value ?? '—');
}

export function formatDuration(value: unknown): string {
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

export function durationTextInput(value: unknown): string {
  const milliseconds = Math.max(0, Math.round(Number(value) || 0));
  if (milliseconds > 0 && milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000}h`;
  if (milliseconds > 0 && milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  if (milliseconds > 0 && milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
}
