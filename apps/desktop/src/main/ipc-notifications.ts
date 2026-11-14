// Settings › Notifications in this PC's window (issue #221), served by the core:
//   getNotificationPreferences  -> `remoteAccess/state` (the paired devices) and `notify/state` (whether this PC shows OS
//                                  notifications and the stored document, every listed device's default written)
//   setNotificationPreferences  -> `config/value/write` on `notifications.devices.<id>` (the key of
//                                  mixdog_protocol::config::desktop_files::NOTIFICATION_PREFERENCES, merged in the core),
//                                  then `ui/settings/announce` { scope: 'notifications' }
//   sendTestNotification        -> `notify/test` (this PC's window through the host, a paired device through the relay)
// The conversation overrides stay desktop operations (already routed to the core). A server window refuses these channels
// (connections/feature-gates.ts): they are this PC's.
import { hostname } from 'node:os';

import { DESKTOP_IPC } from '../shared/contract';
import { NOTIFICATION_PC_DEVICE_ID, type NotificationPreferencesState } from '../shared/contract-notifications';
import { notificationPreferencesStateOf, notificationWriteMode } from '../shared/notification-state';
import type { IpcHandle as Handle } from './ipc';
import {
  requiredConversationNotificationSetting,
  requiredNotificationDeviceId,
  requiredNotificationPreferencesPatch,
  requiredNotificationTarget,
} from './ipc-validation';
import type { ProtocolConnection } from './protocol/connection';
import { coreErrorForWindow } from './protocol/core-error';

/** Not read any more: the core asks the host whether this PC shows notifications and sends the test. The type goes with the
 *  `notifications` option of registerDesktopIpc. */
export interface NotificationIpcHost {
  isSupported(): boolean;
  sendTest(): { ok: boolean; message?: string };
}

export interface NotificationTestResult {
  ok: boolean;
  message?: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function registerNotificationIpc({
  handle,
  invokeDesktopOperation,
  core,
}: {
  handle: Handle;
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
  /** The window's core connection; without one these calls fail. */
  core?: Pick<ProtocolConnection, 'call'> | null;
  /** Not read any more. */
  notifications?: NotificationIpcHost;
}): void {
  const call = async (method: string, params: unknown): Promise<unknown> => {
    if (!core) throw new Error('The core connection is not available.');
    try {
      return await core.call(method, params);
    } catch (error) {
      throw coreErrorForWindow(error);
    }
  };
  const read = async () => {
    const remote = await call('remoteAccess/state', {});
    const state = record(await call('notify/state', {}));
    return { remote, notifications: state.notifications ?? undefined, supported: state.supported === true };
  };
  const stateOf = async (): Promise<NotificationPreferencesState> => {
    const { remote, notifications, supported } = await read();
    return notificationPreferencesStateOf({
      remote,
      notifications,
      currentDeviceId: NOTIFICATION_PC_DEVICE_ID,
      pcCanNotify: supported,
      hostName: hostname,
    });
  };

  handle(DESKTOP_IPC.getNotificationPreferences, () => stateOf());
  handle(DESKTOP_IPC.setNotificationPreferences, async (_event, deviceId, patch) => {
    const id = requiredNotificationDeviceId(deviceId);
    const value = requiredNotificationPreferencesPatch(patch);
    const { remote, notifications } = await read();
    const mode = notificationWriteMode(id, remote, notifications);
    await call('config/value/write', { path: `notifications.devices.${id}`, value, mode });
    await call('ui/settings/announce', { scope: 'notifications' });
    return stateOf();
  });
  handle(
    DESKTOP_IPC.sendTestNotification,
    async (_event, deviceId): Promise<NotificationTestResult> =>
      (await call('notify/test', { target: requiredNotificationDeviceId(deviceId) })) as NotificationTestResult
  );
  handle(DESKTOP_IPC.listConversationNotifications, () => invokeDesktopOperation('listConversationNotifications', []));
  handle(DESKTOP_IPC.setConversationNotification, (_event, target, setting) =>
    invokeDesktopOperation('setConversationNotification', [
      requiredNotificationTarget(target),
      requiredConversationNotificationSetting(setting),
    ])
  );
}
