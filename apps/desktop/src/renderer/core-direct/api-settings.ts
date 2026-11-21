import { remoteAccessInfoFromDescriptor } from '../../main/remote-access-window.ts';
import type { DesktopApi } from '../../shared/contract';
import { NOTIFICATION_PC_DEVICE_ID, type NotificationPreferencesState } from '../../shared/contract-notifications';
import type { DesktopRemoteConnectionState } from '../../shared/contract-workspace';
import { notificationPreferencesStateOf, notificationWriteMode } from '../../shared/notification-state';
import { PROVIDER_MODELS_EVENT } from '../../shared/provider-models';
import { SETTINGS_CHANGED_EVENT } from '../../shared/settings-changed';
import type { DirectKey } from '../../shared/desktop-api-split';
import { createOperationLane, watchAnnouncements } from '../../shared/core-lanes/desktop-operation-route';
import {
  requiredBotHandoffLimit,
  requiredBrowserPermissionPolicy,
  requiredDesktopSettingKey,
  requiredNotificationVolume,
  requiredSessionRetentionSetting,
} from '../../shared/settings-input';
import { windowOfReply } from './client.ts';
import type { DirectContext } from './context.ts';
import { withDirectErrors } from './errors.ts';
import { hostPlatform } from './host-platform.ts';
import { record } from '../record-utils.ts';
import { createSettingsEvents } from './settings-events.ts';

type SettingsApi = Pick<DesktopApi, DirectKey<'settings'>>;

export function createSettingsApi(ctx: DirectContext): SettingsApi {
  const { connection } = ctx;
  const lane = createOperationLane({
    protocol: connection,
    // The lane folds folder keys on Windows only; none of this group watches folders, so the renderer's platform serves a remote connection too.
    platform: hostPlatform(),
    host: { hostName: () => '' },
  });
  const op = <T>(name: string, args: unknown[] = []): Promise<T> =>
    withDirectErrors(lane.invoke(name, args) as Promise<T>);

  const announced = (name: string, listener: (value: never) => void): (() => void) =>
    watchAnnouncements(connection, (eventName, value) => {
      if (eventName === name) listener(value as never);
    });

  // ── Settings > Notifications (main/ipc-notifications.ts) ──
  const notificationState = async (): Promise<{ remote: unknown; notifications: unknown; supported: boolean }> => {
    const remote = await ctx.call('remoteAccess/state', {});
    const state = record(await ctx.call('notify/state', {}));
    return { remote, notifications: state.notifications ?? undefined, supported: state.supported === true };
  };
  const preferencesState = async (): Promise<NotificationPreferencesState> => {
    const { remote, notifications, supported } = await notificationState();
    return notificationPreferencesStateOf({
      remote,
      notifications,
      currentDeviceId: NOTIFICATION_PC_DEVICE_ID,
      pcCanNotify: supported,
      // The PC's name is the remote settings' name; the core's own default (the OS hostname) stands in when none was set.
      hostName: () => String(record(record(remote).settings).defaultName ?? ''),
    });
  };

  const events = createSettingsEvents(ctx);

  const access = async (name: string, args: unknown[] = []) => remoteAccessInfoFromDescriptor(await op(name, args));

  return {
    readSettings: () => op('readSettings'),
    // The arguments are checked as the window's handler checked them before anything is written (the route would otherwise turn a
    // non-boolean into false and write any key under desktop).
    updateSetting: async (key, enabled) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
      return op('updateSetting', [requiredDesktopSettingKey(key), enabled]);
    },
    subscribeSettingsChanged: (listener) => announced(SETTINGS_CHANGED_EVENT, listener),
    readActivityRailPins: () => op('readActivityRailPins'),
    updateActivityRailPins: (pins, initializeIfMissing) => op('updateActivityRailPins', [pins, initializeIfMissing]),
    subscribeActivityRailPins: events.activityRailPins,
    // The preload sent this and left the answer: a failed announcement is not the caller's.
    notifyProviderModelsChanged: (origin) => {
      void op('notifyProviderModelsChanged', [origin]).catch(() => undefined);
    },
    subscribeProviderModelsChanged: (listener) => announced(PROVIDER_MODELS_EVENT, listener),
    setNotificationVolume: async (volume) => op('updateNotificationVolume', [requiredNotificationVolume(volume)]),
    setBotHandoffLimit: async (limit) => op('updateBotHandoffLimit', [requiredBotHandoffLimit(limit)]),
    setSessionRetention: async (key, days) => {
      const setting = requiredSessionRetentionSetting(key, days);
      return op('updateSessionRetention', [setting.key, setting.days]);
    },
    setBrowserPermissions: async (policy) => op('updateBrowserPermissions', [requiredBrowserPermissionPolicy(policy)]),
    setNotificationPreferences: (deviceId, patch) =>
      withDirectErrors(
        (async () => {
          const { remote, notifications } = await notificationState();
          const mode = notificationWriteMode(deviceId, remote, notifications);
          // Announced by the write itself, once, changed or not.
          await ctx.call('config/value/write', {
            path: `notifications.devices.${deviceId}`,
            value: patch,
            mode,
          });
          return preferencesState();
        })()
      ),
    getNotificationPreferences: () => withDirectErrors(preferencesState()),
    // This PC's window through the host, a paired device through the relay: the core decides.
    sendTestNotification: (deviceId) =>
      withDirectErrors(ctx.call('notify/test', { target: deviceId }) as Promise<{ ok: boolean; message?: string }>),
    // Settings > Appearance: the font families installed on this computer. A server window asks this PC's core (main's
    // handler used pcCore), never the server's.
    listSystemFonts: () =>
      withDirectErrors(
        (async () => {
          const pc = ctx.pcClient();
          const onServer = pc ? windowOfReply(pc.server)?.role?.startsWith('server:') === true : false;
          const reply = onServer
            ? await (pc as unknown as { call(method: string, params: unknown): Promise<unknown> }).call(
                'desktop/fonts/list',
                {}
              )
            : await ctx.call('desktop/fonts/list', {});
          return (reply as { families: string[] }).families;
        })()
      ),
    listConversationNotifications: () => op('listConversationNotifications'),
    setConversationNotification: (target, setting) => op('setConversationNotification', [target, setting]),
    subscribeTurnReviewChanged: events.turnReview,
    subscribeOrchestrationModeChanged: events.orchestrationMode,
    readMarkdownDefaultView: () => op('readMarkdownDefaultView'),
    // The lane's route takes the user-data directory first (the main process's own path); the core needs none.
    writeMarkdownDefaultView: (view) => op('writeMarkdownDefaultView', ['', view]),
    rotateRemoteAccess: () => access('remoteAccessRotate'),
    revokeRemoteAccessClient: (clientId) => access('remoteAccessRevokeClient', [clientId]),
    setRemoteAccessEnabled: (enabled) => op('remoteAccessSetEnabled', [enabled]),
    setRemotePcName: (name) => op('remoteAccessSetName', [typeof name === 'string' ? name : '']),
    setRemoteClientAlias: async (clientId, alias) => {
      await op('remoteAccessSetClientAlias', [clientId, alias]);
    },
    resolveRemoteClientClaim: async (claimId, approved) =>
      (await op('remoteAccessResolveClaim', [claimId, approved])) === true,
    getRemotePairCode: (action) => op('remoteAccessPairCode', [action]),
    getRemoteAccessInfo: (options) => access('remoteAccessInfo', [options?.activate !== false]),
    getRemoteConnectionState: () =>
      withDirectErrors(ctx.call('remoteAccess/state', {}) as Promise<DesktopRemoteConnectionState>),
    subscribeRemoteClientClaim: events.remoteClaims,
    getRemoteAccessSettings: () => op('remoteAccessSettings'),
    subscribeRemoteAccessSettings: events.remoteSettings,
    listRemoteClientClaims: () => op('remoteAccessListClaims'),
  };
}
