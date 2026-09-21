// Usage statistics model: number/money formatting, plan labels, day/clock
// keys, trend grouping, period labels and the shared value cell.
import type { DesktopCapability } from '../shared/contract';
import { dayKey, pad2, type DayRange } from './DateRangePicker';
import { t, uiFormatLocale } from './i18n';
import { rows } from './record-utils';
import { usageCompact, usageMoney, usageNumber } from './usage-format';

export type Row = Record<string, unknown>;
export type StatsRequest = (capability: DesktopCapability, args?: unknown[]) => Promise<unknown>;
export type SortKey = 'tokens' | 'costUsd' | 'turns';

export type Grain = 'hour' | 'day' | 'week' | 'month' | 'year';
export type StatsView = Grain | '7d' | 'custom';
export type Metric = 'tokens' | 'costUsd' | 'turns';
export type TrendGrouping = { grain: Grain; step: number; firstYear: number; lastYear: number };
const MAX_TREND_BARS = 30;

export function statsNumber(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

export function statsTokens(value: unknown, incomplete = false): string {
  if (incomplete && !(statsNumber(value) > 0)) return '—';
  return usageCompact(value) || '—';
}

export function statsCount(value: unknown): string {
  const count = usageNumber(value);
  return count === null ? '—' : count.toLocaleString(uiFormatLocale());
}

export function statsPercent(value: unknown): string {
  if (usageNumber(value) === null) return '—';
  return `${(statsNumber(value) * 100).toFixed(1)}%`;
}

export function unpricedTurns(row: Row): number {
  const turns = statsNumber(row.turns);
  const missing = usageNumber(row.costUnpricedTurns);
  if (missing !== null) return Math.max(0, missing);
  const known = usageNumber(row.costKnownTurns);
  if (known !== null) return Math.max(0, turns - known);
  return turns * (1 - Math.min(1, Math.max(0, statsNumber(row.costCoverage))));
}

export function statsMoney(row: Row): string {
  const missing = unpricedTurns(row);
  if (missing > 0 && missing >= statsNumber(row.turns)) return '—';
  return usageMoney(row.costUsd);
}

// The recorded route kind decides; the id is only the fallback for rows
// written before the rollup carried one. Reading the id first labelled a
// quota-metered API lane as a subscription.
export function statsPlan(provider: string, kind: string): 'api' | 'subscription' | 'local' | '' {
  const id = provider.toLowerCase();
  if (kind === 'local' || id === 'mixdog-local') return 'local';
  if (kind === 'oauth' || kind === 'quota-api') return 'subscription';
  if (kind === 'api') return 'api';
  if (id.includes('oauth')) return 'subscription';
  return id ? 'api' : '';
}

export function statsPlanLabel(plan: ReturnType<typeof statsPlan>): string {
  if (plan === 'subscription') return t('Subscription');
  if (plan === 'local') return t('Local');
  return plan === 'api' ? 'API' : '';
}

export function StatsValue({ value, loading = false }: { value: string; loading?: boolean }) {
  return loading ? <span className="usage-skeleton stats-value-skeleton" aria-hidden="true" /> : value;
}

/** Input as sent: fresh input plus the prompt written to cache. Cached providers
 *  file most of a turn's new content as a cache write, so the fresh figure alone
 *  made them look idle beside an uncached provider doing the same work.
 *  input + output + cache hits then adds up to the token total. */
export function promptTokens(row: Row): number {
  return statsNumber(row.input) + statsNumber(row.cacheWrite);
}

export function promptDetail(row: Row, incomplete: boolean): string {
  return `${t('Cache excluded')}: ${statsTokens(row.input, incomplete)} · ${t('Cache writes')}: ${statsTokens(row.cacheWrite, incomplete)}`;
}

export function localDayKey(time: number): string {
  return dayKey(new Date(time));
}

function localClockKey(time: number): string {
  const date = new Date(time);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Step a custom range by its own length, the way the preset arrows page.
 *  A range without clock times keeps landing on whole days. */
export function shiftCustomRange(range: DayRange, direction: 1 | -1): DayRange {
  const from = new Date(`${range.startDay}T${range.startTime || '00:00'}:00`).getTime();
  const to = new Date(`${range.endDay}T${range.endTime || '23:59'}:59.999`).getTime();
  const span = to - from + 1;
  const nextFrom = from + direction * span;
  const nextTo = to + direction * span;
  return {
    startDay: localDayKey(nextFrom),
    endDay: localDayKey(nextTo),
    ...(range.startTime ? { startTime: localClockKey(nextFrom) } : {}),
    ...(range.endTime ? { endTime: localClockKey(nextTo) } : {}),
  };
}

/** Monday of the week a `YYYY-MM-DD` day belongs to. */
function weekBucketKey(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return day;
  // getDay() counts Sunday as 0; the week is read as Monday-first.
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return localDayKey(date.getTime());
}

/** Count calendar buckets, including partial edges and dates with no usage.
 *  UTC date ordinals avoid DST changing the number of selected calendar days. */
export function resolveUsageTrendGrouping(startDay: string, endDay: string): TrendGrouping {
  const ordinal = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86400000;
  const firstYear = Number(startDay.slice(0, 4));
  const lastYear = Number(endDay.slice(0, 4));
  const counts: Array<[Grain, number]> = [
    ['day', ordinal(endDay) - ordinal(startDay) + 1],
    ['week', (ordinal(weekBucketKey(endDay)) - ordinal(weekBucketKey(startDay))) / 7 + 1],
    ['month', (lastYear - firstYear) * 12 + Number(endDay.slice(5, 7)) - Number(startDay.slice(5, 7)) + 1],
    ['year', lastYear - firstYear + 1],
  ];
  const grain = counts.find(([, count]) => count <= MAX_TREND_BARS)?.[0] || 'year';
  return {
    grain,
    step: grain === 'year' ? Math.ceil((lastYear - firstYear + 1) / MAX_TREND_BARS) : 1,
    firstYear,
    lastYear,
  };
}

type TrendTotals = {
  tokens: number;
  costUsd: number;
  turns: number;
  unmeasuredTurns: number;
  costUnpricedTurns: number;
};

export type TrendBucket = TrendTotals & {
  key: string;
  label: string;
  future: boolean;
  fromMs: number | null;
  toMs: number | null;
  startDay: string;
  endDay: string;
  providers: Map<string, TrendTotals>;
};

function emptyTrendTotals(): TrendTotals {
  return { tokens: 0, costUsd: 0, turns: 0, unmeasuredTurns: 0, costUnpricedTurns: 0 };
}

function addTrendTotals(target: TrendTotals, row: Row) {
  target.tokens += statsNumber(row.tokens);
  target.costUsd += statsNumber(row.costUsd);
  target.turns += statsNumber(row.turns);
  target.unmeasuredTurns += statsNumber(row.unmeasuredTurns);
  target.costUnpricedTurns += unpricedTurns(row);
}

// The 24-hour view is a ROLLING window, and the server keys its buckets by
// absolute start time (19:48, 20:48 …). A background refresh lands seconds
// after every streamed turn, so all 24 buckets arrived under brand-new keys:
// React rebuilt every bar and the hovered bucket was no longer in the series,
// which closed the detail card mid-hover (user: 트랜스크립트 갱신될 때 자동
// 으로 닫힌다). A rolling slot is identified by its POSITION, padded so the
// key sort stays positional.
function trendBucketIdentity(
  entry: Row,
  index: number,
  day: string,
  { grain, step, firstYear, lastYear }: TrendGrouping
): { key: string; label: string } {
  let key = day;
  if (grain === 'hour') key = String(index).padStart(3, '0');
  else if (grain === 'year') key = day.slice(0, 4);
  else if (grain === 'month') key = day.slice(0, 7);
  else if (grain === 'week') key = weekBucketKey(day);
  if (grain === 'year' && step > 1) {
    key = String(firstYear + Math.floor((Number(key) - firstYear) / step) * step);
  }
  const finalYear = Math.min(Number(key) + step - 1, lastYear);
  const calendarLabel = grain === 'year' && step > 1 && finalYear > Number(key) ? `${key}–${finalYear}` : key;
  let label = calendarLabel;
  if (grain === 'hour') label = entry.unknown ? t('Unknown time') : String(entry.label || key);
  else if (grain === 'week') label = day;
  return { key, label };
}

export function groupTrend(daily: Row[], grouping: TrendGrouping): TrendBucket[] {
  const { grain } = grouping;
  const buckets = new Map<string, TrendBucket>();
  for (const [index, entry] of daily.entries()) {
    const day = String(grain === 'hour' ? entry.key || '' : entry.day || '');
    if (!day) continue;
    const { key, label: bucketLabel } = trendBucketIdentity(entry, index, day, grouping);
    const bucket = buckets.get(key) || {
      key,
      label: bucketLabel,
      ...emptyTrendTotals(),
      future: true,
      fromMs: usageNumber(entry.fromMs),
      toMs: usageNumber(entry.toMs),
      startDay: grain === 'hour' ? '' : day,
      endDay: grain === 'hour' ? '' : day,
      providers: new Map<string, TrendTotals>(),
    };
    bucket.future = bucket.future && entry.future === true;
    if (grain !== 'hour') bucket.endDay = day;
    addTrendTotals(bucket, entry);
    for (const slice of rows(entry.providers)) {
      const id = String(slice.provider || '');
      if (!id) continue;
      const provider = bucket.providers.get(id) || emptyTrendTotals();
      addTrendTotals(provider, slice);
      bucket.providers.set(id, provider);
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => compareBucketKeys(a.key, b.key));
}

function compareBucketKeys(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function metricValue(bucket: TrendTotals, metric: Metric): number {
  if (metric === 'costUsd') return bucket.costUsd;
  return metric === 'turns' ? bucket.turns : bucket.tokens;
}

export function trendMetricTitle(metric: Metric, bucket: { costUnpricedTurns: number }): string | undefined {
  if (metric === 'tokens') return t('Cache excluded');
  if (metric === 'costUsd' && bucket.costUnpricedTurns > 0) return t('Partial cost');
  return undefined;
}

export function trendEmptyText(metric: Metric, series: TrendBucket[]): string {
  if (metric === 'costUsd' && series.some((entry) => entry.costUnpricedTurns > 0)) return t('Price unavailable');
  if (metric === 'costUsd' && series.some((entry) => entry.turns > 0)) return `${t('Cost')} ${usageMoney(0)}`;
  if (series.some((entry) => entry.unmeasuredTurns > 0)) return t('Unknown usage');
  return t('No usage in this period.');
}

export function metricText(value: number, metric: Metric, incomplete = false): string {
  if (metric === 'turns') return statsCount(value);
  if (incomplete && value === 0) return '—';
  return metric === 'costUsd' ? usageMoney(value) : statsTokens(value, incomplete);
}

export function trendMetricText(totals: TrendTotals, metric: Metric): string {
  if (metric === 'costUsd') return statsMoney({ ...totals });
  return metricText(metricValue(totals, metric), metric, totals.unmeasuredTurns > 0);
}

export function trendPeriodLabel(bucket: TrendBucket): string {
  if (bucket.fromMs !== null && bucket.toMs !== null) {
    return new Intl.DateTimeFormat(uiFormatLocale(), {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).formatRange(new Date(bucket.fromMs), new Date(bucket.toMs));
  }
  if (!bucket.startDay) return bucket.label;
  return new Intl.DateTimeFormat(uiFormatLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).formatRange(new Date(`${bucket.startDay}T00:00:00`), new Date(`${bucket.endDay}T00:00:00`));
}

export function periodLabel(view: StatsView, period: Row, firstDay?: string): string {
  // A range cut by the clock reads like the rolling window: only the exact
  // instants tell the reader where a partial day was cut.
  const clocked = view === 'custom' && Boolean(period.startTime || period.endTime);
  if (view === 'hour' || clocked) {
    if (!period.fromMs || !period.toMs) return clocked ? '—' : t('Last 24 hours');
    const options: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    };
    if (clocked) options.year = 'numeric';
    return new Intl.DateTimeFormat(uiFormatLocale(), options).formatRange(
      new Date(Number(period.fromMs)),
      new Date(Number(period.toMs))
    );
  }
  const startDay = view === 'year' ? firstDay : period.startDay;
  if (!startDay || !period.endDay) return view === 'year' ? t('All') : '—';
  return new Intl.DateTimeFormat(uiFormatLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).formatRange(new Date(`${String(startDay)}T00:00:00`), new Date(`${String(period.endDay)}T00:00:00`));
}
