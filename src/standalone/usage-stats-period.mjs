import { usageRollupDayKey } from '../runtime/shared/llm/usage-rollup.mjs';

const VIEWS = new Set(['hour', 'day', 'week', 'month', 'all']);

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

function periodStart(date, view) {
  const start = midnight(date);
  if (view !== 'hour') start.setDate(1);
  if (view === 'week') start.setMonth(Math.floor(start.getMonth() / 3) * 3);
  if (view === 'month') start.setMonth(0);
  return start;
}

function shiftMonths(date, count) {
  const shifted = new Date(date);
  shifted.setMonth(shifted.getMonth() + count);
  return shifted;
}

function calendarCount(from, to) {
  const cursor = midnight(from);
  const end = midnight(to);
  let count = 0;
  while (cursor <= end) {
    count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

/**
 * One owner for calendar selection and navigation.
 * hour = today, day = a month, week = a calendar quarter, month = a year.
 * Display bounds include future slots; accounting bounds never exceed now.
 */
export function resolveUsageStatsPeriod({ view = 'hour', anchor, now = Date.now() } = {}) {
  if (!VIEWS.has(view)) throw new TypeError('Unknown usage statistics view');
  if (!Number.isFinite(now) || now <= 0) throw new TypeError('Usage period requires a valid current time');
  const today = usageRollupDayKey(now);
  if (view === 'all') {
    return { view, anchor: null, fromMs: 0, toMs: now, startDay: null, endDay: today,
      days: null, previousAnchor: null, nextAnchor: null, isCurrent: true };
  }
  const current = periodStart(now, view);
  // Hourly history is deliberately not navigable.
  const requested = view === 'hour' ? current : periodStart(anchorDate(anchor, now), view);
  const start = requested > current ? current : requested;
  const step = view === 'day' ? 1 : view === 'week' ? 3 : 12;
  const next = view === 'hour' ? new Date(start) : shiftMonths(start, step);
  if (view === 'hour') next.setDate(next.getDate() + 1);
  const endMs = next.getTime() - 1;
  const toMs = Math.min(now, endMs);
  const previous = view === 'hour' ? null : shiftMonths(start, -step);
  return {
    view,
    anchor: usageRollupDayKey(start.getTime()),
    fromMs: start.getTime(),
    toMs,
    endMs,
    startDay: usageRollupDayKey(start.getTime()),
    endDay: usageRollupDayKey(endMs),
    days: view === 'hour' ? 0 : calendarCount(start, toMs),
    previousAnchor: previous && previous.getFullYear() >= 1970 ? usageRollupDayKey(previous.getTime()) : null,
    nextAnchor: view !== 'hour' && next <= current ? usageRollupDayKey(next.getTime()) : null,
    isCurrent: start.getTime() === current.getTime(),
  };
}
