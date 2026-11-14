// This PC's notification preferences and the conversation overrides, read from the core's config key `notifications`
// (Settings writes it through `config/value/write`; the migration fills it from the old notification-preferences.json).
// The main process holds the config section as the core pushes it, so each read is the current value: a preference
// changed in Settings applies to the next toast, taskbar flash and Browser Use approval toast without a re-read request.
import { NOTIFICATION_PC_DEVICE_ID } from '../shared/contract-notifications';
import type { DesktopSectionsSnapshot } from '../shared/contract-sections';
import { activeOverrides, devicePreferencesIn, migratedAtOf, storedOverrides, storedPreferences } from '../shared/notification-state';
import type { NotificationPreferencesView } from './notification-decision';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** This PC's view from the `notifications` subtree of the core's config (undefined while it was never written: the defaults). */
export function pcNotificationViewOf(notifications: unknown, now = Date.now()): NotificationPreferencesView {
  const devices = Object.fromEntries(
    Object.entries(record(record(notifications).devices)).map(([id, preferences]) => [id, storedPreferences(preferences)])
  );
  return {
    preferences: devicePreferencesIn({ devices, migratedAt: migratedAtOf(notifications) }, NOTIFICATION_PC_DEVICE_ID),
    overrides: activeOverrides(storedOverrides(notifications), now),
  };
}

/** The view over a core connection's held sections, read fresh at each call. */
export function createPcNotificationView(connection: {
  snapshot(): DesktopSectionsSnapshot;
}): (now?: number) => NotificationPreferencesView {
  return (now = Date.now()) =>
    pcNotificationViewOf(
      connection.snapshot().entries.find((entry) => entry.section === 'config' && entry.key === 'notifications')?.value,
      now
    );
}
