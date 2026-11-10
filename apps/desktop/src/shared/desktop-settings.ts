// The desktop settings as Node read them from the config (`desktopSettingsFromConfig`, main/settings-store.ts at b6f10295a),
// shared by the desktop's settings store and the paired phone's adapter (renderer/remote-protocol-settings.ts), which reads the
// same `agent` and `desktop` subtrees from the core's `config` section.
import {
  NOTIFICATION_VOLUME_DEFAULT,
  NOTIFICATION_VOLUME_MAX,
  SESSION_AUTO_ARCHIVE_DAYS_DEFAULT,
  SESSION_AUTO_DELETE_DAYS_DEFAULT,
  isSessionRetentionDays,
  type DesktopSettingKey,
  type DesktopSettings,
  type SessionRetentionSettingKey,
} from './contract';
import { normalizeBrowserPermissionPolicy } from './browser-permission-policy';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function isNotificationVolume(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= NOTIFICATION_VOLUME_MAX;
}

export const SESSION_RETENTION_DEFAULTS: Readonly<Record<SessionRetentionSettingKey, number>> = {
  sessionAutoArchiveDays: SESSION_AUTO_ARCHIVE_DAYS_DEFAULT,
  sessionAutoDeleteDays: SESSION_AUTO_DELETE_DAYS_DEFAULT,
};

export function desktopSettingsFromConfig(value: unknown): DesktopSettings {
  const config = record(value);
  const agent = record(config.agent);
  const autoClear = record(agent.autoClear);
  const compaction = record(agent.compaction);
  const desktop = record(config.desktop);
  const retentionDays = (key: SessionRetentionSettingKey): number => {
    const stored = desktop[key];
    return isSessionRetentionDays(key, stored) ? stored : SESSION_RETENTION_DEFAULTS[key];
  };
  return {
    autoClear: autoClear.enabled !== false,
    autoCompact: compaction.auto !== false && compaction.enabled !== false,
    keepAwake: desktop.keepAwake !== false,
    runInBackground: desktop.runInBackground !== false,
    notificationVolume: isNotificationVolume(desktop.notificationVolume)
      ? desktop.notificationVolume
      : NOTIFICATION_VOLUME_DEFAULT,
    sessionAutoArchiveDays: retentionDays('sessionAutoArchiveDays'),
    sessionAutoDeleteDays: retentionDays('sessionAutoDeleteDays'),
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
    browserHidDevices: desktop.browserHidDevices === true,
    browserPermissions: normalizeBrowserPermissionPolicy(desktop.browserPermissions),
    saveChatLogins: desktop.saveChatLogins !== false,
    // Grandfather: a control that is already on predates the install marker.
    computerInstalled: desktop.computerInstalled === true || desktop.computerControl === true,
    browserInstalled: desktop.browserInstalled === true || desktop.browserControl === true,
  };
}

/** The config key `updateSetting(key)` stores (`DesktopSettingsStore.update`, settings-store.ts): `autoClear` and
 *  `autoCompact` live in the agent config, every other key is a `desktop` flag. */
export function desktopSettingPath(key: DesktopSettingKey): string {
  if (key === 'autoClear') return 'agent.autoClear.enabled';
  if (key === 'autoCompact') return 'agent.compaction.auto';
  return `desktop.${key}`;
}
