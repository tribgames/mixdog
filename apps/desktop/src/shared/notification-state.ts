// Settings › Notifications from stored facts: each device's stored preferences or the default its kind and pairing give it, the
// conversation overrides in force, and the device list (this PC, then the paired devices). Pure, so the desktop's operation lane
// (main/protocol/section-reads.ts) and a paired phone's adapter (renderer/remote-protocol-settings.ts) build Node's answer
// (notification-center.ts `state`, notification-preferences.ts at b6f10295a) from the same core sections.
import type { DesktopRemoteClientInfo } from './contract';
import {
  type ConversationNotificationOverride,
  DEFAULT_NOTIFICATION_PREFERENCES,
  NEW_PHONE_NOTIFICATION_PREFERENCES,
  NOTIFICATION_EVENTS,
  NOTIFICATION_PC_DEVICE_ID,
  type NotificationDeviceKind,
  type NotificationDevicePreferences,
  type NotificationDeviceSummary,
  type NotificationPreferencesState,
  type NotificationTarget,
} from './contract-notifications';
import { MIXDOG_APP_CLIENT_BROWSER, MIXDOG_DESKTOP_CLIENT_BROWSER, remoteClientKind } from './remote-trust';

/** What a device without stored preferences is: its kind, and when it was
 *  paired (or first registered for pushes) when that is known. */
export interface NotificationDeviceInfo {
  kind: NotificationDeviceKind;
  pairedAt?: number;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/u;

/** Stored preferences, each field falling back to the default when missing or invalid. */
export function storedPreferences(value: unknown): NotificationDevicePreferences {
  const stored = record(value);
  const base = DEFAULT_NOTIFICATION_PREFERENCES;
  const events = record(stored.events);
  const quiet = record(stored.quietHours);
  const flag = (raw: unknown, fallback: boolean) => (typeof raw === 'boolean' ? raw : fallback);
  return {
    scope: stored.scope === 'all' || stored.scope === 'bots' || stored.scope === 'off' ? stored.scope : base.scope,
    events: Object.fromEntries(
      NOTIFICATION_EVENTS.map((event) => [event, flag(events[event], base.events[event])])
    ) as NotificationDevicePreferences['events'],
    automaticRuns: flag(stored.automaticRuns, base.automaticRuns),
    quietHours: {
      enabled: flag(quiet.enabled, base.quietHours.enabled),
      start: typeof quiet.start === 'string' && TIME.test(quiet.start) ? quiet.start : base.quietHours.start,
      end: typeof quiet.end === 'string' && TIME.test(quiet.end) ? quiet.end : base.quietHours.end,
      days:
        quiet.days === 'every' || quiet.days === 'weekdays' || quiet.days === 'weekends'
          ? quiet.days
          : base.quietHours.days,
      allowWaiting: flag(quiet.allowWaiting, base.quietHours.allowWaiting),
    },
    holdWhileDesktopActive: flag(stored.holdWhileDesktopActive, base.holdWhileDesktopActive),
    taskbarFlash: flag(stored.taskbarFlash, base.taskbarFlash),
  };
}

export const TARGET_ID = /^[\w.:-]{1,200}$/u;

function isNotificationTarget(value: unknown): value is NotificationTarget {
  const target = record(value);
  return (
    (target.kind === 'session' || target.kind === 'agent' || target.kind === 'room') &&
    typeof target.id === 'string' &&
    TARGET_ID.test(target.id)
  );
}

export function storedOverride(value: unknown): ConversationNotificationOverride | null {
  const entry = record(value);
  if (!isNotificationTarget(entry.target)) return null;
  const setting = record(entry.setting);
  const target = { kind: entry.target.kind, id: entry.target.id };
  if (setting.mode === 'always') return { target, setting: { mode: 'always' } };
  if (setting.mode !== 'muted') return null;
  const until = setting.until === null || (Number.isSafeInteger(setting.until) && (setting.until as number) > 0);
  return until ? { target, setting: { mode: 'muted', until: setting.until as number | null } } : null;
}

/** A device's preferences: its stored entry, else the default its kind and
 *  pairing time give it. */
export function devicePreferencesIn(
  doc: { devices: Record<string, NotificationDevicePreferences>; migratedAt: number } | null,
  deviceId: string,
  info: NotificationDeviceInfo = { kind: deviceId === NOTIFICATION_PC_DEVICE_ID ? 'pc' : 'browser' }
): NotificationDevicePreferences {
  const stored = doc?.devices[deviceId];
  if (stored) return stored;
  const pairedAfter = doc && info.pairedAt !== undefined && info.pairedAt >= doc.migratedAt;
  return info.kind === 'phone-app' && pairedAfter
    ? NEW_PHONE_NOTIFICATION_PREFERENCES
    : DEFAULT_NOTIFICATION_PREFERENCES;
}

/** The overrides still in force: a mute whose end has passed is gone. */
export function activeOverrides(
  overrides: readonly ConversationNotificationOverride[],
  now: number
): ConversationNotificationOverride[] {
  return overrides.filter(
    (entry) => entry.setting.mode !== 'muted' || entry.setting.until === null || entry.setting.until > now
  );
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

export const notificationDeviceKind = (client: DesktopRemoteClientInfo): NotificationDeviceKind =>
  remoteClientKind(client.browser) === 'app' ? 'phone-app' : 'browser';

/** What a paired device's default preferences are decided from: its record's
 *  kind and creation time (immutable, unlike a push registration's). */
export function pairedDeviceInfo(client: DesktopRemoteClientInfo): NotificationDeviceInfo {
  return {
    kind: notificationDeviceKind(client),
    ...(Number.isSafeInteger(client.createdAt) && client.createdAt > 0 ? { pairedAt: client.createdAt } : {}),
  };
}

/** The stored overrides, as Node's store reads them (an entry that does not validate is dropped). */
export function storedOverrides(notifications: unknown): ConversationNotificationOverride[] {
  const stored = record(notifications);
  const list = Array.isArray(stored.overrides) ? stored.overrides : [];
  return list.map(storedOverride).filter((entry): entry is ConversationNotificationOverride => entry !== null);
}

/** The store's `migratedAt`. With no document at all Node's store writes one stamped `now` on its first load
 *  (`notification-preferences.ts:228`): a device paired before this moment gets the plain default. A document
 *  without a valid stamp reads 0 (`:120`). */
export function migratedAtOf(subtree: unknown, now = Date.now()): number {
  if (subtree === undefined) return now;
  const stamp = record(subtree).migratedAt;
  return Number.isSafeInteger(stamp) ? (stamp as number) : 0;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A paired device as the core's `remote` section lists it (`clients`). */
export function pairedClients(remote: unknown): DesktopRemoteClientInfo[] {
  const clients = record(remote).clients;
  const list = Array.isArray(clients) ? clients : [];
  return list
    .map(record)
    .filter((client) => typeof client.id === 'string' && client.id !== '')
    .map((client) => ({
      id: client.id as string,
      name: text(client.name),
      platform: text(client.platform),
      browser: text(client.browser),
      createdAt: Number(client.createdAt),
      lastSeenAt: Number(client.lastSeenAt),
      online: client.online === true,
      ...(client.pendingRemoval === true ? { pendingRemoval: true } : {}),
      ...(typeof client.alias === 'string' && client.alias ? { alias: client.alias } : {}),
    }));
}

/** How the core merges `setNotificationPreferences`' patch for `deviceId` (Node's `setPreferences`, notification-center.ts:106-117):
 *  onto the default a device without stored preferences has, which is bot chats only for a phone app paired at or after the store
 *  was first written (`devicePreferencesIn`). A device that is not paired (or whose unpair is queued) is refused as Node refused it,
 *  before anything is written. */
export function notificationWriteMode(deviceId: string, remote: unknown, notifications: unknown): 'mergePatch' | 'mergePatchBots' {
  if (deviceId === NOTIFICATION_PC_DEVICE_ID) return 'mergePatch';
  const client = pairedClients(remote).find((candidate) => candidate.id === deviceId && !candidate.pendingRemoval);
  if (!client) throw new TypeError('That device is not paired with this PC.');
  const info = pairedDeviceInfo({ ...client, name: '', platform: '', lastSeenAt: 0, online: false });
  const botsFirst = info.kind === 'phone-app' && info.pairedAt !== undefined && info.pairedAt >= migratedAtOf(notifications);
  return botsFirst ? 'mergePatchBots' : 'mergePatch';
}

/** `notificationPreferencesState(currentDeviceId, pcCanNotify)` from the core's `remote` section and `config` subtree
 *  `notifications` (undefined while it was never written): this PC, then the paired devices (the Connection tab's list), each
 *  with its stored preferences or the default its kind and pairing time give it. A paired device can be notified when the core
 *  holds a native push registration for it (`remote.pushRegistered`). */
export function notificationPreferencesStateOf(input: {
  remote: unknown;
  notifications: unknown;
  currentDeviceId: string;
  pcCanNotify: boolean;
  hostName: () => string;
}): NotificationPreferencesState {
  const remote = record(input.remote);
  const notifications = record(input.notifications);
  const registered = new Set(Array.isArray(remote.pushRegistered) ? remote.pushRegistered : []);
  const paired = pairedClients(remote).filter((client) => !client.pendingRemoval);
  const pcName = (text(record(remote.settings).name) || input.hostName()).slice(0, 80);
  const devices: NotificationDeviceSummary[] = [
    { id: NOTIFICATION_PC_DEVICE_ID, name: pcName, kind: 'pc', online: true, canNotify: input.pcCanNotify },
    ...paired.map((client) => ({
      id: client.id,
      name: notificationDeviceName(client),
      kind: pairedDeviceInfo(client).kind,
      online: client.online,
      canNotify: registered.has(client.id),
    })),
  ];
  const infos = new Map<string, NotificationDeviceInfo>([
    [NOTIFICATION_PC_DEVICE_ID, { kind: 'pc' }],
    ...paired.map((client) => [client.id, pairedDeviceInfo(client)] as const),
  ]);
  const stored = {
    migratedAt: migratedAtOf(input.notifications),
    devices: Object.fromEntries(
      Object.entries(record(notifications.devices)).map(([id, preferences]) => [id, storedPreferences(preferences)])
    ),
  };
  const preferences = Object.fromEntries(
    devices.map((device) => [device.id, devicePreferencesIn(stored, device.id, infos.get(device.id))])
  );
  return { devices, preferences, currentDeviceId: input.currentDeviceId };
}
