// The side-view Schedules and Webhooks lists (SchedulesView/WebhooksView):
// one single-select chip under the search field picks how the list is sorted
// and grouped, remembered per view. Schedules: 다음 실행 (flat, soonest run
// first, paused last), 주기 (grouped by cadence), 봇별 (grouped by bot).
// Webhooks: 최근 이벤트 (flat, latest event first) and 봇별.
import { useCallback, useState } from 'react';
import type { RecordValue } from './desktop-types';

export type FrequencyKind = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'once';

/** The cron shapes the schedule editor's frequency control produces; anything
 *  else is `matched: false` (the editor falls back to Daily). */
export function frequencyFromCron(cron: string): {
  kind: FrequencyKind;
  minute: string;
  clock: string;
  weekday: string;
  matched: boolean;
} {
  const fallback = { kind: 'daily' as FrequencyKind, minute: '0', clock: '09:00', weekday: '1', matched: false };
  const parts = String(cron || '')
    .trim()
    .split(/\s+/);
  if (parts.length !== 5) return fallback;
  const [minute, hour, dom, month, dow] = parts;
  const numeric = (value: string) => /^\d{1,2}$/.test(value);
  if (numeric(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return { ...fallback, kind: 'hourly', minute, matched: true };
  }
  if (numeric(minute) && numeric(hour) && dom === '*' && month === '*') {
    const clock = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    if (dow === '*') return { ...fallback, kind: 'daily', clock, matched: true };
    if (dow === '1-5') return { ...fallback, kind: 'weekdays', clock, matched: true };
    if (/^[0-6]$/.test(dow)) return { ...fallback, kind: 'weekly', clock, weekday: dow, matched: true };
  }
  return fallback;
}

export type ScheduleSort = 'next' | 'cadence' | 'bot';
export type WebhookSort = 'recent' | 'bot';
export const SCHEDULE_SORTS: readonly ScheduleSort[] = ['next', 'cadence', 'bot'];
export const WEBHOOK_SORTS: readonly WebhookSort[] = ['recent', 'bot'];

/** A cadence group: the editor's frequencies, then any other cron. */
export type Cadence = FrequencyKind | 'custom';
export const CADENCE_ORDER: readonly Cadence[] = ['hourly', 'daily', 'weekdays', 'weekly', 'once', 'custom'];

/** One group of the list; a flat list is one group with an empty key. */
export interface RoutineGroup {
  key: string;
  /** The cadence of a 주기 group. */
  cadence?: Cadence;
  /** The bot of a 봇별 group. */
  bot?: string;
  rows: RecordValue[];
}

const OWNER_DEFAULT = 'lead';
const stamp = (value: unknown): number | null => {
  const at = typeof value === 'string' && value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : null;
};

/** The bot a row belongs to; ownerless rows are Mixy's. */
export const routineOwnerOf = (row: RecordValue): string =>
  typeof row.owner === 'string' && row.owner ? row.owner : OWNER_DEFAULT;

/** Paused: switched off, or its bot is missing (channel-admin `ownerProblem`). */
export const routinePaused = (row: RecordValue): boolean => row.enabled === false || Boolean(row.ownerProblem);

export function scheduleCadence(row: RecordValue): Cadence {
  if (row.whenAt && !row.whenCron) return 'once';
  const parsed = frequencyFromCron(String(row.whenCron || ''));
  return parsed.matched ? parsed.kind : 'custom';
}

const byName = (a: RecordValue, b: RecordValue) => String(a.name).localeCompare(String(b.name));

/** Soonest next run first, runs without one after, paused rows last. */
export function sortByNextRun(list: readonly RecordValue[]): RecordValue[] {
  const next = (row: RecordValue) => (routinePaused(row) ? null : stamp(row.nextFireAt));
  return [...list].sort((a, b) => {
    const pa = routinePaused(a);
    if (pa !== routinePaused(b)) return pa ? 1 : -1;
    const na = next(a);
    const nb = next(b);
    if (na !== nb) {
      if (na === null) return 1;
      if (nb === null) return -1;
      return na - nb;
    }
    return byName(a, b);
  });
}

/** Latest event first; endpoints without one after, by name. */
export function sortByLatestEvent(list: readonly RecordValue[]): RecordValue[] {
  return [...list].sort((a, b) => {
    const ea = stamp(a.lastEventAt);
    const eb = stamp(b.lastEventAt);
    if (ea !== eb) return ea === null ? 1 : eb === null ? -1 : eb - ea;
    return byName(a, b);
  });
}

/** Groups per bot, in `botOrder` (bots it does not name after, by id). */
function groupByBot(
  list: readonly RecordValue[],
  botOrder: readonly string[],
  sort: (rows: readonly RecordValue[]) => RecordValue[]
): RoutineGroup[] {
  const groups = new Map<string, RecordValue[]>();
  for (const row of list) {
    const bot = routineOwnerOf(row);
    groups.set(bot, [...(groups.get(bot) || []), row]);
  }
  const rank = (bot: string) => {
    const index = botOrder.indexOf(bot);
    return index < 0 ? botOrder.length : index;
  };
  return [...groups.keys()]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((bot) => ({ key: `bot:${bot}`, bot, rows: sort(groups.get(bot) || []) }));
}

/** The schedule list under `sort`; `botOrder` orders the 봇별 groups. */
export function scheduleGroups(
  list: readonly RecordValue[],
  sort: ScheduleSort,
  botOrder: readonly string[] = []
): RoutineGroup[] {
  if (sort === 'bot') return groupByBot(list, botOrder, sortByNextRun);
  if (sort === 'cadence') {
    return CADENCE_ORDER.map((cadence) => ({
      key: `cadence:${cadence}`,
      cadence,
      rows: sortByNextRun(list.filter((row) => scheduleCadence(row) === cadence)),
    })).filter((group) => group.rows.length > 0);
  }
  return list.length ? [{ key: '', rows: sortByNextRun(list) }] : [];
}

/** The webhook list under `sort`. */
export function webhookGroups(
  list: readonly RecordValue[],
  sort: WebhookSort,
  botOrder: readonly string[] = []
): RoutineGroup[] {
  if (sort === 'bot') return groupByBot(list, botOrder, sortByLatestEvent);
  return list.length ? [{ key: '', rows: sortByLatestEvent(list) }] : [];
}

/** The stored choice of `key` when it is one of `options`, else `fallback`. */
export function readSortChoice<T extends string>(key: string, options: readonly T[], fallback: T): T {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return options.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

/** One view's chip choice, remembered on this device. */
export function useSortChoice<T extends string>(key: string, options: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => readSortChoice(key, options, fallback));
  const choose = useCallback(
    (next: T) => {
      setValue(next);
      try {
        globalThis.localStorage?.setItem(key, next);
      } catch {
        // Remembering is a convenience; the choice still applies now.
      }
    },
    [key]
  );
  return [value, choose] as const;
}
