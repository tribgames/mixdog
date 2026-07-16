import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DesktopSettingKey, DesktopSettings } from '../shared/contract';

interface MixdogConfigModule {
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

export function settingsConfigModuleUrl(
  packaged = false,
  resourcesPath = process.resourcesPath,
  appPath = process.cwd(),
): string {
  const configPath = packaged
    ? join(resourcesPath, 'runtime.asar', 'node_modules', 'mixdog', 'src', 'runtime', 'shared', 'config.mjs')
    : resolve(appPath, '../../src/runtime/shared/config.mjs');
  return pathToFileURL(configPath).href;
}

export function desktopSettingsFromConfig(value: unknown): DesktopSettings {
  const config = record(value);
  const autoClear = record(config.autoClear);
  const compaction = record(config.compaction);
  return {
    autoClear: autoClear.enabled !== false,
    autoCompact: compaction.auto !== false && compaction.enabled !== false,
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
      if (key === 'autoClear') {
        next.autoClear = { ...record(next.autoClear), enabled };
      } else if (key === 'autoCompact') {
        const compaction: Record<string, unknown> = {
          ...record(next.compaction),
          auto: enabled,
        };
        // `enabled` was an old alias. Remove it so it cannot override the
        // canonical `auto` field when a legacy config is switched back on.
        delete compaction.enabled;
        next.compaction = compaction;
      }
      return next;
    });
    return desktopSettingsFromConfig(saved);
  }
}
