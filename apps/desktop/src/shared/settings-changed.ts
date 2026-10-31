/** Desktop event: a desktop setting, the global Git identity, a bot's
 *  standing permission ("always allow"), a notification preference or
 *  conversation override (contract-notifications.ts), or — scope `agent` — any
 *  other persisted setting or stored key (agent-settings-watch.ts) was written. */
export const SETTINGS_CHANGED_EVENT = 'settings-changed';
/** Desktop event: the host machine's updater state changed (remote clients only). */
export const UPDATER_STATE_EVENT = 'updater-state-changed';

const SETTINGS_SCOPES = ['desktop', 'git', 'permissions', 'notifications', 'agent'] as const;

export interface SettingsChange {
  scope: (typeof SETTINGS_SCOPES)[number];
}

export function readSettingsChange(value: unknown): SettingsChange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const scope = (value as Record<string, unknown>).scope;
  return SETTINGS_SCOPES.find((known) => known === scope) ? { scope: scope as SettingsChange['scope'] } : null;
}
