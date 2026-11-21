// The desktop operations whose answer is state the core already pushes (desktop-services.md §2.4, §3): the main
// process reads the sections its connection holds and normalizes them into the value the caller gets. Nothing is requested from the core and nothing is cached here:
// each call reads the held store as it is.
import type { ActivityRailPinsState } from '../activity-rail-pins';
import type { DesktopEditorSettings, DesktopSettings } from '../contract';
import type { NotificationPreferencesState } from '../contract-notifications';
import type { DesktopSectionsSnapshot } from '../contract-sections';
import { activeOverrides, migratedAtOf, notificationPreferencesStateOf, storedOverrides } from '../notification-state';
import { desktopSettingsFromConfig } from '../desktop-settings';
import { storedPinsState } from '../activity-rail-pins';
import { markdownDefaultViewSetting } from '../editor-settings';
import { terminalActivityRows } from '../terminal-protocol';

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

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The held value of `(section, key)`. A section the store lacks is "not set", as an absent config subtree is. The lane
 *  reads only after the connection's first snapshot (`whenSynced`); a link that is down since keeps its last values. */
function held(snapshot: DesktopSectionsSnapshot, section: string, key: string | null): unknown {
  return snapshot.entries.find((entry) => entry.section === section && entry.key === key)?.value;
}

/** One subtree of the core's `config` section (`desktop`, `agent`, `notifications`). */
const configTree = (snapshot: DesktopSectionsSnapshot, subtree: string): Record<string, unknown> =>
  record(held(snapshot, 'config', subtree));

/** A `config` subtree over the inline limit is held as a stub (`value` null): its value is read with `config/read`, so the
 *  readers below see the stored settings, not an empty subtree. */
const configStubs = (snapshot: DesktopSectionsSnapshot, subtrees: readonly string[]) =>
  snapshot.entries.filter(
    (entry) => entry.section === 'config' && entry.key !== null && subtrees.includes(entry.key) && entry.value === null
  );

export const hasConfigStub = (snapshot: DesktopSectionsSnapshot, subtrees: readonly string[]): boolean =>
  configStubs(snapshot, subtrees).length > 0;

/** Pages exactly the `subtrees` the caller reads that are held as stubs; every other entry, and every read that names no
 *  stubbed subtree, is left as it is (no request). */
export async function withPagedConfig(
  snapshot: DesktopSectionsSnapshot,
  call: (method: string, params: unknown) => Promise<unknown>,
  subtrees: readonly string[]
): Promise<DesktopSectionsSnapshot> {
  const stubs = configStubs(snapshot, subtrees);
  if (stubs.length === 0) return snapshot;
  const { config } = record(await call('config/read', { keys: stubs.map((entry) => entry.key) }));
  const paged = record(config);
  return {
    ...snapshot,
    entries: snapshot.entries.map((entry) =>
      stubs.includes(entry) ? { ...entry, value: paged[entry.key as string] } : entry
    ),
  };
}

/** The `config` subtrees each section read uses. */
export const SECTION_READ_CONFIG: Readonly<Record<string, readonly string[]>> = {
  readSettings: ['agent', 'desktop'],
  readActivityRailPins: ['desktop'],
  readMarkdownDefaultView: ['desktop'],
  listConversationNotifications: ['notifications'],
  notificationPreferencesState: ['notifications'],
};
/** `readSettings`: the desktop settings from the config subtrees it reads. */
export function readSettings(snapshot: DesktopSectionsSnapshot): DesktopSettings {
  return desktopSettingsFromConfig({ agent: configTree(snapshot, 'agent'), desktop: configTree(snapshot, 'desktop') });
}

export function readActivityRailPins(snapshot: DesktopSectionsSnapshot): ActivityRailPinsState | null {
  return storedPinsState(configTree(snapshot, 'desktop').activityRailPins);
}

/** The application UI always uses native scale: Node ignores what is stored and the core's key accepts only 1. */
export function readZoom(_snapshot: DesktopSectionsSnapshot): number {
  return 1;
}

/** The core adopts the legacy user preference before publishing it as canonical config. */
export function readMarkdownDefaultView(
  snapshot: DesktopSectionsSnapshot
): DesktopEditorSettings['markdownDefaultView'] {
  return markdownDefaultViewSetting(record(configTree(snapshot, 'desktop').editor).markdownDefaultView);
}

/** `listConversationNotifications`: the overrides in force now (an expired mute is not listed). */
export function listConversationNotifications(snapshot: DesktopSectionsSnapshot, now: number) {
  return activeOverrides(storedOverrides(configTree(snapshot, 'notifications')), now);
}

export { migratedAtOf };

/** `notificationPreferencesState(currentDeviceId, pcCanNotify | null)`: this PC, then the paired devices (`remote.clients`),
 *  each with its stored preferences or the default its kind and pairing time give it. A paired device can be notified
 *  when the core holds a push registration for it (`remote.pushRegistered`). `pcCanNotify` null is asked of the host. */
export async function notificationPreferencesState(
  snapshot: DesktopSectionsSnapshot,
  args: readonly unknown[],
  host: Partial<OperationHost> & Pick<OperationHost, 'hostName'>
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
    hostName: host.hostName,
  });
}

/** `visualizeRemoteViewing(sessionId)`: whether a paired device shows the session. The core
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

/** A member of the `remote` section's value, as the remote-access operations return it (`remoteAccessInfo` is the
 *  section's `info`, ...). */
export function remoteMember(section: unknown, member: string): unknown {
  const members = record(section);
  if (!(member in members)) throw new TypeError(`The remote section has no ${member}.`);
  return members[member];
}

/** `termActivity`: Node answered `[{id, state}]` of the tabs with a known state; the section is `{<tabId>: state}`. */
export function termActivity(snapshot: DesktopSectionsSnapshot): { id: string; state: unknown }[] {
  const entry = snapshot.entries.find(
    (candidate) => candidate.section === 'terminalActivity' && candidate.key === null
  );
  if (!entry) {
    throw Object.assign(new Error('The core has not pushed section terminalActivity.'), { code: 'sectionUnavailable' });
  }
  return terminalActivityRows(entry.value);
}
