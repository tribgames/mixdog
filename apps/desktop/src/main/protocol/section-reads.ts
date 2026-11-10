// The desktop operations whose answer is state the core already pushes (desktop-services.md §2.4, §3): the main
// process reads the sections its connection holds and applies Node's own normalizers to them, so the value is what
// the Node handlers returned from the same facts. Nothing is requested from the core and nothing is cached here:
// each call reads the held store as it is.
import { hostname } from 'node:os';

import type { ActivityRailPinsState } from '../../shared/activity-rail-pins';
import type { DesktopSettings } from '../../shared/contract';
import type { NotificationPreferencesState } from '../../shared/contract-notifications';
import type { DesktopSectionsSnapshot } from '../../shared/contract-sections';
import {
  activeOverrides,
  migratedAtOf,
  notificationPreferencesStateOf,
  storedOverrides,
} from '../../shared/notification-state';
import { desktopSettingsFromConfig, storedPinsState } from '../settings-store';
import { markdownDefaultViewSetting } from '../../shared/editor-settings';
import { terminalActivityRows } from '../../shared/terminal-protocol';

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

/** `listConversationNotifications`: the overrides in force now (an expired mute is not listed). */
export function listConversationNotifications(snapshot: DesktopSectionsSnapshot, now: number) {
  return activeOverrides(storedOverrides(configTree(snapshot, 'notifications')), now);
}

export { migratedAtOf };

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
  let supported: boolean;
  if (typeof pcCanNotify === 'boolean') supported = pcCanNotify;
  else if (host.pcNotificationsSupported) supported = await host.pcNotificationsSupported();
  else throw new TypeError('notificationPreferencesState needs pcCanNotify: this connection has no host to ask.');
  return notificationPreferencesStateOf({
    remote: held(snapshot, 'remote', null),
    notifications: held(snapshot, 'config', 'notifications'),
    currentDeviceId: String(currentDeviceId ?? ''),
    pcCanNotify: supported,
    hostName: host.hostName ?? DEFAULT_OPERATION_HOST.hostName,
  });
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
  return terminalActivityRows(entry.value);
}
