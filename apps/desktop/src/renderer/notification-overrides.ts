// Per-conversation notification overrides (issue #221): one shared store that
// reads the PC's override list and this device's scope, refreshes on every
// settings change, and ticks when a timed mute expires. Menus read the
// snapshot when they open; rows and the header bell subscribe.
import { useSyncExternalStore } from 'react';
import { agentIdOfHomeSession } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import {
  roomIdOfSession,
  roomMemberOfSession,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type {
  ConversationNotificationOverride,
  ConversationNotificationSetting,
  NotificationScope,
  NotificationTarget,
} from '../shared/contract-notifications';
import { errorMessageText } from './ErrorNotice';
import { showDesktopToast } from './notifications';
import { subscribeSetupChanges } from './setup-change-refresh';

export interface NotificationSnapshot {
  overrides: readonly ConversationNotificationOverride[];
  /** This device's scope. */
  scope: NotificationScope;
  /** The clock the snapshot was taken at; a timer renews it when a mute ends. */
  now: number;
}

/** What a conversation does with notifications right now.
 *  outside: a coding session the device scope ('bots') leaves out. */
export type ConversationNotificationState =
  | { kind: 'on' }
  | { kind: 'outside' }
  /** source: the target whose override decides (the session, its room or its bot). */
  | { kind: 'always'; source: NotificationTarget }
  | { kind: 'muted'; until: number | null; source: NotificationTarget };

const MAX_TIMER_MS = 2 ** 31 - 1;

let snapshot: NotificationSnapshot = { overrides: [], scope: 'all', now: Date.now() };
const listeners = new Set<() => void>();
let stopSetupSync: (() => void) | null = null;
let timer: number | undefined;
let refreshSeq = 0;

const same = (a: NotificationTarget, b: NotificationTarget) => a.kind === b.kind && a.id === b.id;

function stillActive(override: ConversationNotificationOverride, now: number): boolean {
  const { setting } = override;
  return setting.mode !== 'muted' || setting.until === null || setting.until > now;
}

/** When a shown timed mute next needs a re-render: its end, or the next local
 *  midnight (its "until 8:00 AM" becomes "until today" / "until tomorrow" then).
 *  null while no timed mute is active. */
export function nextNotificationWake(
  overrides: readonly ConversationNotificationOverride[],
  now: number
): number | null {
  let expiry = Number.POSITIVE_INFINITY;
  for (const { setting } of overrides) {
    if (setting.mode === 'muted' && setting.until !== null && setting.until > now) {
      expiry = Math.min(expiry, setting.until);
    }
  }
  if (expiry === Number.POSITIVE_INFINITY) return null;
  const day = new Date(now);
  const midnight = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  return Math.min(expiry, midnight);
}

function scheduleExpiry() {
  window.clearTimeout(timer);
  timer = undefined;
  if (listeners.size === 0) return;
  const next = nextNotificationWake(snapshot.overrides, snapshot.now);
  if (next === null) return;
  timer = window.setTimeout(() => publish({}), Math.min(Math.max(next - Date.now(), 0), MAX_TIMER_MS));
}

function publish(patch: Partial<Pick<NotificationSnapshot, 'overrides' | 'scope'>>) {
  snapshot = { ...snapshot, ...patch, now: Date.now() };
  scheduleExpiry();
  for (const listener of [...listeners]) listener();
}

/** Re-read the override list and this device's scope. */
export async function refreshConversationNotifications(): Promise<void> {
  const api = window.mixdogDesktop;
  if (!api?.listConversationNotifications) return;
  const mine = ++refreshSeq;
  const [overrides, preferences] = await Promise.allSettled([
    api.listConversationNotifications(),
    api.getNotificationPreferences?.() ?? Promise.resolve(null),
  ]);
  if (mine !== refreshSeq) return;
  // A failed read keeps the cached value (never a default) and is reported:
  // the shown settings may be stale.
  for (const read of [overrides, preferences]) {
    if (read.status === 'rejected') {
      showDesktopToast(errorMessageText(read.reason), 'error', { scope: 'notifications:refresh' });
    }
  }
  publish({
    overrides: overrides.status === 'fulfilled' ? overrides.value : snapshot.overrides,
    scope:
      (preferences.status === 'fulfilled' &&
        preferences.value?.preferences[preferences.value.currentDeviceId]?.scope) ||
      snapshot.scope,
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    stopSetupSync = subscribeSetupChanges(() => void refreshConversationNotifications());
    void refreshConversationNotifications();
  }
  scheduleExpiry();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopSetupSync?.();
      stopSetupSync = null;
      window.clearTimeout(timer);
      timer = undefined;
    }
  };
}

export const notificationSnapshot = () => snapshot;

/** Whether the PC offers per-conversation controls (older hosts do not). */
export const conversationNotificationsAvailable = () =>
  typeof window !== 'undefined' && typeof window.mixdogDesktop?.setConversationNotification === 'function';

/** A session's overrides apply in this order: the session, its room, its bot. */
function chainOf(target: NotificationTarget): NotificationTarget[] {
  if (target.kind !== 'session') return [target];
  const chain: NotificationTarget[] = [target];
  // A seat (a room member's own thread) belongs to its room and its bot.
  const seat = roomMemberOfSession(target.id);
  const room = roomIdOfSession(target.id) || seat?.roomId;
  if (room) chain.push({ kind: 'room', id: room });
  const agent = agentIdOfHomeSession(target.id) || seat?.agentId;
  if (agent) chain.push({ kind: 'agent', id: agent });
  return chain;
}

/** The target's own override, not one inherited from above; null when unset or ended. */
export function ownNotificationOverride(
  snap: NotificationSnapshot,
  target: NotificationTarget,
  now: number = snap.now
): ConversationNotificationOverride | null {
  return snap.overrides.find((entry) => same(entry.target, target) && stillActive(entry, now)) ?? null;
}

export function resolveNotificationState(
  snap: NotificationSnapshot,
  target: NotificationTarget,
  now: number = snap.now
): ConversationNotificationState {
  const chain = chainOf(target);
  for (const link of chain) {
    const override = snap.overrides.find((entry) => same(entry.target, link) && stillActive(entry, now));
    if (!override) continue;
    return override.setting.mode === 'muted'
      ? { kind: 'muted', until: override.setting.until, source: override.target }
      : { kind: 'always', source: override.target };
  }
  // Scope 'off' leaves everything out; 'bots' keeps bots, rooms, home chats,
  // room logs and seats (a session with a room or bot above it).
  const conversation = target.kind !== 'session' || chain.length > 1;
  if (snap.scope === 'off' || (snap.scope === 'bots' && !conversation)) return { kind: 'outside' };
  return { kind: 'on' };
}

export function useNotificationSnapshot(): NotificationSnapshot {
  return useSyncExternalStore(subscribe, notificationSnapshot, notificationSnapshot);
}

export function useNotificationState(target: NotificationTarget | null): ConversationNotificationState | null {
  const snap = useNotificationSnapshot();
  return target ? resolveNotificationState(snap, target) : null;
}

export async function setConversationNotification(
  target: NotificationTarget,
  setting: ConversationNotificationSetting
): Promise<void> {
  const api = window.mixdogDesktop;
  if (!api?.setConversationNotification) return;
  try {
    const overrides = await api.setConversationNotification(target, setting);
    refreshSeq += 1;
    publish({ overrides: Array.isArray(overrides) ? overrides : snapshot.overrides });
  } catch (reason) {
    showDesktopToast(errorMessageText(reason), 'error', {
      scope: `notifications:${target.kind}:${target.id}`,
    });
  }
}
