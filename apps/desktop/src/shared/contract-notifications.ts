// Notification preferences (issue #221). The PC makes one decision for every
// channel (its own OS notification, taskbar flash, and pushes to paired
// devices, whose payloads are encrypted so nothing downstream can filter).
// Each device has its own preferences — this PC under NOTIFICATION_PC_DEVICE_ID,
// a paired device under its remote client id — and a conversation override
// applies on every device.

export type NotificationScope = 'all' | 'bots' | 'off';

export const NOTIFICATION_EVENTS = ['finished', 'question', 'approval', 'error'] as const;
/** finished: a final answer; question: ask_user or another wait for the user's
 *  input; approval: a tool or browser approval; error: a turn that failed. */
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export type NotificationQuietDays = 'every' | 'weekdays' | 'weekends';

export interface NotificationQuietHours {
  enabled: boolean;
  /** 'HH:MM' on the PC's local clock; an end at or before the start spans midnight. */
  start: string;
  end: string;
  days: NotificationQuietDays;
  /** Questions and approvals still notify inside quiet hours. */
  allowWaiting: boolean;
}

export interface NotificationDevicePreferences {
  /** bots: bot home chats and rooms only; all: every conversation. */
  scope: NotificationScope;
  events: Record<NotificationEvent, boolean>;
  /** Final answers and errors of turns a schedule or webhook started. Their
   *  questions and approvals follow `events` either way. */
  automaticRuns: boolean;
  quietHours: NotificationQuietHours;
  /** Paired devices: when this PC had user input in the last 3 minutes, wait a
   *  minute and push only if the conversation is still unread (a finished or
   *  failed turn) or the wait still open (a question or approval). */
  holdWhileDesktopActive: boolean;
  /** This PC: flash the taskbar / bounce the dock. */
  taskbarFlash: boolean;
}

export interface NotificationPreferencesPatch {
  scope?: NotificationScope;
  events?: Partial<Record<NotificationEvent, boolean>>;
  automaticRuns?: boolean;
  quietHours?: Partial<NotificationQuietHours>;
  holdWhileDesktopActive?: boolean;
  taskbarFlash?: boolean;
}

export const NOTIFICATION_PC_DEVICE_ID = 'pc';

export type NotificationDeviceKind = 'pc' | 'phone-app' | 'browser';

export interface NotificationDeviceSummary {
  /** NOTIFICATION_PC_DEVICE_ID, or the paired client id of Settings › Connection. */
  id: string;
  /** The Connection tab's name (alias, else the device's own name). */
  name: string;
  kind: NotificationDeviceKind;
  online: boolean;
  /** This PC: OS notifications are supported. A paired device: it holds a
   *  native or web push registration. */
  canNotify: boolean;
}

export interface NotificationPreferencesState {
  /** This PC first, then the paired devices in the Connection tab's order. */
  devices: NotificationDeviceSummary[];
  /** By device id; every listed device has an entry. */
  preferences: Record<string, NotificationDevicePreferences>;
  /** The caller: NOTIFICATION_PC_DEVICE_ID in this PC's window, the client id on a paired device. */
  currentDeviceId: string;
}

/** What a conversation override is attached to: one session, every
 *  conversation of a bot (its home chat and its runs), or a whole room. */
export interface NotificationTarget {
  kind: 'session' | 'agent' | 'room';
  id: string;
}

export type ConversationNotificationSetting =
  | { mode: 'inherit' }
  /** Notifies whatever the device scope says (quiet hours still apply). */
  | { mode: 'always' }
  /** until: epoch ms, or null for no end. */
  | { mode: 'muted'; until: number | null };

export interface ConversationNotificationOverride {
  target: NotificationTarget;
  setting: Exclude<ConversationNotificationSetting, { mode: 'inherit' }>;
}

const DEFAULT_EVENTS: Record<NotificationEvent, boolean> = {
  finished: true,
  question: true,
  approval: true,
  error: false,
};

const DEFAULT_QUIET_HOURS: NotificationQuietHours = {
  enabled: false,
  start: '23:00',
  end: '08:00',
  days: 'every',
  allowWaiting: false,
};

/** This PC, and every device that was already paired when this shipped
 *  (today's behaviour: every conversation). */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationDevicePreferences = {
  scope: 'all',
  events: DEFAULT_EVENTS,
  automaticRuns: true,
  quietHours: DEFAULT_QUIET_HOURS,
  holdWhileDesktopActive: false,
  taskbarFlash: true,
};

/** A phone app paired after this shipped starts with bot chats only. */
export const NEW_PHONE_NOTIFICATION_PREFERENCES: NotificationDevicePreferences = {
  ...DEFAULT_NOTIFICATION_PREFERENCES,
  scope: 'bots',
};
