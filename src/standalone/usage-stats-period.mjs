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

function shiftDays(date, count) {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + count);
  return shifted;
}

function calendarBounds(start, end, now, days) {
  const toMs = Math.min(now, shiftDays(end, 1).getTime() - 1);
  return { fromMs: start.getTime(), toMs, endMs: toMs,
    startDay: usageRollupDayKey(start.getTime()), endDay: usageRollupDayKey(end.getTime()), days };
}

/**
 * One owner for trailing ranges and navigation.
 * hour = 24 elapsed hours; 7d/day/week/month = 7/30/90/365 local calendar dates.
 * Calendar ranges include today. An anchor is the final included date.
 * year groups retained history by year; all remains a legacy API alias.
 * Display and accounting bounds both stop at the end of the selected range.
 */
export function resolveUsageStatsPeriod({ view = 'hour', anchor, startDay, endDay, now = Date.now() } = {}) {
  if (!VIEWS.has(view)) throw new TypeError('Unknown usage statistics view');
  if (!Number.isFinite(now) || now <= 0) throw new TypeError('Usage period requires a valid current time');
  const today = usageRollupDayKey(now);
  if (view === 'year' || view === 'all') {
    return { view, anchor: null, fromMs: 0, toMs: now, startDay: null, endDay: today,
      days: null, previousAnchor: null, nextAnchor: null, isCurrent: true };
  }
  if (view === 'hour') {
    const fromMs = now - 24 * 60 * 60 * 1000;
    return { view, anchor: null, fromMs, toMs: now, endMs: now,
      startDay: usageRollupDayKey(fromMs), endDay: today,
      days: 1, previousAnchor: null, nextAnchor: null, isCurrent: true };
  }
  if (view === 'custom') {
    if (startDay == null || endDay == null) throw new TypeError('Usage range requires a start and end date');
    const start = anchorDate(startDay, now);
    const end = anchorDate(endDay, now);
    if (start > end) throw new RangeError('Usage range start must not follow its end');
    if (end > midnight(now)) throw new RangeError('Usage range cannot include future dates');
    const days = (Date.UTC(end.getFullYear(), end.getMonth(), end.getDate())
      - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000 + 1;
    return { view, anchor: null, ...calendarBounds(start, end, now, days),
      previousAnchor: null, nextAnchor: null, isCurrent: endDay === today };
  }
  const current = midnight(now);
  const requested = anchorDate(anchor, now);
  const end = requested > current ? current : requested;
  const days = view === '7d' ? 7 : view === 'day' ? 30 : view === 'week' ? 90 : 365;
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
