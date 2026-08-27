import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  DesktopGitCommitPreset,
  DesktopGitPreferences,
  DesktopSettingKey,
  DesktopSettings,
} from '../shared/contract';

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
    ? join(resourcesPath, 'runtime.asar', 'node_modules', 'mixdog', 'src', 'runtime', 'shared', 'config.mjs')
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
    browserControl: desktop.browserControl === true,
  };
}

// Mirrors the commit-message IPC bound (ipc.ts's gitCommit handler).
const COMMIT_TEMPLATE_LIMIT = 20_000;
const COMMIT_PRESETS: ReadonlySet<string> = new Set(['none', 'conventional', 'custom']);

export function gitPreferencesFromConfig(value: unknown): DesktopGitPreferences {
  const git = record(record(record(value).desktop).git);
  const legacy = typeof git.commitTemplate === 'string'
    ? git.commitTemplate.slice(0, COMMIT_TEMPLATE_LIMIT)
    : '';
  const legacyLines = legacy.split(/\r?\n/);
  const commitExample = typeof git.commitExample === 'string'
    ? git.commitExample.slice(0, COMMIT_TEMPLATE_LIMIT)
    : (legacyLines[0] || '').trim();
  const commitInstructions = typeof git.commitInstructions === 'string'
    ? git.commitInstructions.slice(0, COMMIT_TEMPLATE_LIMIT)
    : legacyLines.slice(1).join('\n').trim();
  return {
    commitPreset: typeof git.commitPreset === 'string' && COMMIT_PRESETS.has(git.commitPreset)
      ? git.commitPreset as DesktopGitCommitPreset
      : 'none',
    commitTemplate: [commitExample, commitInstructions].filter(Boolean).join('\n'),
    commitExample,
    commitInstructions,
    // Default ON (user decision): only an explicit false turns it off.
    autoCommitMessage: git.autoCommitMessage !== false,
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
        // `enabled` was an old alias. Remove it so it cannot override the
        // canonical `auto` field when a legacy config is switched back on.
        delete compaction.enabled;
        agent.compaction = compaction;
      } else if (key === 'keepAwake') {
        next.desktop = { ...record(next.desktop), keepAwake: enabled };
      } else if (key === 'usagePinned') {
        next.desktop = { ...record(next.desktop), usagePinned: enabled };
      } else if (key === 'computerControl') {
        next.desktop = { ...record(next.desktop), computerControl: enabled };
      } else if (key === 'browserControl') {
        next.desktop = { ...record(next.desktop), browserControl: enabled };
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

  async readGitPreferences(): Promise<DesktopGitPreferences> {
    const config = await this.loadConfig();
    return gitPreferencesFromConfig(config.readConfig());
  }

  async updateGitPreferences(
    preferences: Partial<DesktopGitPreferences>,
  ): Promise<DesktopGitPreferences> {
    const config = await this.loadConfig();
    const saved = await config.updateConfigAsync((current) => {
      const next = { ...record(current) };
      const desktop = { ...record(next.desktop) };
      const git = { ...record(desktop.git) };
      if (typeof preferences.commitPreset === 'string' && COMMIT_PRESETS.has(preferences.commitPreset)) {
        git.commitPreset = preferences.commitPreset;
      }
      if (typeof preferences.commitTemplate === 'string') {
        const legacy = preferences.commitTemplate.slice(0, COMMIT_TEMPLATE_LIMIT);
        const legacyLines = legacy.split(/\r?\n/);
        git.commitExample = (legacyLines[0] || '').trim();
        git.commitInstructions = legacyLines.slice(1).join('\n').trim();
      }
      if (typeof preferences.commitExample === 'string') {
        git.commitExample = preferences.commitExample.slice(0, COMMIT_TEMPLATE_LIMIT);
      }
      if (typeof preferences.commitInstructions === 'string') {
        git.commitInstructions = preferences.commitInstructions.slice(0, COMMIT_TEMPLATE_LIMIT);
      }
      if (typeof preferences.commitTemplate === 'string'
          || typeof preferences.commitExample === 'string'
          || typeof preferences.commitInstructions === 'string') {
        git.commitTemplate = [
          typeof git.commitExample === 'string' ? git.commitExample : '',
          typeof git.commitInstructions === 'string' ? git.commitInstructions : '',
        ].filter(Boolean).join('\n').slice(0, COMMIT_TEMPLATE_LIMIT);
      }
      if (typeof preferences.autoCommitMessage === 'boolean') {
        git.autoCommitMessage = preferences.autoCommitMessage;
      }
      desktop.git = git;
      next.desktop = desktop;
      return next;
    });
    return gitPreferencesFromConfig(saved);
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
