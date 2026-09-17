import type { DesktopSettingKey } from './contract';

/** Adding a Desktop setting requires a setup route or an explicit handoff.
 * Record<DesktopSettingKey, …> makes forgotten settings a typecheck failure. */
export const DESKTOP_SETUP_SETTING_ACTIONS: Record<DesktopSettingKey, string> = {
  autoClear: 'set_autoclear',
  autoCompact: 'set_compaction',
  keepAwake: 'set_desktop_settings',
  usagePinned: 'set_desktop_settings',
  computerObserveOnly: 'set_desktop_settings',
  computerControl: 'set_builtin_enabled',
  browserControl: 'set_builtin_enabled',
  computerInstalled: 'install_builtin',
  browserInstalled: 'install_builtin',
};
