// A usage-statistics answer built by hand for the surface tests, at a fixed clock (noon, 2026-09-13, UTC+09:00): the figures are the
// test's own, and the period is computed from the view, anchor and dates the test passes (calendar days in UTC+09:00).
export const USAGE_STATS_NOW = Date.parse('2026-09-13T12:00:00+09:00');
const DAY_MS = 86_400_000;
const START_OF_DAY = (day) => Date.parse(`${day}T00:00:00+09:00`);
const TODAY = '2026-09-13';

const WINDOW_DAYS = { '7d': 7, day: 30, week: 90, month: 365 };
const shiftDay = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const dayOf = (day) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || shiftDay(day, 0) !== day) throw new Error(`usageSnapshot needs a YYYY-MM-DD day, got ${day}`);
  return day;
};
// The product also takes HH:MM:SS; the tests never do, so it is refused rather than guessed.
const clockOf = (time) => {
  if (time == null) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`usageSnapshot needs an HH:MM clock time, got ${time}`);
  return time;
};

function periodOf({ view, anchor, startDay, endDay, startTime, endTime }) {
  const now = USAGE_STATS_NOW;
  if (WINDOW_DAYS[view]) {
    const days = WINDOW_DAYS[view];
    const requested = anchor == null ? TODAY : dayOf(anchor);
    const end = requested > TODAY ? TODAY : requested;
    const start = shiftDay(end, 1 - days);
    const previous = shiftDay(start, -1);
    const next = shiftDay(end, days);
    const endMs = Math.min(now, START_OF_DAY(end) + DAY_MS - 1);
    return {
      view,
      anchor: end,
      fromMs: START_OF_DAY(start),
      toMs: endMs,
      endMs,
      startDay: start,
      endDay: end,
      days,
      previousAnchor: previous >= '1970-01-01' ? previous : null,
      nextAnchor: end < TODAY ? (next > TODAY ? TODAY : next) : null,
      isCurrent: end === TODAY,
    };
  }
  if (view === 'hour')
    return { view, anchor: null, fromMs: now - DAY_MS, toMs: now, endMs: now, startDay: '2026-09-12', endDay: TODAY, days: 1, previousAnchor: null, nextAnchor: null, isCurrent: true };
  if (view === 'year' || view === 'all')
    return { view, anchor: null, fromMs: 0, toMs: now, startDay: null, endDay: TODAY, days: null, previousAnchor: null, nextAnchor: null, isCurrent: true };
  if (view === 'custom') {
    const start = dayOf(startDay);
    const end = dayOf(endDay);
    const from = clockOf(startTime);
    const to = clockOf(endTime);
    if (start > end) throw new Error('Usage range start must not follow its end');
    if (end > TODAY) throw new Error('Usage range cannot include future dates');
    const fromMs = Date.parse(`${start}T${from ?? '00:00'}:00.000+09:00`);
    // An end names its unit whole: no time keeps the day, HH:MM keeps all of that minute.
    const toMs = Math.min(now, Date.parse(`${end}T${to ?? '23:59'}:59.999+09:00`));
    if (fromMs > now) throw new Error('Usage range cannot include future dates');
    if (fromMs > toMs) throw new Error('Usage range start must not follow its end');
    return {
      view,
      anchor: null,
      fromMs,
      toMs,
      endMs: toMs,
      startDay: start,
      endDay: end,
      startTime: from,
      endTime: to,
      days: Math.round((START_OF_DAY(end) - START_OF_DAY(start)) / DAY_MS) + 1,
      previousAnchor: null,
      nextAnchor: null,
      isCurrent: end === TODAY,
    };
  }
  throw new Error(`usageSnapshot has no period for view ${view}`);
}

export function usageSnapshot(view = 'hour', tokens = 1200, dates = {}) {
  const period = periodOf({ view, ...dates });
  const route = {
    turns: 1,
    sessions: 1,
    input: tokens - 200,
    output: 200,
    tokens,
    cacheRead: 500,
    cacheWrite: 800,
    cacheTokens: 1300,
    costUsd: 2,
    costCoverage: 1,
    share: 1,
    models: [],
  };
  return {
    generatedAt: USAGE_STATS_NOW,
    period,
    range: { days: period.days, firstDay: period.startDay || '2025-01-01' },
    totals: { ...route },
    providers: [{ ...route, provider: 'openai', providerKind: 'api' }],
    daily: [{ day: period.startDay || '2026-09-01', tokens, turns: 1, costUsd: 2, costKnownTurns: 1, providers: [] }],
    hourly: Array.from({ length: 24 }, (_, hour) => ({
      key: String(hour).padStart(2, '0'),
      label: `${String(hour).padStart(2, '0')}:00`,
      tokens: hour === 9 ? tokens : 0,
      turns: hour === 9 ? 1 : 0,
      costUsd: hour === 9 ? 2 : 0,
      costKnownTurns: hour === 9 ? 1 : 0,
      providers: [],
      future: hour > 12,
    })),
    coverage: {},
  };
}