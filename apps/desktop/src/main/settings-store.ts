import {
  NOTIFICATION_VOLUME_DEFAULT,
  isSessionRetentionDays,
  isSessionRetentionSettingKey,
  type DesktopSettingKey,
  type DesktopSettings,
  type SessionRetentionSettingKey,
} from '../shared/contract';
import {
  DEFAULT_ACTIVITY_RAIL_PINS,
  normalizeActivityRailPins,
  storedPinsState,
  type ActivityRailPinsState,
} from '../shared/activity-rail-pins';
import { type BrowserPermissionPolicy } from '../shared/browser-permission-policy';
import { desktopSettingsFromConfig, isNotificationVolume, SESSION_RETENTION_DEFAULTS } from '../shared/desktop-settings';
import type { ProtocolConnection } from './protocol/connection';

/** What the store needs of this PC's core: desktop operations (settings are keys of the core's Config actor, routed in
 *  protocol/desktop-operation-route.ts), plain requests, and the core's pushed `config` section. */
export interface DesktopSettingsPort {
  invoke(name: string, args: unknown[]): Promise<unknown>;
  call(method: string, params: unknown): Promise<unknown>;
  /** Called after every change of the `config` section; returns the removal. */
  watchConfig(listener: () => void): () => void;
}

export function desktopSettingsPort(connection: {
  client: { invokeDesktopOperation(name: string, args: unknown[]): Promise<unknown> };
  protocol: Pick<ProtocolConnection, 'call' | 'watchSection'>;
}): DesktopSettingsPort {
  return {
    invoke: (name, args) => connection.client.invokeDesktopOperation(name, args),
    call: (method, params) => connection.protocol.call(method, params),
    watchConfig: (listener) => connection.protocol.watchSection('config', () => listener()),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The stored session retention policy (absent = default), or null when a
 *  stored value is not one of the offered choices: the retention pass then
 *  does nothing rather than act on a guess. */
function sessionRetentionFromConfig(
  value: unknown
): { sessionAutoArchiveDays: number; sessionAutoDeleteDays: number } | null {
  const desktop = record(record(value).desktop);
  const read = (key: SessionRetentionSettingKey): number | null => {
    if (!Object.hasOwn(desktop, key)) return SESSION_RETENTION_DEFAULTS[key];
    const stored = desktop[key];
    return isSessionRetentionDays(key, stored) ? stored : null;
  };
  const sessionAutoArchiveDays = read('sessionAutoArchiveDays');
  const sessionAutoDeleteDays = read('sessionAutoDeleteDays');
  if (sessionAutoArchiveDays === null || sessionAutoDeleteDays === null) return null;
  return { sessionAutoArchiveDays, sessionAutoDeleteDays };
}

export interface BrowserCookieAutoImportSetting {
  enabled: boolean;
  profileId: string;
}

function cookieAutoImportFromConfig(value: unknown): BrowserCookieAutoImportSetting {
  const stored = record(record(record(value).desktop).browserCookieAutoImport);
  const profileId = typeof stored.profileId === 'string' ? stored.profileId : '';
  // On unless the user saved "off"; an empty profile means none is bound yet, so no run happens.
  return { enabled: stored.enabled !== false, profileId };
}

export { desktopSettingsFromConfig };

export { storedPinsState };

/** The desktop's settings, read from and written to this PC's core. The core owns the config file; every write is one
 *  of its operations. */
export class DesktopSettingsStore {
  constructor(private readonly port: DesktopSettingsPort) {}

  async read(): Promise<DesktopSettings> {
    return (await this.port.invoke('readSettings', [])) as DesktopSettings;
  }

  /** Call `listener` with the desktop settings whenever a persisted change (any writer: the core, another window, a
   *  hand edit) alters them. Resolves to the unsubscribe. */
  async watch(
    listener: (settings: DesktopSettings) => void,
    onError: (error: unknown) => void = () => undefined
  ): Promise<() => void> {
    let known = JSON.stringify(await this.read());
    return this.port.watchConfig(() => {
      this.read().then((next) => {
        const serialized = JSON.stringify(next);
        if (serialized === known) return;
        known = serialized;
        listener(next);
      }, onError);
    });
  }

  async readActivityRailPins(): Promise<ActivityRailPinsState | null> {
    return (await this.port.invoke('readActivityRailPins', [])) as ActivityRailPinsState | null;
  }

  async updateActivityRailPins(value: unknown, initializeIfMissing = false): Promise<ActivityRailPinsState> {
    const pins = normalizeActivityRailPins(value);
    if (!pins) throw new TypeError('Activity rail pins must be an array of supported destinations.');
    if (typeof initializeIfMissing !== 'boolean') throw new TypeError('initializeIfMissing must be a boolean.');
    return (await this.port.invoke('updateActivityRailPins', [pins, initializeIfMissing])) as ActivityRailPinsState;
  }

  private async readDesktopConfig(): Promise<unknown> {
    return record(await this.port.call('config/read', { keys: ['desktop'] })).config;
  }

  /** 설정 › 인증 관리: re-import cookies from this Chrome profile whenever Chrome is closed. On by default. */
  async readBrowserCookieAutoImport(): Promise<BrowserCookieAutoImportSetting> {
    return cookieAutoImportFromConfig(await this.readDesktopConfig());
  }

  async updateBrowserCookieAutoImport(next: BrowserCookieAutoImportSetting): Promise<BrowserCookieAutoImportSetting> {
    const { enabled, profileId } = next;
    // A profile id is one directory name; the importer re-checks it against Chrome's profile list.
    if (typeof enabled !== 'boolean' || typeof profileId !== 'string' || profileId.length > 120) {
      throw new TypeError('Automatic cookie import setting is invalid.');
    }
    if (/[\\/]/.test(profileId) || (enabled && !profileId)) {
      throw new TypeError('Automatic cookie import needs a Chrome profile.');
    }
    // Always stored: an explicit "off" must not fall back to the on default.
    await this.port.call('config/value/write', {
      path: 'desktop.browserCookieAutoImport',
      value: { enabled, profileId },
    });
    return cookieAutoImportFromConfig(await this.readDesktopConfig());
  }

  async update(key: DesktopSettingKey, enabled: boolean): Promise<DesktopSettings> {
    return (await this.port.invoke('updateSetting', [key, enabled])) as DesktopSettings;
  }

  async updateNotificationVolume(volume: number): Promise<DesktopSettings> {
    if (!isNotificationVolume(volume)) throw new TypeError('notification volume is invalid.');
    return (await this.port.invoke('updateNotificationVolume', [volume])) as DesktopSettings;
  }

  /** Settings → Browser: the site-permission defaults and exceptions. */
  async updateBrowserPermissions(policy: BrowserPermissionPolicy): Promise<DesktopSettings> {
    return (await this.port.invoke('updateBrowserPermissions', [policy])) as DesktopSettings;
  }

  /** Settings → General → Sessions: one of the offered day choices (0 = never). */
  async updateSessionRetention(key: SessionRetentionSettingKey, days: number): Promise<DesktopSettings> {
    if (!isSessionRetentionSettingKey(key)) throw new TypeError('session retention setting is invalid.');
    if (!isSessionRetentionDays(key, days)) throw new TypeError('session retention days are invalid.');
    return (await this.port.invoke('updateSessionRetention', [key, days])) as DesktopSettings;
  }

  /** The policy the retention pass may act on, or null when a stored value is invalid. */
  async readSessionRetention(): Promise<ReturnType<typeof sessionRetentionFromConfig>> {
    return sessionRetentionFromConfig(await this.readDesktopConfig());
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
