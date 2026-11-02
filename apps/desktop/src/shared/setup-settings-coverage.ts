import type { DesktopSettingKey, SessionRetentionSettingKey } from './contract-settings';

/** Adding a Desktop setting requires a setup route or an explicit handoff.
 * Record<DesktopSettingKey, …> makes forgotten settings a typecheck failure. */
export const DESKTOP_SETUP_SETTING_ACTIONS: Record<
  DesktopSettingKey | 'notificationVolume' | SessionRetentionSettingKey,
  string
> = {
  notificationVolume: 'set_desktop_settings',
  sessionAutoArchiveDays: 'set_desktop_settings',
  sessionAutoDeleteDays: 'set_desktop_settings',
  autoClear: 'set_autoclear',
  autoCompact: 'set_compaction',
  keepAwake: 'set_desktop_settings',
  runInBackground: 'set_desktop_settings',
  usagePinned: 'set_desktop_settings',
  usageRailShortLong: 'set_desktop_settings',
  usageAccountsExpanded: 'set_desktop_settings',
  usageRailSlotsThree: 'set_desktop_settings',
  usageRailSlotsAll: 'set_desktop_settings',
  computerObserveOnly: 'set_desktop_settings',
  browserAutoSignIn: 'set_desktop_settings',
  browserHidDevices: 'set_desktop_settings',
  saveChatLogins: 'set_desktop_settings',
  computerControl: 'set_builtin_enabled',
  browserControl: 'set_builtin_enabled',
  computerInstalled: 'install_builtin',
  browserInstalled: 'install_builtin',
};
