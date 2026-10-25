// The per-conversation notification controls (issue #221): the list-menu
// item, the muted mark of a list row, and the conversation header's bell.
import { Bell, BellOff } from 'lucide-react';
import { useRef, useState } from 'react';
import type { NotificationTarget } from '../shared/contract-notifications';
import { t, uiFormatLocale } from './i18n';
import {
  type ConversationNotificationState,
  conversationNotificationsAvailable,
  conversationTarget,
  type NotificationSnapshot,
  notificationSnapshot,
  ownNotificationOverride,
  refreshConversationNotifications,
  resolveNotificationState,
  setConversationNotification,
  useNotificationSnapshot,
  useNotificationState,
} from './notification-overrides';
import { agentContacts } from './agent-contacts-model';
import { agentRoomName } from './agent-room-store';
import { readSidebarReference } from './sidebar-reference-cache';
import { ScmContextMenu, type ScmContextMenuItem, type ScmContextMenuState } from './ScmContextMenu';
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

/** The target a conversation header writes: its own (the bot, the room, the
 *  coding session), or the session itself once it has an override of its own. */
export function headerNotificationTarget(
  snap: NotificationSnapshot,
  sessionId: string,
  now: number = snap.now
): NotificationTarget {
  const own = conversationTarget(sessionId);
  const session: NotificationTarget = { kind: 'session', id: sessionId };
  return own.kind !== 'session' && ownNotificationOverride(snap, session, now) ? session : own;
}

/** THE notification actions of every menu (list rows, bot and room rows, the
 *  header bell), worded by the state. Each item writes `target` — the displayed
 *  conversation's own — unless its label names the parent ("Unmute {{name}}").
 *  `stateOf` is where the state is read from when it differs from `target`.
 *  None when the host has no per-conversation controls. */
export function notificationMenuItems(
  target: NotificationTarget,
  {
    separated = false,
    now = Date.now(),
    stateOf = target,
  }: { separated?: boolean; now?: number; stateOf?: NotificationTarget } = {}
): ScmContextMenuItem[] {
  if (!conversationNotificationsAvailable()) return [];
  void refreshConversationNotifications();
  const snap = notificationSnapshot();
  const state = resolveNotificationState(snap, stateOf, now);
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

/** The conversation header's bell: faint while notifications are on, a bell-off
 *  with the remaining time while muted; a click opens the list menu's items. */
export function ConversationBell({ sessionId }: { sessionId: string }) {
  // The state shows the whole chain (session → room → bot); the items write
  // the conversation's own target (headerNotificationTarget).
  const sessionTarget: NotificationTarget = { kind: 'session', id: sessionId };
  const snap = useNotificationSnapshot();
  const state = sessionId ? resolveNotificationState(snap, sessionTarget) : null;
  const target = headerNotificationTarget(snap, sessionId);
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  if (!sessionId || !state || !conversationNotificationsAvailable()) return null;
  const label = t('Notifications for this conversation');
  const muted = state.kind === 'muted';
  const until = muted ? notificationUntilLabel(state.until) : '';
  let tooltip = label;
  if (muted) tooltip = mutedTooltip(state);
  else if (state.kind === 'outside') tooltip = t('Not notified by notification settings');
  return (
    <>
      <button
        ref={button}
        type="button"
        className="pane-dock-toggle conversation-bell"
        data-state={state.kind}
        aria-label={label}
        data-tooltip={tooltip}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => {
          const rect = button.current?.getBoundingClientRect();
          setMenu({
            label,
            heading: label,
            x: rect?.right ?? 0,
            y: rect?.bottom ?? 0,
            alignEnd: true,
            flipY: rect?.top,
            items: notificationMenuItems(target, { stateOf: sessionTarget }),
          });
        }}
      >
        {muted || state.kind === 'outside' ? (
          <BellOff size={15} aria-hidden="true" />
        ) : (
          <Bell size={15} aria-hidden="true" />
        )}
        {until && <span className="conversation-bell-time">{until}</span>}
      </button>
      <ScmContextMenu state={menu} onClose={() => setMenu(null)} anchorRef={button} />
    </>
  );
}
