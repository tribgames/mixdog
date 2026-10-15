import type {
  DesktopApi,
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopModelOption,
  DesktopReadCapability,
  DesktopUpdaterState,
  SessionSnapshot,
} from '../../shared/contract';
import { DESKTOP_READ_CAPABILITIES } from '../../shared/contract';
import { providerDisplayName } from '../provider-display';
import { fetchProviderModels } from '../model-catalog-cache';
import { t, uiFormatLocale } from '../i18n';
import { uiTimeUnit } from '../ui-format';
import { record } from '../record-utils';
import type { SettingsCategory } from './settings-items';
import { errorMessage } from '../editor-pane-session-errors';

export type CapabilityCategory = SettingsCategory | 'builtins';

export type RecordValue = Record<string, unknown>;
export type CapabilityApi = Partial<
  Pick<
    DesktopApi,
    | 'invokeCapability'
    | 'readCapabilities'
    | 'listProviderModels'
    | 'setModelRoute'
    | 'setFast'
    | 'getSnapshot'
    | 'subscribeState'
    | 'getUpdaterState'
    | 'subscribeUpdaterState'
    | 'checkForDesktopUpdate'
    | 'showDesktopUpdate'
    | 'getRemoteAccessInfo'
    | 'rotateRemoteAccess'
    | 'revokeRemoteAccessClient'
    | 'listRemoteHosts'
    | 'connectRemoteHostByCode'
    | 'getRemotePairCode'
    | 'openRemoteHost'
    | 'forgetRemoteHost'
    | 'renameRemoteHost'
    | 'sshListHosts'
    | 'sshRenameHost'
    | 'sshForgetHost'
    | 'sshOpenHost'
    | 'sshConfigHosts'
    | 'sshInspectHostKey'
    | 'sshConnect'
    | 'sshCancel'
    | 'sshAskpassReply'
    | 'sshCleanupHost'
    | 'sshUpdateHostSettings'
    | 'subscribeSshAskpass'
    | 'subscribeSshCleanupProgress'
    | 'sshDiagnosticsLog'
    | 'sshDiagnosticsCopy'
    | 'sshServerLog'
    | 'subscribeSshProgress'
    | 'getRemoteAccessSettings'
    | 'setRemoteAccessEnabled'
    | 'setRemotePcName'
    | 'setRemoteClientAlias'
    | 'subscribeRemoteAccessSettings'
    | 'readSettings'
    | 'updateSetting'
    | 'gitCliStatus'
    | 'installGitCli'
    | 'libreOfficeStatus'
    | 'installLibreOffice'
    | 'computerReadiness'
    | 'requestLinuxInputAccess'
    | 'openComputerPermissionSettings'
  >
>;

export interface CapabilitySettingsProps {
  api: CapabilityApi;
  category: CapabilityCategory;
  refreshNonce?: number;
  /** False while the host keeps the panel mounted but hidden (prewarm):
   *  it adopts the shared sweep and re-reads only once shown. */
  active?: boolean;
  onCompose?: (text: string) => void;
  onOpenCategory?: (category: SettingsCategory) => void;
  /** Extensions rail: the panel HEADER owns the create action, so the add
   *  form opens from outside the list instead of sitting permanently inside
   *  it. Hosts that never pass these keep the list-only rendering. */
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
  /** Sidebar hosts: confirmations render into document.body, because the
   *  sidebar clips fixed layers to itself. */
  portalConfirm?: boolean;
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
    errorMode?: 'toast' | 'throw'
  ): Promise<T | undefined>;
  /** Re-read just the plugin/skill/MCP sections, without a full sweep. */
  refreshExtensions(): Promise<void>;
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
  ['profile', 'getProfile'],
  ['theme', 'getTheme'],
  ['autoClear', 'getAutoClear'],
  ['compaction', 'getCompactionSettings'],
  ['outputStyles', 'listOutputStyles'],
  ['providerSetup', 'getProviderSetup'],
  ['recap', 'getRecapSettings'],
  ['sessionTitles', 'getSessionTitleSettings'],
  ['toolModules', 'getToolModuleSettings'],
  ['update', 'getUpdateSettings'],
  ['updateStatus', 'getUpdateStatus'],
  ['mcp', 'mcpStatus'],
  ['plugins', 'pluginsStatus'],
  ['skills', 'skillsStatus'],
  ['disabledSkills', 'getDisabledSkills'],
  ['voice', 'getVoiceStatus'],
  ['developer', 'getDeveloperSettings'],
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
  } catch {
    /* tracing never breaks settings */
  }
}

interface CapabilitySettingsCacheEntry {
  value?: CachedCapabilitySettings;
  inFlight?: Promise<CachedCapabilitySettings>;
  /** Bumped by every resolved settings mutation. A sweep reflects only the
   *  epoch it started in: its reads may have been answered before the write. */
  epoch: number;
  /** Epoch the in-flight sweep started in. */
  inFlightEpoch: number;
  /** Epoch the cached value was read in; behind `epoch` means stale. */
  valueEpoch: number;
  /** Sweep order, so an older sweep that lands late never replaces a newer one. */
  sweeps: number;
  adoptedSweep: number;
  /** Shared ordering clock for sweeps and section refreshes. */
  clock: number;
  /** Section values refreshed on their own, with the clock tick their read
   *  started at: a sweep that started earlier must not overwrite them. */
  sections: Map<string, { value: unknown; startedAt: number }>;
  /** Per section key, the clock tick of the newest value that landed from
   *  either a full sweep or a section refresh; older results are dropped. */
  landedAt: Map<string, number>;
}

const CAPABILITY_SETTINGS_CACHE = new WeakMap<object, CapabilitySettingsCacheEntry>();

function settingsCacheEntry(api: CapabilityApi): CapabilitySettingsCacheEntry {
  const key = api as object;
  const cached = CAPABILITY_SETTINGS_CACHE.get(key);
  if (cached) return cached;
  const created: CapabilitySettingsCacheEntry = {
    epoch: 0,
    inFlightEpoch: 0,
    valueEpoch: 0,
    sweeps: 0,
    adoptedSweep: 0,
    clock: 0,
    sections: new Map(),
    landedAt: new Map(),
  };
  CAPABILITY_SETTINGS_CACHE.set(key, created);
  return created;
}

const READ_CAPABILITY_SET = new Set<string>(DESKTOP_READ_CAPABILITIES);

/** A settings write resolved (`capability` omitted: one made outside the
 *  capability channel): neither the cached sweep nor one still in flight may
 *  answer the next load — both can hold the value from before the write, which
 *  kept a toggle showing its old state until a full reload. Reads change nothing. */
export function invalidateCapabilitySettings(api: CapabilityApi, capability?: DesktopCapability): void {
  if (capability && READ_CAPABILITY_SET.has(capability)) return;
  settingsCacheEntry(api).epoch += 1;
}

export function getCachedCapabilitySettings(api: CapabilityApi): CachedCapabilitySettings | undefined {
  return CAPABILITY_SETTINGS_CACHE.get(api as object)?.value;
}

async function readAllCapabilitySettings(
  api: CapabilityApi,
  force: boolean,
  previous?: CachedCapabilitySettings,
  onPartial?: (data: Record<string, unknown>) => void
): Promise<CachedCapabilitySettings> {
  if (!api.invokeCapability && !api.readCapabilities) {
    return { data: previous?.data || {}, error: '', loadedAt: Date.now() };
  }
  const next: Record<string, unknown> = { ...(previous?.data || {}) };
  let loadError = '';
  const loadedSections = new Set<string>(
    Array.isArray(previous?.data[LOADED_SECTIONS_KEY]) ? (previous.data[LOADED_SECTIONS_KEY] as string[]) : []
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
  const prepared = SECTION_READS.map(([key, capability, args = []]) => {
    const readArgs: unknown[] = force && capability === 'getProviderSetup' ? [{ refresh: true }] : [...args];
    return {
      key,
      request: {
        capability: capability as DesktopReadCapability,
        args: readArgs,
      } satisfies DesktopCapabilityReadRequest,
    };
  });
  const readIndividually = async () => {
    if (!api.invokeCapability) return;
    await Promise.all(
      prepared.map(async ({ key, request }) => {
        try {
          publish(
            key,
            (
              await api.invokeCapability!({
                capability: request.capability,
                args: request.args,
              })
            )?.value
          );
        } catch (reason) {
          publish(key, { error: errorMessage(reason) }, false);
        }
      })
    );
  };
  const loadReads = async () => {
    if (!api.readCapabilities) {
      await readIndividually();
      return;
    }
    // The engine runs a batch as one ordered sweep, so a single batch only
    // lands when its slowest getter finishes. Small batches keep that sweep
    // semantics per group; the groups themselves go out TOGETHER (user: 설정값
    // 반응성) — sending them one after another let a slow getter (provider
    // setup, MCP/plugin/skill status) hold back every group queued behind it.
    try {
      const chunks: (typeof prepared)[] = [];
      for (let index = 0; index < prepared.length; index += READ_BATCH_SIZE) {
        chunks.push(prepared.slice(index, index + READ_BATCH_SIZE));
      }
      await Promise.all(
        chunks.map(async (chunk) => {
          trace('chunk-start', { keys: chunk.map((entry) => entry.key) });
          const results = await api.readCapabilities!(chunk.map((entry) => entry.request));
          trace('chunk-done', {
            keys: chunk.map((entry) => entry.key),
            ok: results.map((entry) => entry?.ok === true),
          });
          chunk.forEach((entry, position) => {
            const result = results[position];
            const failure = result && 'error' in result ? result.error : t('Capability read did not return a result.');
            publish(entry.key, result?.ok ? result.value : { error: failure }, result?.ok === true);
          });
        })
      );
    } catch (reason) {
      trace('chunk-failed', { error: errorMessage(reason) });
      if (api.invokeCapability) {
        await readIndividually();
      } else {
        loadError = errorMessage(reason);
      }
    }
  };
  await Promise.all([
    loadReads(),
    (async () => {
      try {
        // One catalog fetch shared with the route picker and sidebar; an
        // explicit settings refresh still goes to the daemon.
        publish('models', await fetchProviderModels(api, { quick: false, force }));
      } catch (reason) {
        publish('models', previous?.data.models || []);
        loadError = errorMessage(reason);
      }
    })(),
    api
      .getSnapshot?.()
      .then((snapshot) => publish('snapshot', snapshot || null))
      .catch(() => publish('snapshot', previous?.data.snapshot || null)) || Promise.resolve(),
  ]);
  // One bounded retry for whatever failed while the engine was still coming up,
  // so a transient boot error never leaves a section permanently "empty".
  if (failed.size > 0 && api.invokeCapability) {
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    await Promise.all(
      [...failed].map(async (key) => {
        const entry = prepared.find((candidate) => candidate.key === key);
        if (!entry) return;
        try {
          publish(
            key,
            (
              await api.invokeCapability!({
                capability: entry.request.capability,
                args: entry.request.args,
              })
            )?.value
          );
        } catch {
          // Keep the failure visible as a loading section rather than as "none".
        }
      })
    );
  }
  return { data: next, error: loadError, loadedAt: Date.now() };
}

export function preloadCapabilitySettings(
  api: CapabilityApi,
  force = false,
  onPartial?: (data: Record<string, unknown>) => void
): Promise<CachedCapabilitySettings> {
  const entry = settingsCacheEntry(api);
  if (entry.inFlight && entry.inFlightEpoch === entry.epoch) {
    // A second opener joins the in-flight sweep. Cold partials stay private:
    // exposing them as cache entries made rows pop into the dialog in batches.
    return entry.inFlight;
  }
  if (entry.value && !force && entry.valueEpoch === entry.epoch) return Promise.resolve(entry.value);
  const epoch = entry.epoch;
  const sweep = ++entry.sweeps;
  const startedAt = ++entry.clock;
  const request = readAllCapabilitySettings(api, force, entry.value, (partial) => {
    onPartial?.(partial);
  }).then((value) => {
    // Sections refreshed after this sweep began are newer than its reads.
    const newer = [...entry.sections].filter(([, section]) => section.startedAt > startedAt);
    return newer.length
      ? {
          ...value,
          data: applySectionRefresh(
            value.data,
            Object.fromEntries(newer.map(([key, section]) => [key, section.value]))
          ),
        }
      : value;
  });
  entry.inFlight = request;
  entry.inFlightEpoch = epoch;
  void request.then(
    (value) => {
      if (sweep > entry.adoptedSweep) {
        entry.value = value;
        entry.valueEpoch = epoch;
        entry.adoptedSweep = sweep;
        for (const [key] of SECTION_READS) {
          if ((entry.landedAt.get(key) ?? 0) < startedAt) entry.landedAt.set(key, startedAt);
        }
      }
      if (entry.inFlight === request) entry.inFlight = undefined;
    },
    () => {
      if (entry.inFlight === request) entry.inFlight = undefined;
    }
  );
  return request;
}

/** Sections a plugin/skill/MCP change can touch. */
export const EXTENSION_SECTIONS = ['plugins', 'skills', 'disabledSkills', 'mcp'] as const;

/** Overlay refreshed sections onto a settings data object and mark them loaded. */
export function applySectionRefresh(
  data: Record<string, unknown>,
  sections: Record<string, unknown>
): Record<string, unknown> {
  const loaded = new Set<string>(
    Array.isArray(data[LOADED_SECTIONS_KEY]) ? (data[LOADED_SECTIONS_KEY] as string[]) : []
  );
  for (const key of Object.keys(sections)) loaded.add(key);
  return { ...data, ...sections, [LOADED_SECTIONS_KEY]: [...loaded] };
}

/** Re-read only the given sections (no full sweep) and merge them into the
 *  shared cache. Resolves with the sections that landed; a failed read keeps
 *  the previous value. A read superseded by a newer one for the same key is
 *  dropped, and a full sweep that started earlier never overwrites the result. */
export async function refreshCapabilitySections(
  api: CapabilityApi,
  keys: readonly string[]
): Promise<Record<string, unknown>> {
  const entry = settingsCacheEntry(api);
  const wanted = SECTION_READS.filter(([key]) => keys.includes(key));
  if (!wanted.length || (!api.readCapabilities && !api.invokeCapability)) return {};
  const startedAt = ++entry.clock;
  const requests = wanted.map(([, capability, args = []]) => ({
    capability: capability as DesktopReadCapability,
    args: [...args],
  })) satisfies DesktopCapabilityReadRequest[];
  const landed: Record<string, unknown> = {};
  const land = (key: string, value: unknown) => {
    if ((entry.landedAt.get(key) ?? 0) > startedAt) return;
    entry.landedAt.set(key, startedAt);
    entry.sections.set(key, { value, startedAt });
    landed[key] = value;
  };
  const individually = async () => {
    await Promise.all(
      wanted.map(async ([key], position) => {
        try {
          land(key, (await api.invokeCapability!(requests[position]))?.value);
        } catch {
          /* keep the previous section value */
        }
      })
    );
  };
  if (api.readCapabilities) {
    try {
      const results = await api.readCapabilities(requests);
      wanted.forEach(([key], position) => {
        const result = results[position];
        if (result?.ok) land(key, result.value);
      });
    } catch {
      if (api.invokeCapability) await individually();
    }
  } else {
    await individually();
  }
  if (entry.value && Object.keys(landed).length) {
    entry.value = { ...entry.value, data: applySectionRefresh(entry.value.data, landed) };
  }
  return landed;
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

export function label(value: unknown, fallback = t('Unknown')): string {
  const item = record(value);
  return String(item.label || item.title || item.name || item.display || item.id || fallback);
}

export function providerLabel(value: unknown, fallback = t('Unknown provider')): string {
  const item = record(value);
  if (item.name || item.label) return String(item.name || item.label);
  const provider = String(item.id || item.provider || '');
  return provider ? providerDisplayName(provider) : label(item, fallback);
}

export function count(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Intl.NumberFormat(uiFormatLocale()).format(numeric) : String(value ?? '—');
}

export function formatDuration(value: unknown): string {
  if (!Number.isFinite(Number(value))) return '';
  const milliseconds = Math.max(0, Number(value) || 0);
  if (milliseconds < 60_000) {
    if (milliseconds < 1_000) return '';
    return uiTimeUnit(Math.floor(milliseconds / 1_000), 'second');
  }
  const days = Math.floor(milliseconds / 86_400_000);
  const hours = Math.floor((milliseconds % 86_400_000) / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  if (days > 0) return `${uiTimeUnit(days, 'day')} ${uiTimeUnit(hours, 'hour')} ${uiTimeUnit(minutes, 'minute')}`;
  if (hours > 0)
    return `${uiTimeUnit(hours, 'hour')} ${uiTimeUnit(minutes, 'minute')} ${uiTimeUnit(seconds, 'second')}`;
  return `${uiTimeUnit(minutes, 'minute')} ${uiTimeUnit(seconds, 'second')}`;
}

export function durationTextInput(value: unknown): string {
  const milliseconds = Math.max(0, Math.round(Number(value) || 0));
  if (milliseconds > 0 && milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000}h`;
  if (milliseconds > 0 && milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  if (milliseconds > 0 && milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
}
