// The desktop operations whose answer is state the core already pushes (desktop-services.md §2.4, §3): the main
// process reads the sections its connection holds and applies Node's own normalizers to them, so the value is what
// the Node handlers returned from the same facts. Nothing is requested from the core and nothing is cached here:
// each call reads the held store as it is.
import { hostname } from 'node:os';

import type { ActivityRailPinsState } from '../../shared/activity-rail-pins';
import type { DesktopRemoteClientInfo, DesktopSettings } from '../../shared/contract';
import {
  type ConversationNotificationOverride,
  NOTIFICATION_PC_DEVICE_ID,
  type NotificationDeviceSummary,
  type NotificationPreferencesState,
} from '../../shared/contract-notifications';
import type { DesktopSectionsSnapshot } from '../../shared/contract-sections';
import { notificationDeviceName, pairedDeviceInfo } from '../notification-center';
import { activeOverrides } from '../notification-decision';
import { devicePreferencesIn, storedOverride, storedPreferences } from '../notification-preferences';
import { desktopSettingsFromConfig, storedPinsState } from '../settings-store';
import { markdownDefaultViewSetting } from '../../shared/editor-settings';

/** What only this process knows. */
export interface OperationHost {
  /** Whether this PC's OS shows notifications; asked only when the caller did not say. */
  pcNotificationsSupported(): Promise<boolean>;
  /** What this PC's own window shows (theme, UI language), or null when unknown: published as
   *  `hostState.displayPreferences` wherever Node announced a desktop settings change. */
  readDisplayPreferences(): Promise<unknown>;
  /** Raises an event for this process's own windows, as the Node service's broadcast reached them. */
  emitDesktopEvent(name: string, value: unknown): void;
  /** The machine's name, for a PC that has set no remote-access name. */
  hostName(): string;
}

export const DEFAULT_OPERATION_HOST: Pick<OperationHost, 'hostName'> = { hostName: hostname };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The held value of `(section, key)`. A section the store lacks is "not set", as an absent config subtree is. The lane
 *  reads only after the connection's first snapshot (`whenSynced`); a link that is down since keeps its last values. */
function held(snapshot: DesktopSectionsSnapshot, section: string, key: string | null): unknown {
  return snapshot.entries.find((entry) => entry.section === section && entry.key === key)?.value;
}

/** One subtree of the core's `config` section (`desktop`, `agent`, `notifications`). */
const configTree = (snapshot: DesktopSectionsSnapshot, subtree: string): Record<string, unknown> =>
  record(held(snapshot, 'config', subtree));

/** `readSettings`: Node's `desktopSettingsFromConfig` over the subtrees it reads. */
export function readSettings(snapshot: DesktopSectionsSnapshot): DesktopSettings {
  return desktopSettingsFromConfig({ agent: configTree(snapshot, 'agent'), desktop: configTree(snapshot, 'desktop') });
}

export function readActivityRailPins(snapshot: DesktopSectionsSnapshot): ActivityRailPinsState | null {
  return storedPinsState(configTree(snapshot, 'desktop').activityRailPins);
}

/** The application UI always uses native scale: Node ignores what is stored and the core's key accepts only 1. */
export function readZoom(snapshot: DesktopSectionsSnapshot): number {
  held(snapshot, 'config', 'desktop');
  return 1;
}

export function readMarkdownDefaultView(snapshot: DesktopSectionsSnapshot) {
  return markdownDefaultViewSetting(record(configTree(snapshot, 'desktop').editor).markdownDefaultView);
}

/** The stored overrides, as Node's store reads them (an entry that does not validate is dropped). */
function storedOverrides(notifications: Record<string, unknown>): ConversationNotificationOverride[] {
  const list = Array.isArray(notifications.overrides) ? notifications.overrides : [];
  return list.map(storedOverride).filter((entry): entry is ConversationNotificationOverride => entry !== null);
}

/** `listConversationNotifications`: the overrides in force now (an expired mute is not listed). */
export function listConversationNotifications(snapshot: DesktopSectionsSnapshot, now: number) {
  return activeOverrides(storedOverrides(configTree(snapshot, 'notifications')), now);
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A paired device as `remote.clients` lists it. */
function pairedClients(remote: Record<string, unknown>): DesktopRemoteClientInfo[] {
  const list = Array.isArray(remote.clients) ? remote.clients : [];
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

/** The store's `migratedAt`. With no document at all Node's store writes one stamped `now` on its first load
 *  (`notification-preferences.ts:228`): a device paired before this moment gets the plain default. A document
 *  without a valid stamp reads 0 (`:120`). */
export function migratedAtOf(subtree: unknown, now = Date.now()): number {
  if (subtree === undefined) return now;
  const stamp = record(subtree).migratedAt;
  return Number.isSafeInteger(stamp) ? (stamp as number) : 0;
}

/** `notificationPreferencesState(currentDeviceId, pcCanNotify | null)`: this PC, then the paired devices (the
 *  Connection tab's list, `remote.clients`), each with its stored preferences or the default its kind and pairing
 *  time give it. A paired device can be notified when the core holds a native push registration for it
 *  (`remote.pushRegistered`). `pcCanNotify` null is asked of the host. */
export async function notificationPreferencesState(
  snapshot: DesktopSectionsSnapshot,
  args: readonly unknown[],
  host: Partial<OperationHost>
): Promise<NotificationPreferencesState> {
  const [currentDeviceId, pcCanNotify] = args;
  const remote = record(held(snapshot, 'remote', null));
  const notifications = configTree(snapshot, 'notifications');
  const hostName = host.hostName ?? DEFAULT_OPERATION_HOST.hostName;
  let supported: boolean;
  if (typeof pcCanNotify === 'boolean') supported = pcCanNotify;
  else if (host.pcNotificationsSupported) supported = await host.pcNotificationsSupported();
  else throw new TypeError('notificationPreferencesState needs pcCanNotify: this connection has no host to ask.');
  const registered = new Set(Array.isArray(remote.pushRegistered) ? remote.pushRegistered : []);
  const paired = pairedClients(remote).filter((client) => !client.pendingRemoval);
  const pcName = (text(record(remote.settings).name) || hostName()).slice(0, 80);
  const devices: NotificationDeviceSummary[] = [
    { id: NOTIFICATION_PC_DEVICE_ID, name: pcName, kind: 'pc', online: true, canNotify: supported },
    ...paired.map((client) => ({
      id: client.id,
      name: notificationDeviceName(client),
      kind: pairedDeviceInfo(client).kind,
      online: client.online,
      canNotify: registered.has(client.id),
    })),
  ];
  const infos = new Map([
    [NOTIFICATION_PC_DEVICE_ID, { kind: 'pc' as const }],
    ...paired.map((client) => [client.id, pairedDeviceInfo(client)] as const),
  ]);
  const stored = {
    migratedAt: migratedAtOf(held(snapshot, 'config', 'notifications')),
    devices: Object.fromEntries(
      Object.entries(record(notifications.devices)).map(([id, preferences]) => [id, storedPreferences(preferences)])
    ),
  };
  const preferences = Object.fromEntries(
    devices.map((device) => [device.id, devicePreferencesIn(stored, device.id, infos.get(device.id))])
  );
  return { devices, preferences, currentDeviceId: String(currentDeviceId ?? '') };
}

/** `visualizeRemoteViewing(sessionId)`: whether a paired device shows the session (Node's `relay.viewsSessionLane`). The core
 *  publishes the sessions they show as `hostState` key `remoteViewing` = { sessionIds }. */
export function visualizeRemoteViewing(snapshot: DesktopSectionsSnapshot, args: readonly unknown[]): boolean {
  const shown = record(held(snapshot, 'hostState', 'remoteViewing')).sessionIds;
  return Array.isArray(shown) && shown.includes(String(args[0] || ''));
}

/** The core's `remote` section as the connection holds it. A section the core has not pushed is an error, never an empty
 *  answer; `null` is a section the core published as a stub (over the inline limit), whose detail is paged. */
export function remoteSection(snapshot: DesktopSectionsSnapshot): unknown {
  const entry = snapshot.entries.find((candidate) => candidate.section === 'remote' && candidate.key === null);
  if (!entry) {
    throw Object.assign(new Error('The core has not pushed section remote.'), { code: 'sectionUnavailable' });
  }
  return entry.value;
}

/** A member of the `remote` section's value, as Node's remote-access handler returned it (`remoteAccessInfo` is the
 *  section's `info`, ...). */
export function remoteMember(section: unknown, member: string): unknown {
  const members = record(section);
  if (!(member in members)) throw new TypeError(`The remote section has no ${member}.`);
  return members[member];
}

export const remoteAccessMember = (snapshot: DesktopSectionsSnapshot, member: string): unknown =>
  remoteMember(remoteSection(snapshot), member);
/** `termActivity`: Node answered `[{id, state}]` of the tabs with a known state; the section is `{<tabId>: state}`. */
export function termActivity(snapshot: DesktopSectionsSnapshot): { id: string; state: unknown }[] {
  const entry = snapshot.entries.find((candidate) => candidate.section === 'terminalActivity' && candidate.key === null);
  if (!entry) {
    throw Object.assign(new Error('The core has not pushed section terminalActivity.'), { code: 'sectionUnavailable' });
  }
  return Object.entries(record(entry.value)).map(([id, state]) => ({ id, state }));
}
