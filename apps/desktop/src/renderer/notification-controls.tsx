// The per-conversation notification controls (issue #221): the list-menu
// item, and the muted mark of a list row. Menus are the only way to change them.
import { BellOff } from 'lucide-react';
import type { NotificationTarget } from '../shared/contract-notifications';
import { t, uiFormatLocale } from './i18n';
import {
  type ConversationNotificationState,
  conversationNotificationsAvailable,
  notificationSnapshot,
  ownNotificationOverride,
  refreshConversationNotifications,
  resolveNotificationState,
  setConversationNotification,
  useNotificationState,
} from './notification-overrides';
import { agentContacts } from './agent-contacts-model';
import { agentRoomName } from './agent-room-store';
import { readSidebarReference } from './sidebar-reference-cache';
import type { ScmContextMenuItem } from './ScmContextMenu';
import { timeFormatOptions } from './time-format-preference';
import './notification-controls.css';

const HOUR_MS = 3_600_000;

/** 08:00 local on the next day. */
export function tomorrowMorning(now: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return date.getTime();
}

/** "until 9:00 PM", "until tomorrow 8:00 AM", a later day with its date; '' for no end. */
export function notificationUntilLabel(until: number | null, now: number = Date.now()): string {
  if (until === null) return '';
  const date = new Date(until);
  const locale = uiFormatLocale();
  const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', ...timeFormatOptions() });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return t('until {{time}}', { time });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return t('until tomorrow {{time}}', { time });
  const day = date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return t('until {{time}}', { time: `${day} ${time}` });
}

function mutedTooltip(state: Extract<ConversationNotificationState, { kind: 'muted' }>): string {
  const until = notificationUntilLabel(state.until);
  return until ? t('Notifications off {{until}}', { until }) : t('Notifications off');
}

/** A bot's or room's display name, read now; the id when none is known yet. */
function targetName(target: NotificationTarget): string {
  if (target.kind === 'room') return agentRoomName(target.id) || target.id;
  const agents = readSidebarReference('agents');
  return (
    agentContacts(agents, [], new Map(), undefined, { includeDisabled: true }).find(
      (contact) => contact.agentId === target.id
    )?.name || target.id
  );
}

/** THE notification actions of every menu (list rows, bot and room rows), worded by the state. Each item writes `target` — the displayed
 *  conversation's own — unless its label names the parent ("Unmute {{name}}").
 *  None when the host has no per-conversation controls. */
export function notificationMenuItems(
  target: NotificationTarget,
  { separated = false, now = Date.now() }: { separated?: boolean; now?: number } = {}
): ScmContextMenuItem[] {
  if (!conversationNotificationsAvailable()) return [];
  void refreshConversationNotifications();
  const snap = notificationSnapshot();
  const state = resolveNotificationState(snap, target, now);
  const own = ownNotificationOverride(snap, target, now);
  const write = (to: NotificationTarget, setting: Parameters<typeof setConversationNotification>[1]) => () =>
    void setConversationNotification(to, setting);
  const set = (setting: Parameters<typeof setConversationNotification>[1]) => write(target, setting);
  const mute = (id: string, label: string, until: number | null): ScmContextMenuItem => ({
    id,
    label,
    onSelect: set({ mode: 'muted', until }),
  });
  const common = { separatorBefore: separated || undefined };
  if (own?.setting.mode === 'muted') {
    return [{ id: 'notify-unmute', label: t('Unmute notifications'), ...common, onSelect: set({ mode: 'inherit' }) }];
  }
  if (own?.setting.mode === 'always') {
    return [
      {
        id: 'notify-use-settings',
        label: t('Use notification settings'),
        ...common,
        onSelect: set({ mode: 'inherit' }),
      },
    ];
  }
  if (state.kind === 'muted') {
    // Muted by a room or bot above: this conversation can opt back in alone, or
    // the named parent is unmuted for everything under it.
    return [
      { id: 'notify-get-here', label: t('Get notifications here'), ...common, onSelect: set({ mode: 'always' }) },
      {
        id: 'notify-unmute-parent',
        label: t('Unmute {{name}}', { name: targetName(state.source) }),
        onSelect: write(state.source, { mode: 'inherit' }),
      },
    ];
  }
  if (state.kind === 'outside') {
    return [{ id: 'notify-get', label: t('Get notifications'), ...common, onSelect: set({ mode: 'always' }) }];
  }
  return [
    {
      id: 'notify-mute',
      label: t('Mute notifications'),
      ...common,
      children: [
        mute('notify-mute-1h', t('For 1 hour'), now + HOUR_MS),
        mute('notify-mute-8h', t('For 8 hours'), now + 8 * HOUR_MS),
        mute('notify-mute-tomorrow', t('Until tomorrow morning'), tomorrowMorning(now)),
        mute('notify-mute-forever', t('Until I turn it back on'), null),
      ],
    },
  ];
}

/** A list row's muted mark: a bell-off with the remaining time in its tooltip. */
export function NotificationMuteMark({ target }: { target: NotificationTarget }) {
  const state = useNotificationState(target);
  if (state?.kind !== 'muted') return null;
  const tooltip = mutedTooltip(state);
  return (
    <span className="session-row-muted" role="img" aria-label={tooltip} data-tooltip={tooltip}>
      <BellOff size={12} aria-hidden="true" />
    </span>
  );
}
