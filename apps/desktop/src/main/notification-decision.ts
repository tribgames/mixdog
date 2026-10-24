// The one decision every notification channel makes (issue #221): this PC's
// OS notification and sound, the Browser Use approval toast, a server window's
// toasts, the taskbar flash, and every push to a paired device. Pure: the
// caller supplies the device's preferences, the conversation overrides, the
// clock and what the device is showing. Order (design C):
//   1 quiet hours   2 conversation override   3 device scope   4 event toggle
//   5 automatic runs   6 presence
import { agentIdOfHomeSession } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import {
  roomIdOfSession,
  roomMemberOfSession,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import { runOwnerOf } from '../../../../src/runtime/shared/held-request-host.mjs';
import type { DesktopSessionSummary } from '../shared/contract';
import type {
  ConversationNotificationOverride,
  NotificationDevicePreferences,
  NotificationEvent,
  NotificationQuietHours,
} from '../shared/contract-notifications';

/** bot: a bot's home chat; room: a group room (its log or a member's session);
 *  task: a session a bot created, or a bot's unattended run; coding: any other. */
export type NotificationConversationKind = 'bot' | 'room' | 'task' | 'coding';
/** What started the turn: the user, or a schedule or webhook. */
export type NotificationOrigin = 'user' | 'schedule' | 'webhook';

/** The conversation a notification is about, as the decision reads it. */
export interface NotificationConversation {
  sessionId: string;
  kind: NotificationConversationKind;
  origin: NotificationOrigin;
  /** The bot an agent override reaches: its home chat, its room member
   *  session, or its unattended run; '' for none. */
  agentId: string;
  /** The room a room override reaches; '' for none. */
  roomId: string;
}

/** One device's preferences and every conversation override, read at delivery. */
export interface NotificationPreferencesView {
  preferences: NotificationDevicePreferences;
  overrides: readonly ConversationNotificationOverride[];
}

type SessionFields = Pick<DesktopSessionSummary, 'id'> &
  Partial<Pick<DesktopSessionSummary, 'agentHome' | 'agentRoom' | 'taskAgent' | 'sessionMode' | 'sourceType'>>;

/** The conversation of a session-summary row (or of a bare session id). */
export function notificationConversationOf(session: SessionFields): NotificationConversation {
  const sessionId = String(session.id || '');
  const member = roomMemberOfSession(sessionId);
  const roomId = session.agentRoom?.id || roomIdOfSession(sessionId) || member?.roomId || '';
  const homeAgent = session.agentHome || agentIdOfHomeSession(sessionId);
  const agentId = homeAgent || member?.agentId || runOwnerOf(sessionId) || '';
  let kind: NotificationConversationKind = 'coding';
  if (roomId) kind = 'room';
  else if (homeAgent) kind = 'bot';
  else if (session.taskAgent || session.sessionMode === 'agent' || agentId) kind = 'task';
  const origin: NotificationOrigin =
    session.sourceType === 'schedule' || session.sourceType === 'webhook' ? session.sourceType : 'user';
  return { sessionId, kind, origin, agentId, roomId };
}

const WAITING_EVENTS: ReadonlySet<NotificationEvent> = new Set(['question', 'approval']);

function minutesOf(value: string): number {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

function dayMatches(days: NotificationQuietHours['days'], day: number): boolean {
  if (days === 'weekdays') return day >= 1 && day <= 5;
  if (days === 'weekends') return day === 0 || day === 6;
  return true;
}

/** Inside the quiet hours on this PC's local clock. An end at or before the
 *  start spans midnight; `days` names the day the quiet period starts on. */
export function inQuietHours(quiet: NotificationQuietHours, now: number): boolean {
  if (!quiet.enabled) return false;
  const at = new Date(now);
  const minute = at.getHours() * 60 + at.getMinutes();
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  const today = at.getDay();
  if (start < end) return minute >= start && minute < end && dayMatches(quiet.days, today);
  if (minute >= start) return dayMatches(quiet.days, today);
  if (minute < end) return dayMatches(quiet.days, (today + 6) % 7);
  return false;
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

/** The most specific override in force: the session, then its room, then its bot. */
export function conversationOverride(
  conversation: NotificationConversation,
  overrides: readonly ConversationNotificationOverride[],
  now: number
): ConversationNotificationOverride | null {
  const active = activeOverrides(overrides, now);
  const find = (kind: 'session' | 'room' | 'agent', id: string) =>
    id ? active.find((entry) => entry.target.kind === kind && entry.target.id === id) : undefined;
  return (
    find('session', conversation.sessionId) ??
    find('room', conversation.roomId) ??
    find('agent', conversation.agentId) ??
    null
  );
}

export type NotificationSkipReason =
  | 'quiet-hours'
  | 'muted'
  | 'scope'
  | 'event'
  | 'automatic-runs'
  | 'foreground'
  | 'desktop-active';

export type NotificationDecision = { notify: true } | { notify: false; reason: NotificationSkipReason };

export interface NotificationDecisionInput extends NotificationPreferencesView {
  event: NotificationEvent;
  conversation: NotificationConversation;
  /** Epoch ms; quiet hours read it on this PC's local clock. */
  now: number;
  /** That device shows this conversation in the foreground. */
  foreground: boolean;
  /** A paired device's push: this PC had OS user input in the last 3 minutes. */
  desktopActive?: boolean;
}

const skip = (reason: NotificationSkipReason): NotificationDecision => ({ notify: false, reason });

export function decideNotification(input: NotificationDecisionInput): NotificationDecision {
  const { event, conversation, preferences, now } = input;
  if (inQuietHours(preferences.quietHours, now) && !(preferences.quietHours.allowWaiting && WAITING_EVENTS.has(event))) {
    return skip('quiet-hours');
  }
  const override = conversationOverride(conversation, input.overrides, now);
  if (override?.setting.mode === 'muted') return skip('muted');
  if (override?.setting.mode !== 'always') {
    if (preferences.scope === 'off') return skip('scope');
    if (preferences.scope === 'bots' && conversation.kind !== 'bot' && conversation.kind !== 'room') {
      return skip('scope');
    }
    if (!preferences.events[event]) return skip('event');
  }
  const automatic = conversation.origin !== 'user';
  const result = event === 'finished' || event === 'error';
  if (automatic && result && !preferences.automaticRuns) return skip('automatic-runs');
  // A schedule's or webhook's result notifies even on screen: nobody asked
  // for it in that moment.
  if (input.foreground && !(automatic && result)) return skip('foreground');
  if (preferences.holdWhileDesktopActive && input.desktopActive === true) return skip('desktop-active');
  return { notify: true };
}

/** This PC's taskbar flash / dock bounce for a finished turn: its own switch,
 *  the quiet hours and a conversation mute. */
export function allowsTaskbarFlash(
  view: NotificationPreferencesView,
  conversation: NotificationConversation,
  now: number
): boolean {
  if (!view.preferences.taskbarFlash || inQuietHours(view.preferences.quietHours, now)) return false;
  return conversationOverride(conversation, view.overrides, now)?.setting.mode !== 'muted';
}

/** Notices that belong to no conversation (a server window's link dropping or
 *  coming back): the device's scope and quiet hours. */
export function allowsDeviceNotice(preferences: NotificationDevicePreferences, now: number): boolean {
  return preferences.scope !== 'off' && !inQuietHours(preferences.quietHours, now);
}

/** A paired device holding pushes while this PC is in use looks back this far. */
export const DESKTOP_ACTIVE_WINDOW_SECONDS = 180;

/** How long a push held for an in-use PC waits for the user to see it there
 *  before it goes to the device after all. */
export const DESKTOP_HOLD_MS = 60_000;
