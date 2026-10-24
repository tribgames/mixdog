// Notification preferences on this PC (issue #221), kept beside the other
// desktop metadata (`notification-preferences.json` in the app profile): one
// NotificationDevicePreferences per device (this PC under
// NOTIFICATION_PC_DEVICE_ID, a paired device under its remote client id) and
// the conversation overrides every device shares. The desktop service owns the
// writes; the window process reads the file fresh for each notification.
//
// First load migrates: `desktop.turnNotifications: false` becomes this PC's
// scope 'off', and every agent the old mute list (`agent-notifications.json`)
// named becomes a mute override with no end. A device without an entry gets
// DEFAULT_NOTIFICATION_PREFERENCES when it was paired before that migration
// (or is a browser), NEW_PHONE_NOTIFICATION_PREFERENCES when it is a phone app
// paired afterwards.
import { join } from 'node:path';

import { readJsonStateSync, writeJsonAtomicAsync } from '../../../../src/runtime/shared/atomic-file.mjs';
import {
  type ConversationNotificationOverride,
  type ConversationNotificationSetting,
  DEFAULT_NOTIFICATION_PREFERENCES,
  NEW_PHONE_NOTIFICATION_PREFERENCES,
  NOTIFICATION_EVENTS,
  NOTIFICATION_PC_DEVICE_ID,
  type NotificationDeviceKind,
  type NotificationDevicePreferences,
  type NotificationPreferencesPatch,
  type NotificationTarget,
} from '../shared/contract-notifications';
import { activeOverrides, type NotificationPreferencesView } from './notification-decision';

export interface NotificationPreferencesDoc {
  version: 1;
  /** When this file was first written: devices paired before it keep today's behaviour. */
  migratedAt: number;
  devices: Record<string, NotificationDevicePreferences>;
  overrides: ConversationNotificationOverride[];
}

/** What a device without stored preferences is: its kind, and when it was
 *  paired (or first registered for pushes) when that is known. */
export interface NotificationDeviceInfo {
  kind: NotificationDeviceKind;
  pairedAt?: number;
}

export function notificationPreferencesPath(userDataPath: string): string {
  return join(userDataPath, 'notification-preferences.json');
}

/** The pre-#221 per-agent mute list. */
export function legacyAgentMutePath(userDataPath: string): string {
  return join(userDataPath, 'agent-notifications.json');
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/u;
const MAX_OVERRIDES = 500;
const MAX_DEVICES = 200;

/** Stored preferences, each field falling back to the default when missing or invalid. */
function storedPreferences(value: unknown): NotificationDevicePreferences {
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

const TARGET_ID = /^[\w.:-]{1,200}$/u;

export function isNotificationTarget(value: unknown): value is NotificationTarget {
  const target = record(value);
  return (
    (target.kind === 'session' || target.kind === 'agent' || target.kind === 'room') &&
    typeof target.id === 'string' &&
    TARGET_ID.test(target.id)
  );
}

function storedOverride(value: unknown): ConversationNotificationOverride | null {
  const entry = record(value);
  if (!isNotificationTarget(entry.target)) return null;
  const setting = record(entry.setting);
  const target = { kind: entry.target.kind, id: entry.target.id };
  if (setting.mode === 'always') return { target, setting: { mode: 'always' } };
  if (setting.mode !== 'muted') return null;
  const until = setting.until === null || (Number.isSafeInteger(setting.until) && (setting.until as number) > 0);
  return until ? { target, setting: { mode: 'muted', until: setting.until as number | null } } : null;
}

function storedDoc(value: unknown): NotificationPreferencesDoc {
  const doc = record(value);
  if (doc.version !== 1) throw new TypeError('The notification preferences are not version 1.');
  const devices: Record<string, NotificationDevicePreferences> = {};
  for (const [id, prefs] of Object.entries(record(doc.devices)).slice(0, MAX_DEVICES)) {
    devices[id] = storedPreferences(prefs);
  }
  const overrides = (Array.isArray(doc.overrides) ? doc.overrides : [])
    .map(storedOverride)
    .filter((entry): entry is ConversationNotificationOverride => entry !== null)
    .slice(0, MAX_OVERRIDES);
  const migratedAt = Number.isSafeInteger(doc.migratedAt) ? (doc.migratedAt as number) : 0;
  return { version: 1, migratedAt, devices, overrides };
}

/** The file as it is on disk, or null when there is none yet. */
export function readNotificationPreferencesFile(filePath: string): NotificationPreferencesDoc | null {
  try {
    // A damaged file is kept aside and its last good copy read.
    return readJsonStateSync(filePath, { validate: storedDoc, fallback: null });
  } catch {
    return null;
  }
}

/** A device's preferences: its stored entry, else the default its kind and
 *  pairing time give it. */
export function devicePreferencesIn(
  doc: Pick<NotificationPreferencesDoc, 'devices' | 'migratedAt'> | null,
  deviceId: string,
  info: NotificationDeviceInfo = { kind: deviceId === NOTIFICATION_PC_DEVICE_ID ? 'pc' : 'browser' }
): NotificationDevicePreferences {
  const stored = doc?.devices[deviceId];
  if (stored) return stored;
  const pairedAfter = doc && info.pairedAt !== undefined && info.pairedAt >= doc.migratedAt;
  return info.kind === 'phone-app' && pairedAfter ? NEW_PHONE_NOTIFICATION_PREFERENCES : DEFAULT_NOTIFICATION_PREFERENCES;
}

/** This PC's view, read from disk (the window process). */
export function readPcNotificationView(filePath: string, now = Date.now()): NotificationPreferencesView {
  const doc = readNotificationPreferencesFile(filePath);
  return {
    preferences: devicePreferencesIn(doc, NOTIFICATION_PC_DEVICE_ID),
    overrides: activeOverrides(doc?.overrides ?? [], now),
  };
}

/** `current` with `patch` applied; a patch is validated before it gets here. */
export function applyNotificationPreferencesPatch(
  current: NotificationDevicePreferences,
  patch: NotificationPreferencesPatch
): NotificationDevicePreferences {
  return storedPreferences({
    ...current,
    ...patch,
    events: { ...current.events, ...patch.events },
    quietHours: { ...current.quietHours, ...patch.quietHours },
  });
}

/** The mute list the pre-#221 desktop kept; empty when absent or unreadable. */
export function readLegacyMutedAgents(filePath: string): string[] {
  try {
    const doc = readJsonStateSync(filePath, { validate: record, fallback: {} }) as { muted?: unknown };
    return Array.isArray(doc.muted) ? doc.muted.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** What the migration reads, once, when there is no file yet. */
export interface NotificationLegacySettings {
  /** The removed `desktop.turnNotifications` setting (default on). */
  turnNotifications: boolean;
  mutedAgents: readonly string[];
}

export function migratedNotificationPreferences(
  legacy: NotificationLegacySettings,
  now: number
): NotificationPreferencesDoc {
  return {
    version: 1,
    migratedAt: now,
    devices: {
      [NOTIFICATION_PC_DEVICE_ID]: {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        scope: legacy.turnNotifications ? DEFAULT_NOTIFICATION_PREFERENCES.scope : 'off',
      },
    },
    overrides: [...new Set(legacy.mutedAgents)]
      .filter((id) => TARGET_ID.test(id))
      .map((id) => ({ target: { kind: 'agent', id }, setting: { mode: 'muted', until: null } })),
  };
}

interface NotificationPreferencesStoreOptions {
  filePath: string;
  readLegacy(): Promise<NotificationLegacySettings>;
  now?: () => number;
  /** Once per persisted change (SettingsChange { scope: 'notifications' });
   *  never for the first load's migration or a change that writes nothing. */
  onChange?: () => void;
}

/** One mutation: the next document to persist (null: nothing changes) and its result. */
type Mutation<T> = (current: NotificationPreferencesDoc) => { next: NotificationPreferencesDoc | null; result: T };

export function createNotificationPreferencesStore({
  filePath,
  readLegacy,
  now = Date.now,
  onChange,
}: NotificationPreferencesStoreOptions) {
  let doc: NotificationPreferencesDoc | null = null;
  const write = (next: NotificationPreferencesDoc): Promise<void> =>
    writeJsonAtomicAsync(filePath, next, { backup: true }).then(() => undefined);
  const loading = (async () => {
    const stored = readNotificationPreferencesFile(filePath);
    if (stored) {
      doc = stored;
      return;
    }
    const migrated = migratedNotificationPreferences(await readLegacy(), now());
    await write(migrated);
    doc = migrated;
  })();
  // Every mutation reads, changes and persists the document inside one queue,
  // so two writers can never start from the same snapshot.
  let queue: Promise<unknown> = loading;
  const mutate = <T>(change: Mutation<T>): Promise<T> => {
    const run = queue.then(async () => {
      const { next, result } = change(doc!);
      if (next) {
        await write(next);
        doc = next;
        onChange?.();
      }
      return result;
    });
    // A failed write must not poison every later one.
    queue = run.catch(() => undefined);
    return run;
  };
  const current = async (): Promise<NotificationPreferencesDoc> => {
    await loading;
    return doc!;
  };
  const prunedOverrides = (overrides: readonly ConversationNotificationOverride[]) =>
    activeOverrides(overrides, now());
  /** `entries`' preferences; each one with none stored gets its default written. */
  const withDefaults = (entries: ReadonlyArray<{ id: string; info: NotificationDeviceInfo }>) =>
    mutate((value) => {
      const result: Record<string, NotificationDevicePreferences> = {};
      const missing: Record<string, NotificationDevicePreferences> = {};
      for (const { id, info } of entries) {
        result[id] = devicePreferencesIn(value, id, info);
        if (!value.devices[id]) missing[id] = result[id];
      }
      const next = Object.keys(missing).length ? { ...value, devices: { ...value.devices, ...missing } } : null;
      return { next, result };
    });

  return {
    /** Resolves once the file is loaded or migrated. */
    ready: async (): Promise<void> => {
      await loading;
    },
    async device(deviceId: string, info?: NotificationDeviceInfo): Promise<NotificationDevicePreferences> {
      return devicePreferencesIn(await current(), deviceId, info);
    },
    /** A paired device's preferences at delivery. With none stored, its own
     *  pairing record (kind, creation time — never a push registration's,
     *  which a re-registration resets) gives the default, which is then
     *  written so it never changes; with no record known it gets
     *  DEFAULT_NOTIFICATION_PREFERENCES, unwritten. */
    async resolveDevice(
      deviceId: string,
      pairingRecord: () => Promise<NotificationDeviceInfo | null>
    ): Promise<NotificationDevicePreferences> {
      const value = await current();
      if (value.devices[deviceId]) return value.devices[deviceId];
      const info = await pairingRecord();
      if (!info || info.pairedAt === undefined) return devicePreferencesIn(value, deviceId, info ?? undefined);
      return (await withDefaults([{ id: deviceId, info }]))[deviceId];
    },
    async view(deviceId: string, info?: NotificationDeviceInfo): Promise<NotificationPreferencesView> {
      const value = await current();
      return { preferences: devicePreferencesIn(value, deviceId, info), overrides: prunedOverrides(value.overrides) };
    },
    /** Every listed device's preferences; one with none stored gets its default written. */
    devices: withDefaults,
    setDevice(
      deviceId: string,
      patch: NotificationPreferencesPatch,
      info?: NotificationDeviceInfo
    ): Promise<NotificationDevicePreferences> {
      return mutate((value) => {
        const next = applyNotificationPreferencesPatch(devicePreferencesIn(value, deviceId, info), patch);
        return { next: { ...value, devices: { ...value.devices, [deviceId]: next } }, result: next };
      });
    },
    /** A revoked device's preferences go with its push registrations. */
    removeDevice(deviceId: string): Promise<void> {
      return mutate((value) => {
        if (!value.devices[deviceId] || deviceId === NOTIFICATION_PC_DEVICE_ID) return { next: null, result: undefined };
        const devices = { ...value.devices };
        delete devices[deviceId];
        return { next: { ...value, devices }, result: undefined };
      });
    },
    /** The overrides in force; an expired mute is not listed. */
    async overrides(): Promise<ConversationNotificationOverride[]> {
      return prunedOverrides((await current()).overrides);
    },
    setConversation(
      target: NotificationTarget,
      setting: ConversationNotificationSetting
    ): Promise<ConversationNotificationOverride[]> {
      return mutate((value) => {
        const kept = prunedOverrides(value.overrides).filter(
          (entry) => entry.target.kind !== target.kind || entry.target.id !== target.id
        );
        const overrides: ConversationNotificationOverride[] =
          setting.mode === 'inherit'
            ? kept
            : [...kept, { target: { kind: target.kind, id: target.id }, setting }].slice(-MAX_OVERRIDES);
        return { next: { ...value, overrides }, result: overrides };
      });
    },
  };
}

export type NotificationPreferencesStore = ReturnType<typeof createNotificationPreferencesStore>;
