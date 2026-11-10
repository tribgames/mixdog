// The argument checks of the desktop settings and notification calls, with Node's exact texts (main/ipc-validation.ts at
// b6f10295a, :2195-2329): the window's IPC handlers and the paired phone's adapter (renderer/remote-protocol-settings.ts) run
// the same ones before anything is written.
import type { DesktopSettingKey } from './contract';
import {
  type ConversationNotificationSetting,
  NOTIFICATION_EVENTS,
  type NotificationPreferencesPatch,
  type NotificationTarget,
} from './contract-notifications';

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid.`);
  return value as Record<string, unknown>;
}

export function requiredDesktopSettingKey(value: unknown): DesktopSettingKey {
  if (
    value === 'autoClear' ||
    value === 'autoCompact' ||
    value === 'keepAwake' ||
    value === 'runInBackground' ||
    value === 'usagePinned' ||
    value === 'usageRailShortLong' ||
    value === 'usageAccountsExpanded' ||
    value === 'usageRailSlotsThree' ||
    value === 'usageRailSlotsAll' ||
    value === 'computerControl' ||
    value === 'computerObserveOnly' ||
    value === 'browserControl' ||
    value === 'browserAutoSignIn' ||
    value === 'browserHidDevices' ||
    value === 'saveChatLogins' ||
    value === 'computerInstalled' ||
    value === 'browserInstalled'
  )
    return value;
  throw new TypeError('setting key is invalid.');
}

const NOTIFICATION_DEVICE_ID = /^[\w.:-]{1,80}$/u;
const NOTIFICATION_TARGET_ID = /^[\w.:-]{1,200}$/u;
const NOTIFICATION_TIME = /^([01]\d|2[0-3]):[0-5]\d$/u;
const NOTIFICATION_PATCH_KEYS = new Set([
  'scope',
  'events',
  'automaticRuns',
  'quietHours',
  'holdWhileDesktopActive',
  'taskbarFlash',
]);
const NOTIFICATION_QUIET_KEYS = new Set(['enabled', 'start', 'end', 'days', 'allowWaiting']);

function onlyKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError(`${name} has an unsupported field: ${key}.`);
  }
}

function optionalBoolean(input: Record<string, unknown>, key: string, name: string): boolean | undefined {
  if (input[key] === undefined) return undefined;
  if (typeof input[key] !== 'boolean') throw new TypeError(`${name}.${key} must be a boolean.`);
  return input[key] as boolean;
}

/** A notification device: NOTIFICATION_PC_DEVICE_ID or a paired client id. */
export function requiredNotificationDeviceId(value: unknown): string {
  if (typeof value !== 'string' || !NOTIFICATION_DEVICE_ID.test(value)) {
    throw new TypeError('notification device id is invalid.');
  }
  return value;
}

export function requiredNotificationPreferencesPatch(value: unknown): NotificationPreferencesPatch {
  const input = plainRecord(value, 'notification preferences');
  onlyKeys(input, NOTIFICATION_PATCH_KEYS, 'notification preferences');
  const patch: NotificationPreferencesPatch = {};
  if (input.scope !== undefined) {
    if (input.scope !== 'all' && input.scope !== 'bots' && input.scope !== 'off') {
      throw new TypeError('notification scope is invalid.');
    }
    patch.scope = input.scope;
  }
  if (input.events !== undefined) {
    const events = plainRecord(input.events, 'notification events');
    onlyKeys(events, new Set(NOTIFICATION_EVENTS), 'notification events');
    patch.events = {};
    for (const event of NOTIFICATION_EVENTS) {
      const enabled = optionalBoolean(events, event, 'notification events');
      if (enabled !== undefined) patch.events[event] = enabled;
    }
  }
  if (input.quietHours !== undefined) {
    const quiet = plainRecord(input.quietHours, 'quiet hours');
    onlyKeys(quiet, NOTIFICATION_QUIET_KEYS, 'quiet hours');
    patch.quietHours = {};
    for (const key of ['enabled', 'allowWaiting'] as const) {
      const flag = optionalBoolean(quiet, key, 'quiet hours');
      if (flag !== undefined) patch.quietHours[key] = flag;
    }
    for (const key of ['start', 'end'] as const) {
      if (quiet[key] === undefined) continue;
      if (typeof quiet[key] !== 'string' || !NOTIFICATION_TIME.test(quiet[key] as string)) {
        throw new TypeError(`quiet hours ${key} must be HH:MM.`);
      }
      patch.quietHours[key] = quiet[key] as string;
    }
    if (quiet.days !== undefined) {
      if (quiet.days !== 'every' && quiet.days !== 'weekdays' && quiet.days !== 'weekends') {
        throw new TypeError('quiet hours days is invalid.');
      }
      patch.quietHours.days = quiet.days;
    }
  }
  for (const key of ['automaticRuns', 'holdWhileDesktopActive', 'taskbarFlash'] as const) {
    const flag = optionalBoolean(input, key, 'notification preferences');
    if (flag !== undefined) patch[key] = flag;
  }
  return patch;
}

export function requiredNotificationTarget(value: unknown): NotificationTarget {
  const input = plainRecord(value, 'notification target');
  onlyKeys(input, new Set(['kind', 'id']), 'notification target');
  if (input.kind !== 'session' && input.kind !== 'agent' && input.kind !== 'room') {
    throw new TypeError('notification target kind is invalid.');
  }
  if (typeof input.id !== 'string' || !NOTIFICATION_TARGET_ID.test(input.id)) {
    throw new TypeError('notification target id is invalid.');
  }
  return { kind: input.kind, id: input.id };
}

export function requiredConversationNotificationSetting(value: unknown): ConversationNotificationSetting {
  const input = plainRecord(value, 'notification setting');
  if (input.mode === 'inherit' || input.mode === 'always') {
    onlyKeys(input, new Set(['mode']), 'notification setting');
    return { mode: input.mode };
  }
  if (input.mode !== 'muted') throw new TypeError('notification setting mode is invalid.');
  onlyKeys(input, new Set(['mode', 'until']), 'notification setting');
  const until = input.until;
  if (until !== null && !(Number.isSafeInteger(until) && (until as number) > 0)) {
    throw new TypeError('notification mute end must be epoch milliseconds or null.');
  }
  return { mode: 'muted', until: until as number | null };
}
