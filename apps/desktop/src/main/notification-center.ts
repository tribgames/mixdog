// Settings › Notifications on the desktop service (issue #221): the device
// list (this PC, then the Connection tab's paired devices), each device's
// preferences, the conversation overrides and the test notification. This
// PC's window reaches it over IPC and a paired device over its remote methods;
// both validate their arguments first (ipc-validation.ts). The store
// announces every persisted change once (SettingsChange { scope: 'notifications' }).
import type { DesktopRemoteClientInfo } from '../shared/contract';
import {
  type ConversationNotificationOverride,
  type ConversationNotificationSetting,
  NOTIFICATION_PC_DEVICE_ID,
  type NotificationDeviceKind,
  type NotificationDeviceSummary,
  type NotificationPreferencesPatch,
  type NotificationPreferencesState,
  type NotificationTarget,
} from '../shared/contract-notifications';
import { MIXDOG_APP_CLIENT_BROWSER, MIXDOG_DESKTOP_CLIENT_BROWSER, remoteClientKind } from '../shared/remote-trust';
import type { NotificationDeviceInfo, NotificationPreferencesStore } from './notification-preferences';

export interface NotificationTestResult {
  ok: boolean;
  message?: string;
}

const NOTIFICATION_CENTER_OPERATIONS = [
  'notificationPreferencesState',
  'setNotificationPreferences',
  'listConversationNotifications',
  'setConversationNotification',
  'sendTestNotification',
] as const;

interface NotificationCenterOptions {
  store: NotificationPreferencesStore;
  /** This PC's name as paired devices see it. */
  pcName(): string;
  /** The paired devices as Settings › Connection lists them (aliases applied). */
  listClients(): Promise<DesktopRemoteClientInfo[]>;
  /** Paired client ids holding a native or web push registration. */
  pushRegistrations(): Promise<ReadonlySet<string>>;
  /** Whether this PC's OS shows notifications (asked of the window process). */
  pcSupported(): Promise<boolean>;
  /** One notification on this PC, through the window process. */
  sendPcTest(): Promise<NotificationTestResult>;
  /** One push to a paired device through its real channel. */
  sendDeviceTest(clientId: string): Promise<NotificationTestResult>;
}

/** The Connection tab's name for a paired device: its alias, else its own
 *  name without the trailing kind ("Galaxy S24 · Mixdog App" → "Galaxy S24"). */
export function notificationDeviceName(client: DesktopRemoteClientInfo): string {
  if (client.alias) return client.alias;
  const full = client.name || `${client.platform || 'Device'} · ${client.browser || 'Browser'}`;
  const parts = full.split(' · ');
  const last = parts[parts.length - 1].toLowerCase();
  const kinds = [client.browser, MIXDOG_APP_CLIENT_BROWSER, MIXDOG_DESKTOP_CLIENT_BROWSER, 'Mixdog PC', 'Browser'];
  if (parts.length > 1 && kinds.some((value) => value && value.toLowerCase() === last)) parts.pop();
  return parts.join(' · ');
}

const deviceKind = (client: DesktopRemoteClientInfo): NotificationDeviceKind =>
  remoteClientKind(client.browser) === 'app' ? 'phone-app' : 'browser';

/** What a paired device's default preferences are decided from: its record's
 *  kind and creation time (immutable, unlike a push registration's). */
export function pairedDeviceInfo(client: DesktopRemoteClientInfo): NotificationDeviceInfo {
  return {
    kind: deviceKind(client),
    ...(Number.isSafeInteger(client.createdAt) && client.createdAt > 0 ? { pairedAt: client.createdAt } : {}),
  };
}

export function createNotificationCenter(options: NotificationCenterOptions) {
  const { store } = options;
  const devices = async (pcCanNotify: boolean | null) => {
    const [clients, registrations, supported] = await Promise.all([
      options.listClients(),
      options.pushRegistrations(),
      pcCanNotify ?? options.pcSupported(),
    ]);
    const paired = clients.filter((client) => !client.pendingRemoval);
    const summaries: NotificationDeviceSummary[] = [
      { id: NOTIFICATION_PC_DEVICE_ID, name: options.pcName(), kind: 'pc', online: true, canNotify: supported },
      ...paired.map((client) => ({
        id: client.id,
        name: notificationDeviceName(client),
        kind: deviceKind(client),
        online: client.online,
        canNotify: registrations.has(client.id),
      })),
    ];
    const infos = new Map<string, NotificationDeviceInfo>([
      [NOTIFICATION_PC_DEVICE_ID, { kind: 'pc' }],
      ...paired.map((client) => [client.id, pairedDeviceInfo(client)] as const),
    ]);
    return { summaries, infos };
  };
  const state = async (currentDeviceId: string, pcCanNotify: boolean | null): Promise<NotificationPreferencesState> => {
    const { summaries, infos } = await devices(pcCanNotify);
    const preferences = await store.devices(
      summaries.map((device) => ({ id: device.id, info: infos.get(device.id)! }))
    );
    return { devices: summaries, preferences, currentDeviceId };
  };
  const setPreferences = async (
    currentDeviceId: string,
    pcCanNotify: boolean | null,
    deviceId: string,
    patch: NotificationPreferencesPatch
  ): Promise<NotificationPreferencesState> => {
    const { infos } = await devices(pcCanNotify);
    const info = infos.get(deviceId);
    if (!info) throw new TypeError('That device is not paired with this PC.');
    await store.setDevice(deviceId, patch, info);
    return state(currentDeviceId, pcCanNotify);
  };
  const setConversation = (
    target: NotificationTarget,
    setting: ConversationNotificationSetting
  ): Promise<ConversationNotificationOverride[]> => store.setConversation(target, setting);
  const sendTest = async (deviceId: string): Promise<NotificationTestResult> => {
    if (deviceId === NOTIFICATION_PC_DEVICE_ID) return options.sendPcTest();
    const clients = await options.listClients();
    if (!clients.some((client) => client.id === deviceId && !client.pendingRemoval)) {
      return { ok: false, message: 'That device is not paired with this PC.' };
    }
    return options.sendDeviceTest(deviceId);
  };
  return {
    state,
    setPreferences,
    setConversation,
    sendTest,
    handles: (name: string): boolean => (NOTIFICATION_CENTER_OPERATIONS as readonly string[]).includes(name),
    /** The service operations above; arguments arrive validated. Args:
     *  state [currentDeviceId, pcCanNotify | null]; set preferences
     *  [currentDeviceId, pcCanNotify | null, deviceId, patch]; list []; set
     *  conversation [target, setting]; test [deviceId]. A null pcCanNotify is
     *  asked of the window process. */
    invoke(name: string, args: unknown[]): Promise<unknown> {
      const pcCanNotify = typeof args[1] === 'boolean' ? args[1] : null;
      switch (name) {
        case 'notificationPreferencesState':
          return state(String(args[0] ?? ''), pcCanNotify);
        case 'setNotificationPreferences':
          return setPreferences(
            String(args[0] ?? ''),
            pcCanNotify,
            String(args[2] ?? ''),
            args[3] as NotificationPreferencesPatch
          );
        case 'listConversationNotifications':
          return store.overrides();
        case 'setConversationNotification':
          return setConversation(args[0] as NotificationTarget, args[1] as ConversationNotificationSetting);
        default:
          return sendTest(String(args[0] ?? ''));
      }
    },
  };
}

export type NotificationCenter = ReturnType<typeof createNotificationCenter>;
