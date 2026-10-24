/** Desktop event: a desktop setting, the global Git identity, a bot's
 *  standing permission ("always allow"), or a notification preference or
 *  conversation override (contract-notifications.ts) was written. */
export const SETTINGS_CHANGED_EVENT = 'settings-changed';
/** Desktop event: the host machine's updater state changed (remote clients only). */
export const UPDATER_STATE_EVENT = 'updater-state-changed';

export interface SettingsChange {
  scope: 'desktop' | 'git' | 'permissions' | 'notifications';
}

export function readSettingsChange(value: unknown): SettingsChange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const scope = (value as Record<string, unknown>).scope;
  return scope === 'desktop' || scope === 'git' || scope === 'permissions' || scope === 'notifications'
    ? { scope }
    : null;
}
