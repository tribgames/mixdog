import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeJsonAtomicSync } from '../../../../src/runtime/shared/atomic-file.mjs';

import {
  NOTIFICATION_VOLUME_DEFAULT,
  NOTIFICATION_VOLUME_MAX,
  type DesktopSettingKey,
  type DesktopSettings,
} from '../shared/contract';
import {
  DEFAULT_ACTIVITY_RAIL_PINS,
  normalizeActivityRailPins,
  readActivityRailPinsState,
  type ActivityRailPinsState,
} from '../shared/activity-rail-pins';
import { packagedRuntimeSourceRoot } from './runtime-layout';

export interface MixdogConfigModule {
  readConfig(): unknown;
  updateConfigAsync(updater: (current: Record<string, unknown>) => Record<string, unknown>): Promise<unknown>;
  /** Persisted config changes from this process or another; absent on an older daemon. */
  subscribeConfigChange?(listener: () => void): () => void;
}

interface DesktopSettingsStoreOptions {
  packaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  loadConfig?: () => Promise<MixdogConfigModule>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function settingsConfigModuleUrl(
  packaged = false,
  resourcesPath = process.resourcesPath,
  appPath = process.cwd()
): string {
  const configPath = packaged
    ? join(packagedRuntimeSourceRoot(resourcesPath), 'runtime', 'shared', 'config.mjs')
    : resolve(appPath, '../../src/runtime/shared/config.mjs');
  return pathToFileURL(configPath).href;
}

export function isNotificationVolume(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= NOTIFICATION_VOLUME_MAX;
}

export function desktopSettingsFromConfig(value: unknown): DesktopSettings {
  const config = record(value);
  const agent = record(config.agent);
  const autoClear = record(agent.autoClear);
  const compaction = record(agent.compaction);
  const desktop = record(config.desktop);
  return {
    autoClear: autoClear.enabled !== false,
    autoCompact: compaction.auto !== false && compaction.enabled !== false,
    keepAwake: desktop.keepAwake !== false,
    runInBackground: desktop.runInBackground !== false,
    notificationVolume: isNotificationVolume(desktop.notificationVolume)
      ? desktop.notificationVolume
      : NOTIFICATION_VOLUME_DEFAULT,
    // A fresh install starts pinned; an explicit unpin is kept.
    usagePinned: desktop.usagePinned !== false,
    usageRailShortLong: desktop.usageRailShortLong === true,
    usageAccountsExpanded: desktop.usageAccountsExpanded === true,
    usageRailSlotsThree: desktop.usageRailSlotsThree === true,
    usageRailSlotsAll: desktop.usageRailSlotsAll === true,
    computerControl: desktop.computerControl === true,
    computerObserveOnly: desktop.computerObserveOnly === true,
    browserControl: desktop.browserControl === true,
    browserAutoSignIn: desktop.browserAutoSignIn !== false,
    saveChatLogins: desktop.saveChatLogins !== false,
    // Grandfather: a control that is already on predates the install marker.
    computerInstalled: desktop.computerInstalled === true || desktop.computerControl === true,
    browserInstalled: desktop.browserInstalled === true || desktop.browserControl === true,
  };
}

/** Settings persisted as a plain `desktop.<key>` boolean, with no companion
 *  field to reconcile. */
const DESKTOP_FLAG_KEYS: ReadonlySet<DesktopSettingKey> = new Set([
  'keepAwake',
  'runInBackground',
  'usagePinned',
  'usageRailShortLong',
  'usageAccountsExpanded',
  'usageRailSlotsThree',
  'usageRailSlotsAll',
  'computerObserveOnly',
  'browserAutoSignIn',
  'saveChatLogins',
  'computerInstalled',
  'browserInstalled',
]);

/** Code defaults of the user-facing `desktop.<key>` toggles; storage holds
 *  only a value that differs. Install markers are system state: no default. */
export const DESKTOP_FLAG_DEFAULTS: Readonly<Partial<Record<DesktopSettingKey, boolean>>> = {
  keepAwake: true,
  runInBackground: true,
  usagePinned: true,
  usageRailShortLong: false,
  usageAccountsExpanded: false,
  usageRailSlotsThree: false,
  usageRailSlotsAll: false,
  computerControl: false,
  computerObserveOnly: false,
  browserControl: false,
  browserAutoSignIn: true,
  saveChatLogins: true,
};

/** Marker in the `desktop` section: the one-time defaults separation ran. */
export const DEFAULTS_SEPARATION_MARKER = 'defaultsSeparationVersion';
const DEFAULTS_SEPARATION_VERSION = 1;
/** Every activity-rail default list ever shipped (order matters). */
const HISTORICAL_ACTIVITY_RAIL_PINS: readonly (readonly string[])[] = [
  ['sessions', 'agents', 'schedules', 'workflows', 'projects'],
  ['sessions', 'agents', 'schedules', 'workflows', 'projects', 'extensions'],
  DEFAULT_ACTIVITY_RAIL_PINS,
];

function withFlag(desktop: Record<string, unknown>, key: DesktopSettingKey, enabled: boolean): Record<string, unknown> {
  const next = { ...desktop };
  if (DESKTOP_FLAG_DEFAULTS[key] === enabled) delete next[key];
  else next[key] = enabled;
  return next;
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/** Stored pins: a full state, or a revision alone meaning the default list. */
function storedPinsState(value: unknown): ActivityRailPinsState | null {
  const full = readActivityRailPinsState(value);
  if (full) return full;
  const stored = record(value);
  if (Object.hasOwn(stored, 'pins')) return null;
  const revision = stored.revision;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0
    ? { pins: [...DEFAULT_ACTIVITY_RAIL_PINS], revision }
    : null;
}

/** Write the pre-image to a fresh backup directory; an existing one is never reused. */
function backupPreImage(dataDir: string, now: Date, preImage: unknown): void {
  const root = join(dataDir, 'backups');
  mkdirSync(root, { recursive: true });
  const base = `defaults-separation-${now.toISOString().replace(/[:.]/g, '-')}`;
  for (let attempt = 0; ; attempt += 1) {
    const dir = join(root, attempt ? `${base}-${attempt}` : base);
    try {
      mkdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    // The directory is new, so nothing is replaced; the copy is flushed whole
    // before it appears under its name.
    writeJsonAtomicSync(join(dir, 'mixdog-config.json'), preImage);
    return;
  }
}

export class DesktopSettingsStore {
  private readonly loadConfig: () => Promise<MixdogConfigModule>;

  constructor({
    packaged = false,
    resourcesPath = process.resourcesPath,
    appPath = process.cwd(),
    loadConfig,
  }: DesktopSettingsStoreOptions = {}) {
    this.loadConfig =
      loadConfig ??
      (async () =>
        import(
          /* @vite-ignore */ settingsConfigModuleUrl(packaged, resourcesPath, appPath)
        ) as Promise<MixdogConfigModule>);
  }

  async read(): Promise<DesktopSettings> {
    const config = await this.loadConfig();
    return desktopSettingsFromConfig(config.readConfig());
  }

  async readActivityRailPins(): Promise<ActivityRailPinsState | null> {
    const config = await this.loadConfig();
    return storedPinsState(record(record(config.readConfig()).desktop).activityRailPins);
  }

  async updateActivityRailPins(value: unknown, initializeIfMissing = false): Promise<ActivityRailPinsState> {
    const pins = normalizeActivityRailPins(value);
    if (!pins) throw new TypeError('Activity rail pins must be an array of supported destinations.');
    if (typeof initializeIfMissing !== 'boolean') throw new TypeError('initializeIfMissing must be a boolean.');
    const config = await this.loadConfig();
    const saved = await config.updateConfigAsync((current) => {
      const desktop = record(current.desktop);
      const previous = storedPinsState(desktop.activityRailPins);
      if (initializeIfMissing && previous) return current;
      const revision = (previous?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new RangeError('Activity rail pin revision is exhausted.');
      // The default list is never stored; the revision alone keeps ordering.
      const stored = sameList(pins, DEFAULT_ACTIVITY_RAIL_PINS) ? { revision } : { pins, revision };
      return { ...current, desktop: { ...desktop, activityRailPins: stored } };
    });
    const state = storedPinsState(record(record(saved).desktop).activityRailPins);
    if (!state) throw new TypeError('The config write did not return valid activity rail pins.');
    return state;
  }

  async update(key: DesktopSettingKey, enabled: boolean): Promise<DesktopSettings> {
    const config = await this.loadConfig();
    const saved = await config.updateConfigAsync((current) => {
      const next = { ...record(current) };
      const agent = { ...record(next.agent) };
      if (key === 'autoClear') {
        const autoClear: Record<string, unknown> = { ...record(agent.autoClear), enabled };
        // On is the code default: storage keeps only an explicit off.
        if (enabled) delete autoClear.enabled;
        if (Object.keys(autoClear).length) agent.autoClear = autoClear;
        else delete agent.autoClear;
      } else if (key === 'autoCompact') {
        const compaction: Record<string, unknown> = {
          ...record(agent.compaction),
          auto: enabled,
        };
        if (!compaction.summaryModel && compaction.semanticModel) {
          compaction.summaryModel = compaction.semanticModel;
        }
        if (!compaction.memoryTimeoutMs && compaction.recallMemoryTimeoutMs) {
          compaction.memoryTimeoutMs = compaction.recallMemoryTimeoutMs;
        }
        // `enabled` was an old alias. Remove it so it cannot override the
        // canonical `auto` field when a legacy config is switched back on.
        for (const legacyKey of [
          'enabled',
          'type',
          'compactType',
          'compact_type',
          'semantic',
          'semanticModel',
          'prune',
          'tailTurns',
          'recallMemoryTimeoutMs',
          'recallIngestLimit',
          'recallChunkLimit',
          'recallLimit',
          'recallCycle1BatchSize',
          'recallRowsPerSession',
          'recallWindowSize',
          'recallConcurrency',
          'recallCycle1DeadlineMs',
        ]) {
          delete compaction[legacyKey];
        }
        if (enabled) delete compaction.auto;
        if (Object.keys(compaction).length) agent.compaction = compaction;
        else delete agent.compaction;
      } else if (DESKTOP_FLAG_KEYS.has(key)) {
        next.desktop = withFlag(record(next.desktop), key, enabled);
      } else if (key === 'computerControl') {
        const desktop = { ...record(next.desktop) };
        // A pre-marker profile is considered installed while its control is
        // on. Persist that grandfathered fact BEFORE turning it off so OFF
        // never turns back into Install.
        if (desktop.computerInstalled === true || desktop.computerControl === true) {
          desktop.computerInstalled = true;
        }
        next.desktop = withFlag(desktop, 'computerControl', enabled);
      } else if (key === 'browserControl') {
        const desktop = { ...record(next.desktop) };
        if (desktop.browserInstalled === true || desktop.browserControl === true) {
          desktop.browserInstalled = true;
        }
        next.desktop = withFlag(desktop, 'browserControl', enabled);
      }
      next.agent = agent;
      return next;
    });
    return desktopSettingsFromConfig(saved);
  }

  async updateNotificationVolume(volume: number): Promise<DesktopSettings> {
    if (!isNotificationVolume(volume)) throw new TypeError('notification volume is invalid.');
    const config = await this.loadConfig();
    const saved = await config.updateConfigAsync((current) => {
      const desktop = { ...record(current.desktop) };
      // Storage holds only a value that differs from the code default.
      if (volume === NOTIFICATION_VOLUME_DEFAULT) delete desktop.notificationVolume;
      else desktop.notificationVolume = volume;
      return { ...current, desktop };
    });
    return desktopSettingsFromConfig(saved);
  }

  /** Run once: back up the config, then drop `desktop` values that equal a
   *  current or historical default plus dead keys. Returns whether it ran. */
  async separateDefaults(dataDir: string, now: Date = new Date()): Promise<boolean> {
    const config = await this.loadConfig();
    const supported = (value: unknown) => typeof value === 'number' && value >= DEFAULTS_SEPARATION_VERSION;
    if (supported(record(record(config.readConfig()).desktop)[DEFAULTS_SEPARATION_MARKER])) return false;
    let ran = false;
    await config.updateConfigAsync((current) => {
      const desktop = { ...record(current.desktop) };
      if (supported(desktop[DEFAULTS_SEPARATION_MARKER])) return current;
      // Inside the config lock: back up the exact pre-image being migrated.
      backupPreImage(dataDir, now, current);
      ran = true;
      for (const [key, value] of Object.entries(DESKTOP_FLAG_DEFAULTS)) {
        if (desktop[key] === value) delete desktop[key];
      }
      delete desktop.zoomFactor;
      delete desktop.git;
      const pins = record(desktop.activityRailPins).pins;
      if (Array.isArray(pins) && HISTORICAL_ACTIVITY_RAIL_PINS.some((list) => sameList(pins, list))) {
        delete desktop.activityRailPins;
      }
      desktop[DEFAULTS_SEPARATION_MARKER] = DEFAULTS_SEPARATION_VERSION;
      return { ...current, desktop };
    });
    return ran;
  }

  async readZoom(): Promise<number> {
    // Ignore legacy persisted zoom: the application UI always uses native scale.
    return 1;
  }

  async updateZoom(factor: number): Promise<number> {
    if (factor !== 1) throw new TypeError('Desktop zoom is fixed at 100%.');
    return 1;
  }
}
