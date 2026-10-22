// The composer line's muted routine readout in a bot's room (agent mode),
// where the coding sessions' usage readout would say nothing. It says ONE
// thing about THIS bot's routines, by priority: a failure, else the next
// active schedule in natural time wording, else the webhook it waits on, else
// that everything rests, else that nothing is scheduled. It fits the line
// through the usage readout's own machinery (readoutVariants/FittedReadout):
// worded, then without the routine's name, then icon + short time, and for a
// failure finally the red dot alone; never ellipsized.
import { CalendarClock, Clock, Pause, Webhook } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  agentHomeSessionId,
  agentIdOfHomeSession,
} from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { useComposerRoomMembers } from './composer-room-ask';
import { OPEN_AGENT_PANEL_EVENT, setAgentPanelTab } from './agent-panel-tab';
import { FittedReadout, type ReadoutItem, readoutVariants } from './composer-usage-readout';
import type { RecordValue } from './desktop-types';
import { t, uiFormatLocale } from './i18n';
import { timeFormatOptions } from './time-format-preference';
import { record, rows } from './record-utils';
import { requestNewSchedule } from './routine-editor-request';
import { relativeTime } from './routine-list-item';
import { routineRows, webhookRoutineRows } from './routines-model';
import { useSidebarReferences } from './sidebar-reference-cache';

const ROUTINE_KEYS = ['channelSetup'] as const;
/** The natural time wording is minutes-coarse: a minute is a sensible refresh. */
const REFRESH_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The one thing the readout says. */
export type RoutineFocus =
  | { kind: 'failed'; name: string }
  | { kind: 'next'; name: string; at: number }
  | { kind: 'webhook'; name: string }
  | { kind: 'paused' }
  | { kind: 'none' };

/** What `agentId` owns in channel-admin's setup, reduced to the one focus. */
export function routineFocus(setup: RecordValue, agentId: string): RoutineFocus {
  const schedules = routineRows(rows(setup.schedules), agentId);
  const webhooks = webhookRoutineRows(rows(setup.webhooks), agentId);
  const failed = [...schedules, ...webhooks].find((row) => row.pausedAfter !== null || (row.last && !row.last.ok));
  if (failed) return { kind: 'failed', name: failed.name };
  let next: Extract<RoutineFocus, { kind: 'next' }> | null = null;
  for (const row of schedules) {
    if (row.nextAt !== null && (!next || row.nextAt < next.at)) {
      next = { kind: 'next', name: row.name, at: row.nextAt };
    }
  }
  if (next) return next;
  const waiting = webhooks.find((row) => row.enabled);
  if (waiting) return { kind: 'webhook', name: waiting.name };
  return schedules.length || webhooks.length ? { kind: 'paused' } : { kind: 'none' };
}

const FOCUS_RANK: Record<RoutineFocus['kind'], number> = { failed: 0, next: 1, webhook: 2, paused: 3, none: 4 };

/** A group room's one thing: its members' foci by the same priority (the
 *  earliest next run among them), the routine named with its bot. A room has
 *  no routines of its own; they run in each bot's room. `agentId` is the
 *  owner, for opening its 루틴 tab. */
export function roomRoutineFocus(
  setup: RecordValue,
  members: readonly { id: string; name: string }[]
): RoutineFocus & { agentId?: string } {
  let best: RoutineFocus & { agentId?: string } = { kind: 'none' };
  for (const member of members) {
    const own = routineFocus(setup, member.id);
    const focus = 'name' in own ? { ...own, name: `${member.name} · ${own.name}` } : own;
    const earlier = focus.kind === 'next' && best.kind === 'next' && focus.at < best.at;
    if (FOCUS_RANK[focus.kind] < FOCUS_RANK[best.kind] || earlier) best = { ...focus, agentId: member.id };
  }
  return best;
}

const startOfDay = (at: number) => new Date(at).setHours(0, 0, 0, 0);

/** "40 minutes from now" within the hour; then "today 6 PM", "tomorrow 8:30 AM",
 *  the weekday within the week, a date beyond. */
export function nextRunPhrase(at: number, now = Date.now()): string {
  const locale = uiFormatLocale();
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (at - now < HOUR_MS) return relative.format(Math.max(0, Math.ceil((at - now) / 60_000)), 'minute');
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  const date = new Date(at);
  if (days >= 7) return date.toLocaleDateString(locale, { month: 'long', day: 'numeric' });
  if (days >= 2) return date.toLocaleDateString(locale, { weekday: 'long' });
  const time = date.toLocaleTimeString(locale, {
    hour: 'numeric',
    minute: date.getMinutes() ? '2-digit' : undefined,
    ...timeFormatOptions(),
  });
  return `${relative.format(days, 'day')} ${time}`;
}

const worded = (text: string, icon: ReadoutItem['icon'] = null, label = text): ReadoutItem => ({
  icon,
  text,
  label,
  word: text,
});

/** The variants, fullest first: worded, without the name, then the icon form
 *  (a failure ends at its red dot alone). */
export function routineReadoutVariants(focus: RoutineFocus, now = Date.now()): ReadoutItem[][] {
  let full: ReadoutItem;
  let short: ReadoutItem | null = null;
  let icon: ReadoutItem;
  switch (focus.kind) {
    case 'failed': {
      const label = t('{{name}} failed', { name: focus.name });
      full = worded(label, 'dot');
      short = worded(t('Failed'), 'dot', label);
      icon = { icon: 'dot', text: '', label, word: '' };
      break;
    }
    case 'next': {
      const phrase = nextRunPhrase(focus.at, now);
      full = worded(`${phrase} ${focus.name}`);
      short = worded(phrase, null, full.label);
      icon = { icon: Clock, text: relativeTime(focus.at), label: full.label, word: '' };
      break;
    }
    case 'webhook':
      full = worded(t('Waiting for {{name}}', { name: focus.name }));
      icon = { icon: Webhook, text: '', label: full.label, word: '' };
      break;
    case 'paused':
      full = worded(t('All routines paused'));
      icon = { icon: Pause, text: '', label: full.label, word: '' };
      break;
    default:
      full = worded(t('Nothing scheduled'));
      icon = { icon: CalendarClock, text: '', label: full.label, word: '' };
  }
  // readoutVariants' first entry is the worded form of the icon item: skipped.
  return [[full], ...(short ? [[short]] : []), ...readoutVariants({ item: icon }, ['item'], ['item']).slice(1)];
}

/** Show `sessionId`'s 루틴 tab, where each routine's runs are listed. */
function openRoutinesTab(sessionId: string) {
  setAgentPanelTab('routines');
  window.dispatchEvent(new CustomEvent(OPEN_AGENT_PANEL_EVENT, { detail: { sessionId } }));
}

/** A re-render each minute while the window is visible, for the relative time. */
function useMinuteTick(enabled: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let timer = 0;
    const stop = () => window.clearInterval(timer);
    const start = () => {
      stop();
      if (document.visibilityState === 'visible') timer = window.setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') setTick((n) => n + 1);
      start();
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);
}

export function ComposerRoutineReadout({ sessionId, hidden }: { sessionId: string; hidden: boolean }) {
  const homeAgentId = agentIdOfHomeSession(sessionId);
  // A group room reads its members' routines (null in a bot's own room).
  const roomMembers = useComposerRoomMembers(homeAgentId ? '' : sessionId);
  const { values, loading } = useSidebarReferences(window.mixdogDesktop, ROUTINE_KEYS, !hidden);
  const setup = record(values.channelSetup);
  const focus = roomMembers ? roomRoutineFocus(setup, roomMembers) : routineFocus(setup, homeAgentId);
  const agentId: string = (focus as { agentId?: string }).agentId || homeAgentId || roomMembers?.[0]?.id || '';
  useMinuteTick(!hidden && focus.kind === 'next');
  if (!homeAgentId && !roomMembers) return null;
  if (focus.kind === 'none') {
    if (loading) return null;
    return (
      <FittedReadout
        variants={routineReadoutVariants(focus)}
        title={t('Create a routine')}
        onClick={() => requestNewSchedule(agentId)}
      />
    );
  }
  return (
    <FittedReadout
      variants={routineReadoutVariants(focus)}
      title={t('Open routines')}
      onClick={() => openRoutinesTab(agentHomeSessionId(agentId))}
    />
  );
}
