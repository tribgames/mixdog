import { usageRollupDayKey } from '../runtime/shared/llm/usage-rollup.mjs';

const VIEWS = new Set(['hour', '7d', 'day', 'week', 'month', 'year', 'all', 'custom']);

function midnight(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function anchorDate(anchor, now) {
  if (anchor == null) return midnight(now);
  if (typeof anchor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
    throw new TypeError('Usage period anchor must be a calendar date');
  }
  const date = new Date(`${anchor}T00:00:00`);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() < 1970 || usageRollupDayKey(date.getTime()) !== anchor) {
    throw new TypeError('Usage period anchor must be a valid calendar date from 1970 onward');
  }
  return date;
}

/** `HH:MM` or `HH:MM:SS` on a 24-hour clock; blank means the whole day. */
function clockTime(value, label) {
  if (value == null || value === '') return null;
  const match = typeof value === 'string' ? /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value) : null;
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] ?? 0) > 59) {
    throw new TypeError(`Usage range ${label} must be a HH:MM clock time`);
  }
  return {
    hours: Number(match[1]),
    minutes: Number(match[2]),
    seconds: match[3] == null ? null : Number(match[3]),
    text: match[3] == null ? `${match[1]}:${match[2]}` : `${match[1]}:${match[2]}:${match[3]}`,
  };
}

/** A bound names an instant at the precision it was written: a start opens its
 *  named unit, an end spans that unit whole, so 09:00–18:00 keeps all of 18:00. */
function clockMs(day, time, edge) {
  const at = new Date(day);
  if (edge === 'start') at.setHours(time?.hours ?? 0, time?.minutes ?? 0, time?.seconds ?? 0, 0);
  else if (!time) at.setHours(23, 59, 59, 999);
  else at.setHours(time.hours, time.minutes, time.seconds ?? 59, 999);
  return at.getTime();
}

function shiftDays(date, count) {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + count);
  return shifted;
}

function calendarBounds(start, end, now, days) {
  const toMs = Math.min(now, shiftDays(end, 1).getTime() - 1);
  return {
    fromMs: start.getTime(),
    toMs,
    endMs: toMs,
    startDay: usageRollupDayKey(start.getTime()),
    endDay: usageRollupDayKey(end.getTime()),
    days,
  };
}

/**
 * One owner for trailing ranges and navigation.
 * hour = 24 elapsed hours; 7d/day/week/month = 7/30/90/365 local calendar dates.
 * Calendar ranges include today. An anchor is the final included date.
 * year groups retained history by year; all remains a legacy API alias.
 * Display and accounting bounds both stop at the end of the selected range.
 */
export function resolveUsageStatsPeriod({
  view = 'hour',
  anchor,
  startDay,
  endDay,
  startTime,
  endTime,
  now = Date.now(),
} = {}) {
  if (!VIEWS.has(view)) throw new TypeError('Unknown usage statistics view');
  if (!Number.isFinite(now) || now <= 0) throw new TypeError('Usage period requires a valid current time');
  const today = usageRollupDayKey(now);
  if (view === 'year' || view === 'all') {
    return {
      view,
      anchor: null,
      fromMs: 0,
      toMs: now,
      startDay: null,
      endDay: today,
      days: null,
      previousAnchor: null,
      nextAnchor: null,
      isCurrent: true,
    };
  }
  if (view === 'hour') {
    const fromMs = now - 24 * 60 * 60 * 1000;
    return {
      view,
      anchor: null,
      fromMs,
      toMs: now,
      endMs: now,
      startDay: usageRollupDayKey(fromMs),
      endDay: today,
      days: 1,
      previousAnchor: null,
      nextAnchor: null,
      isCurrent: true,
    };
  }
  if (view === 'custom') return customUsagePeriod({ view, startDay, endDay, startTime, endTime, now, today });
  return calendarUsagePeriod(view, anchor, now);
}

// A custom range: the whole days from startDay to endDay, narrowed by clock
// times when given, never reaching into the future.
function customUsagePeriod({ view, startDay, endDay, startTime, endTime, now, today }) {
  if (startDay == null || endDay == null) throw new TypeError('Usage range requires a start and end date');
  const start = anchorDate(startDay, now);
  const end = anchorDate(endDay, now);
  const from = clockTime(startTime, 'start time');
  const to = clockTime(endTime, 'end time');
  if (start > end) throw new RangeError('Usage range start must not follow its end');
  if (end > midnight(now)) throw new RangeError('Usage range cannot include future dates');
  const days =
    (Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) -
      Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
      86400000 +
    1;
  // Clock times narrow the selected dates; without them the range stays the
  // whole days it names, exactly as before.
  const fromMs = clockMs(start, from, 'start');
  const toMs = Math.min(now, clockMs(end, to, 'end'));
  if (fromMs > now) throw new RangeError('Usage range cannot include future dates');
  if (fromMs > toMs) throw new RangeError('Usage range start must not follow its end');
  return {
    view,
    anchor: null,
    fromMs,
    toMs,
    endMs: toMs,
    startDay: usageRollupDayKey(fromMs),
    endDay: usageRollupDayKey(end.getTime()),
    startTime: from?.text ?? null,
    endTime: to?.text ?? null,
    days,
    previousAnchor: null,
    nextAnchor: null,
    isCurrent: endDay === today,
  };
}

// A calendar window ending on the anchor day (today at the latest): 7, 30,
// 90 or 365 days by view, with the neighbouring windows for paging.
function calendarUsagePeriod(view, anchor, now) {
  const current = midnight(now);
  const requested = anchorDate(anchor, now);
  const end = requested > current ? current : requested;
  let days = 365;
  if (view === '7d') days = 7;
  else if (view === 'day') days = 30;
  else if (view === 'week') days = 90;
  const start = shiftDays(end, 1 - days);
  const previous = shiftDays(start, -1);
  const next = shiftDays(end, days);
  return {
    view,
    anchor: usageRollupDayKey(end.getTime()),
    ...calendarBounds(start, end, now, days),
    previousAnchor: previous.getFullYear() >= 1970 ? usageRollupDayKey(previous.getTime()) : null,
    nextAnchor: end < current ? usageRollupDayKey(Math.min(next.getTime(), current.getTime())) : null,
    isCurrent: end.getTime() === current.getTime(),
  };
}
