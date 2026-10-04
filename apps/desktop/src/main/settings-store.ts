import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DesktopSettingKey, DesktopSettings } from '../shared/contract';
import {
  normalizeActivityRailPins,
  readActivityRailPinsState,
  type ActivityRailPinsState,
} from '../shared/activity-rail-pins';
import { packagedRuntimeSourceRoot } from './runtime-layout';

export interface MixdogConfigModule {
  readConfig(): unknown;
  updateConfigAsync(updater: (current: Record<string, unknown>) => Record<string, unknown>): Promise<unknown>;
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
    turnNotifications: desktop.turnNotifications !== false,
    // A fresh install starts pinned; an explicit unpin is kept.
    usagePinned: desktop.usagePinned !== false,
    computerControl: desktop.computerControl === true,
    computerObserveOnly: desktop.computerObserveOnly === true,
    browserControl: desktop.browserControl === true,
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
  'turnNotifications',
  'usagePinned',
  'computerObserveOnly',
  'computerInstalled',
  'browserInstalled',
]);

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
    return readActivityRailPinsState(record(record(config.readConfig()).desktop).activityRailPins);
  }

  async updateActivityRailPins(value: unknown, initializeIfMissing = false): Promise<ActivityRailPinsState> {
    const pins = normalizeActivityRailPins(value);
    if (!pins) throw new TypeError('Activity rail pins must be an array of supported destinations.');
    if (typeof initializeIfMissing !== 'boolean') throw new TypeError('initializeIfMissing must be a boolean.');
    const config = await this.loadConfig();
    const saved = await config.updateConfigAsync((current) => {
      const desktop = record(current.desktop);
      const previous = readActivityRailPinsState(desktop.activityRailPins);
      if (initializeIfMissing && previous) return current;
      const revision = (previous?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new RangeError('Activity rail pin revision is exhausted.');
      return { ...current, desktop: { ...desktop, activityRailPins: { pins, revision } } };
    });
    const state = readActivityRailPinsState(record(record(saved).desktop).activityRailPins);
    if (!state) throw new TypeError('The config write did not return valid activity rail pins.');
    return state;
  }

  async update(key: DesktopSettingKey, enabled: boolean): Promise<DesktopSettings> {
    const config = await this.loadConfig();
    const saved = await config.updateConfigAsync((current) => {
      const next = { ...record(current) };
      const agent = { ...record(next.agent) };
      if (key === 'autoClear') {
        agent.autoClear = { ...record(agent.autoClear), enabled };
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
        agent.compaction = compaction;
      } else if (DESKTOP_FLAG_KEYS.has(key)) {
        next.desktop = { ...record(next.desktop), [key]: enabled };
      } else if (key === 'computerControl') {
        const desktop = { ...record(next.desktop) };
        // A pre-marker profile is considered installed while its control is
        // on. Persist that grandfathered fact BEFORE turning it off so OFF
        // never turns back into Install.
        if (desktop.computerInstalled === true || desktop.computerControl === true) {
          desktop.computerInstalled = true;
        }
        desktop.computerControl = enabled;
        next.desktop = desktop;
      } else if (key === 'browserControl') {
        const desktop = { ...record(next.desktop) };
        if (desktop.browserInstalled === true || desktop.browserControl === true) {
          desktop.browserInstalled = true;
        }
        desktop.browserControl = enabled;
        next.desktop = desktop;
      }
      next.agent = agent;
      return next;
    });
    return desktopSettingsFromConfig(saved);
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
