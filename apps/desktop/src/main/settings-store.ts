import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  DesktopSettingKey,
  DesktopSettings,
} from '../shared/contract';
import { packagedRuntimeSourceRoot } from './runtime-layout';

export interface MixdogConfigModule {
  readConfig(): unknown;
  updateConfigAsync(
    updater: (current: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<unknown>;
}

interface DesktopSettingsStoreOptions {
  packaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  loadConfig?: () => Promise<MixdogConfigModule>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const DEFAULT_ZOOM_FACTOR = 1;

function desktopZoomFromConfig(value: unknown): number {
  const factor = Number(record(record(value).desktop).zoomFactor);
  return Number.isFinite(factor) && factor >= 0.2 && factor <= 10
    ? factor
    : DEFAULT_ZOOM_FACTOR;
}

export function settingsConfigModuleUrl(
  packaged = false,
  resourcesPath = process.resourcesPath,
  appPath = process.cwd(),
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
    usagePinned: desktop.usagePinned === true,
    computerControl: desktop.computerControl === true,
    computerObserveOnly: desktop.computerObserveOnly === true,
    browserControl: desktop.browserControl === true,
    // Grandfather: a control that is already on predates the install marker.
    computerInstalled: desktop.computerInstalled === true || desktop.computerControl === true,
    browserInstalled: desktop.browserInstalled === true || desktop.browserControl === true,
  };
}

export class DesktopSettingsStore {
  private readonly loadConfig: () => Promise<MixdogConfigModule>;

  constructor({
    packaged = false,
    resourcesPath = process.resourcesPath,
    appPath = process.cwd(),
    loadConfig,
  }: DesktopSettingsStoreOptions = {}) {
    this.loadConfig = loadConfig ?? (async () => import(
      /* @vite-ignore */ settingsConfigModuleUrl(packaged, resourcesPath, appPath)
    ) as Promise<MixdogConfigModule>);
  }

  async read(): Promise<DesktopSettings> {
    const config = await this.loadConfig();
    return desktopSettingsFromConfig(config.readConfig());
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
          'enabled', 'type', 'compactType', 'compact_type', 'semantic', 'semanticModel', 'prune', 'tailTurns',
          'recallMemoryTimeoutMs', 'recallIngestLimit', 'recallChunkLimit', 'recallLimit',
          'recallCycle1BatchSize', 'recallRowsPerSession', 'recallWindowSize',
          'recallConcurrency', 'recallCycle1DeadlineMs',
        ]) {
          delete compaction[legacyKey];
        }
        agent.compaction = compaction;
      } else if (key === 'keepAwake') {
        next.desktop = { ...record(next.desktop), keepAwake: enabled };
      } else if (key === 'usagePinned') {
        next.desktop = { ...record(next.desktop), usagePinned: enabled };
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
      } else if (key === 'computerObserveOnly') {
        next.desktop = { ...record(next.desktop), computerObserveOnly: enabled };
      } else if (key === 'browserControl') {
        const desktop = { ...record(next.desktop) };
        if (desktop.browserInstalled === true || desktop.browserControl === true) {
          desktop.browserInstalled = true;
        }
        desktop.browserControl = enabled;
        next.desktop = desktop;
      } else if (key === 'computerInstalled') {
        next.desktop = { ...record(next.desktop), computerInstalled: enabled };
      } else if (key === 'browserInstalled') {
        next.desktop = { ...record(next.desktop), browserInstalled: enabled };
      }
      next.agent = agent;
      return next;
    });
    return desktopSettingsFromConfig(saved);
  }

  async readZoom(): Promise<number> {
    const config = await this.loadConfig();
    return desktopZoomFromConfig(config.readConfig());
  }

  async updateZoom(factor: number): Promise<number> {
    const config = await this.loadConfig();
    const saved = await config.updateConfigAsync((current) => ({
      ...record(current),
      desktop: {
        ...record(record(current).desktop),
        zoomFactor: factor,
      },
    }));
    return desktopZoomFromConfig(saved);
  }
}
