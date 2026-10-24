// Settings › Notifications in this PC's window (issue #221): every device's
// preferences, the conversation overrides and the test notification, all kept
// by the desktop service (notification-center.ts). A server window refuses
// these channels (connections/feature-gates.ts): they are this PC's.
import { DESKTOP_IPC } from '../shared/contract';
import { NOTIFICATION_PC_DEVICE_ID } from '../shared/contract-notifications';
import type { IpcHandle as Handle } from './ipc';
import {
  requiredConversationNotificationSetting,
  requiredNotificationDeviceId,
  requiredNotificationPreferencesPatch,
  requiredNotificationTarget,
} from './ipc-validation';
import type { NotificationTestResult } from './notification-center';

export interface NotificationIpcHost {
  /** This PC's OS shows notifications. */
  isSupported(): boolean;
  /** One notification on this PC now, past every preference. */
  sendTest(): NotificationTestResult;
}

export function registerNotificationIpc({
  handle,
  invokeDesktopOperation,
  notifications,
}: {
  handle: Handle;
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
  notifications: NotificationIpcHost;
}): void {
  handle(DESKTOP_IPC.getNotificationPreferences, () =>
    invokeDesktopOperation('notificationPreferencesState', [NOTIFICATION_PC_DEVICE_ID, notifications.isSupported()])
  );
  handle(DESKTOP_IPC.setNotificationPreferences, (_event, deviceId, patch) =>
    invokeDesktopOperation('setNotificationPreferences', [
      NOTIFICATION_PC_DEVICE_ID,
      notifications.isSupported(),
      requiredNotificationDeviceId(deviceId),
      requiredNotificationPreferencesPatch(patch),
    ])
  );
  handle(DESKTOP_IPC.sendTestNotification, (_event, deviceId) => {
    const id = requiredNotificationDeviceId(deviceId);
    return id === NOTIFICATION_PC_DEVICE_ID
      ? notifications.sendTest()
      : invokeDesktopOperation('sendTestNotification', [id]);
  });
  handle(DESKTOP_IPC.listConversationNotifications, () => invokeDesktopOperation('listConversationNotifications', []));
  handle(DESKTOP_IPC.setConversationNotification, (_event, target, setting) =>
    invokeDesktopOperation('setConversationNotification', [
      requiredNotificationTarget(target),
      requiredConversationNotificationSetting(setting),
    ])
  );
}
