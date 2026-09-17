/**
 * Token and cost totals by provider, with the models beneath each provider.
 * /usage answers what quota is LEFT; this answers what was SPENT to get there.
 *
 * Every turn counts, background runners included: what this surface is asked
 * is what the machine spent, not which part of it the user typed himself.
 *
 * One thing the raw totals still get wrong if shown as-is: cache reads outweigh
 * real traffic by orders of magnitude, so cache sits beside the token figure
 * instead of inside it.
 */
import { useId, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { DesktopCapability } from '../shared/contract';
import { t, uiFormatLocale } from './i18n';
import { modelDisplayName, providerDisplayName, ProviderIcon } from './provider-display';
import { record } from './record-utils';
import { usageCompact, usageMoney, usageNumber, usageProviderLabel } from './usage-format';
import { useHoverPopover } from './hover-popover';
import { acquireModalLayer } from './modal-layer';

type Row = Record<string, unknown>;
type StatsRequest = (capability: DesktopCapability, args?: unknown[]) => Promise<unknown>;
type SortKey = 'tokens' | 'costUsd' | 'turns';

type Grain = 'hour' | 'day' | 'week' | 'month' | 'year';
type StatsView = Grain | '7d' | 'custom';
type Metric = 'tokens' | 'costUsd' | 'turns';
type TrendGrouping = { grain: Grain; step: number; firstYear: number; lastYear: number };
const MAX_TREND_BARS = 30;

function statsNumber(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function statsTokens(value: unknown, incomplete = false): string {
  if (incomplete && !(statsNumber(value) > 0)) return '—';
  return usageCompact(value) || '—';
}

function statsCount(value: unknown): string {
  const count = usageNumber(value);
  return count === null ? '—' : count.toLocaleString(uiFormatLocale());
}

function statsPercent(value: unknown): string {
  if (usageNumber(value) === null) return '—';
  return `${(statsNumber(value) * 100).toFixed(1)}%`;
}

function unpricedTurns(row: Row): number {
  const turns = statsNumber(row.turns);
  const missing = usageNumber(row.costUnpricedTurns);
  if (missing !== null) return Math.max(0, missing);
  const known = usageNumber(row.costKnownTurns);
  if (known !== null) return Math.max(0, turns - known);
  return turns * (1 - Math.min(1, Math.max(0, statsNumber(row.costCoverage))));
}

function statsMoney(row: Row): string {
  const missing = unpricedTurns(row);
  if (missing > 0 && missing >= statsNumber(row.turns)) return '—';
  return usageMoney(row.costUsd);
}

// The recorded route kind decides; the id is only the fallback for rows
// written before the rollup carried one. Reading the id first labelled a
// quota-metered API lane as a subscription.
function statsPlan(provider: string, kind: string): 'api' | 'subscription' | 'local' | '' {
  const id = provider.toLowerCase();
  if (kind === 'local' || id === 'mixdog-local') return 'local';
  if (kind === 'oauth' || kind === 'quota-api') return 'subscription';
  if (kind === 'api') return 'api';
  if (id.includes('oauth')) return 'subscription';
  return id ? 'api' : '';
}

function statsPlanLabel(plan: ReturnType<typeof statsPlan>): string {
  return plan === 'subscription' ? t('Subscription') : plan === 'local' ? t('Local') : plan === 'api' ? 'API' : '';
}

function StatsValue({ value, loading = false }: { value: string; loading?: boolean }) {
  return loading ? <span className="usage-skeleton stats-value-skeleton" aria-hidden="true" /> : value;
}

function StatCard({
  label,
  value,
  detail,
  loading,
}: {
  label: string;
  value: string;
  detail?: string;
  loading?: boolean;
}) {
  return (
    <div className="stats-card">
      <small title={detail}>{label}</small>
      <b title={detail}>
        <StatsValue value={value} loading={loading} />
      </b>
    </div>
  );
}

/** Input as sent: fresh input plus the prompt written to cache. Cached providers
 *  file most of a turn's new content as a cache write, so the fresh figure alone
 *  made them look idle beside an uncached provider doing the same work.
 *  input + output + cache hits then adds up to the token total. */
function promptTokens(row: Row): number {
  return statsNumber(row.input) + statsNumber(row.cacheWrite);
}

function promptDetail(row: Row, incomplete: boolean): string {
  return `${t('Cache excluded')}: ${statsTokens(row.input, incomplete)} · ${t('Cache writes')}: ${statsTokens(row.cacheWrite, incomplete)}`;
}

function TokenMix({ totals, loading }: { totals: Row; loading: boolean }) {
  const incomplete = statsNumber(totals.unmeasuredTurns) > 0;
  // Cache hits stay OUT of the bar. They run two orders of magnitude above the
  // rest on a long session, so including them painted one flat grey block and
  // buried the only split worth reading here: how much was sent versus generated.
  const parts = [
    { key: 'input', label: t('Input'), value: promptTokens(totals), title: promptDetail(totals, incomplete) },
    { key: 'output', label: t('Output'), value: statsNumber(totals.output), title: undefined },
  ];
  const cache = statsNumber(totals.cacheRead);
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  return (
    <section className="stats-mix">
      <header>
        <h4>{t('Token mix')}</h4>
        {(cache > 0 || loading) && (
          <span>
            {t('Cache hit rate')} <StatsValue value={statsPercent(totals.cacheHitRate)} loading={loading} />
          </span>
        )}
      </header>
      <div className={`stats-mix-bar${loading ? ' usage-skeleton' : ''}`} role="img" aria-label={t('Token mix')}>
        {total > 0 ? (
          parts
            .filter((part) => part.value > 0)
            .map((part) => (
              <i key={part.key} data-part={part.key} style={{ width: `${(part.value / total) * 100}%` }} />
            ))
        ) : (
          <i data-part="empty" style={{ width: '100%' }} />
        )}
      </div>
      <ul>
        {parts.map((part) => (
          <li key={part.key} title={part.title}>
            <i data-part={part.key} aria-hidden="true" />
            {part.label}
            <b>
              <StatsValue value={statsTokens(part.value, incomplete && part.key === 'input')} loading={loading} />
            </b>
          </li>
        ))}
        <li>
          <i data-part="cache" aria-hidden="true" />
          {t('Cache hits')}
          <b>
            <StatsValue value={statsTokens(cache, incomplete)} loading={loading} />
          </b>
        </li>
      </ul>
    </section>
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function localDayKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
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

type TrendBucket = TrendTotals & {
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

function groupTrend(daily: Row[], grouping: TrendGrouping): TrendBucket[] {
  const { grain, step, firstYear, lastYear } = grouping;
  const buckets = new Map<string, TrendBucket>();
  for (const entry of daily) {
    const day = String(grain === 'hour' ? entry.key || '' : entry.day || '');
    if (!day) continue;
    let key =
      grain === 'year'
        ? day.slice(0, 4)
        : grain === 'month'
          ? day.slice(0, 7)
          : grain === 'week'
            ? weekBucketKey(day)
            : day;
    if (grain === 'year' && step > 1) {
      key = String(firstYear + Math.floor((Number(key) - firstYear) / step) * step);
    }
    const finalYear = Math.min(Number(key) + step - 1, lastYear);
    const calendarLabel = grain === 'year' && step > 1 && finalYear > Number(key) ? `${key}–${finalYear}` : key;
    const bucket = buckets.get(key) || {
      key,
      label:
        grain === 'hour'
          ? entry.unknown
            ? t('Unknown time')
            : String(entry.label || key)
          : grain === 'week'
            ? day
            : calendarLabel,
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
    for (const raw of Array.isArray(entry.providers) ? (entry.providers as unknown[]) : []) {
      const slice = record(raw);
      const id = String(slice.provider || '');
      if (!id) continue;
      const provider = bucket.providers.get(id) || emptyTrendTotals();
      addTrendTotals(provider, slice);
      bucket.providers.set(id, provider);
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function metricValue(bucket: TrendTotals, metric: Metric): number {
  return metric === 'costUsd' ? bucket.costUsd : metric === 'turns' ? bucket.turns : bucket.tokens;
}

function metricText(value: number, metric: Metric, incomplete = false): string {
  if (metric === 'turns') return statsCount(value);
  if (incomplete && value === 0) return '—';
  return metric === 'costUsd' ? usageMoney(value) : statsTokens(value, incomplete);
}

function trendMetricText(totals: TrendTotals, metric: Metric): string {
  if (metric === 'costUsd') return statsMoney({ ...totals });
  return metricText(metricValue(totals, metric), metric, totals.unmeasuredTurns > 0);
}

function trendPeriodLabel(bucket: TrendBucket): string {
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

/** Provider identity, not rank or metric, owns the colour of every band. */
function TrendBar({
  bucket,
  metric,
  peak,
  order,
  interaction,
  expanded,
  controls,
}: {
  bucket: TrendBucket;
  metric: Metric;
  peak: number;
  order: string[];
  interaction: Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onMouseEnter' | 'onFocus' | 'onBlur'>;
  expanded: boolean;
  controls: string;
}) {
  const total = metricValue(bucket, metric);
  const height = peak > 0 ? Math.max(total > 0 ? 3 : 1, (total / peak) * 100) : 1;
  const parts = order
    .map((id) => ({ id, value: statsNumber(bucket.providers.get(id)?.[metric]) }))
    .filter((part) => part.value > 0);
  const summed = parts.reduce((sum, part) => sum + part.value, 0);
  const title = bucket.future
    ? bucket.label
    : `${bucket.label} · ${
        metric === 'costUsd'
          ? statsMoney(bucket as unknown as Row)
          : metricText(total, metric, bucket.unmeasuredTurns > 0)
      }`;
  return (
    <button
      type="button"
      className="stats-trend-bar"
      {...interaction}
      aria-label={title}
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
    >
      <i
        className="stats-trend-fill"
        style={{ height: `${height}%` }}
        aria-hidden="true"
        data-empty={total > 0 ? undefined : 'true'}
        data-future={bucket.future ? 'true' : undefined}
      >
        {/* A bar with no split to draw stays a plain block rather than an empty
        outline: an unattributed day must not read as a different colour. */}
        {summed > 0 &&
          parts.map((part) => (
            <b key={part.id} data-usage-provider={part.id} style={{ height: `${(part.value / summed) * 100}%` }} />
          ))}
      </i>
    </button>
  );
}

function UsageTrend({
  daily,
  hourly,
  view,
  providerOrder,
  providers,
  period,
  loading,
}: {
  daily: Row[];
  hourly: Row[];
  view: StatsView;
  providerOrder: string[];
  providers: Row[];
  period: Row;
  loading: boolean;
}) {
  const [metric, setMetric] = useState<Metric>('tokens');
  const startDay = String(period.startDay || daily[0]?.day || '');
  const endDay = String(period.endDay || daily.at(-1)?.day || '');
  const calendarGrouping =
    startDay && endDay && (view === 'custom' || view === 'year')
      ? resolveUsageTrendGrouping(startDay, endDay)
      : { grain: 'day' as Grain, step: 1, firstYear: 0, lastYear: 0 };
  // Presets retain their advertised units. Custom ranges choose the finest
  // calendar unit that fits; all-history also caps very long yearly series.
  const grouping: TrendGrouping = {
    ...calendarGrouping,
    grain: view === 'custom' ? calendarGrouping.grain : view === '7d' ? 'day' : view,
  };
  const { grain } = grouping;
  const series = groupTrend(view === 'hour' ? hourly : daily, grouping);
  const popover = useHoverPopover();
  const detailId = useId();
  const detailRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const active = series.find((bucket) => bucket.key === activeKey);
  useLayoutEffect(() => {
    const host = popover.host.current;
    const card = detailRef.current;
    const anchor = anchorRef.current;
    if (!popover.open || !host || !card || !anchor) return;
    const layer = acquireModalLayer([]);
    layer.attachSurface(card);
    const bounds = host.closest('.mixdog-settings__body')?.getBoundingClientRect() || {
      top: 0,
      left: 0,
      bottom: window.innerHeight,
      right: window.innerWidth,
    };
    const top = Math.max(0, bounds.top) + 8;
    const bottom = Math.min(window.innerHeight, bounds.bottom) - 8;
    const left = Math.max(0, bounds.left) + 8;
    const right = Math.min(window.innerWidth, bounds.right) - 8;
    card.style.maxHeight = `${Math.max(0, bottom - top)}px`;
    const size = card.getBoundingClientRect();
    const owner = host.getBoundingClientRect();
    const trigger = anchor.getBoundingClientRect();
    const above = owner.top - size.height - 8;
    setPosition({
      left: Math.max(left, Math.min(right - size.width, (trigger.left + trigger.right - size.width) / 2)) - owner.left,
      top: Math.max(top, above >= top ? above : Math.min(owner.bottom + 8, bottom - size.height)) - owner.top,
    });
    const dismissOnScroll = (event: Event) => {
      if (event.target instanceof Node && card.contains(event.target)) return;
      popover.close();
    };
    window.addEventListener('scroll', dismissOnScroll, true);
    window.addEventListener('resize', popover.close);
    return () => {
      layer.release();
      window.removeEventListener('scroll', dismissOnScroll, true);
      window.removeEventListener('resize', popover.close);
    };
  }, [popover.open, activeKey, metric, view, daily, hourly]);
  const activate = (key: string, element: HTMLButtonElement, mode: 'hover' | 'focus' | 'click') => {
    if (mode === 'hover' && popover.pinned) return;
    anchorRef.current = element;
    const changingPinned = mode === 'click' && popover.pinned && activeKey !== key;
    setActiveKey(key);
    if (changingPinned) popover.setOpen(true);
    else if (mode === 'click') popover.triggerProps.onClick();
    else if (mode === 'focus') popover.triggerProps.onFocus();
    else popover.hostProps.onMouseEnter();
  };
  // Partial weeks/months must not label the axis outside the queried dates.
  const axisStart = view === 'hour' ? series[0]?.label : String(period.startDay || daily[0]?.day || '');
  const axisEnd = view === 'hour' ? series.at(-1)?.label : String(period.endDay || daily.at(-1)?.day || '');
  const peak = series.reduce((max, entry) => Math.max(max, metricValue(entry, metric)), 0);
  const peakLabel = t('Peak per {{interval}}', {
    interval: new Intl.NumberFormat(uiFormatLocale(), { style: 'unit', unit: grain, unitDisplay: 'long' }).format(
      grouping.step
    ),
  });
  // Tokens and cost diverge by several times: a provider can be a small share
  // of the traffic and most of the spend. The chart draws whichever question
  // is being asked rather than implying one answers the other.
  const metrics: ReadonlyArray<{ key: Metric; label: string }> = [
    { key: 'tokens', label: t('Tokens') },
    { key: 'costUsd', label: t('Cost') },
    { key: 'turns', label: t('Usage records') },
  ];
  return (
    <section className="stats-trend">
      <header>
        <h4>{t('Trend')}</h4>
        <div className="stats-ranges stats-grains" role="group" aria-label={t('Metric')}>
          {metrics.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`stats-range ${option.key === metric ? 'is-active' : ''}`}
              aria-pressed={option.key === metric}
              disabled={loading}
              onClick={() => {
                popover.close();
                setMetric(option.key);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        {(peak > 0 || loading) && (
          <span>
            {peakLabel}{' '}
            <StatsValue
              loading={loading}
              value={metricText(
                peak,
                metric,
                series.some((entry) => (metric === 'costUsd' ? entry.costUnpricedTurns > 0 : entry.unmeasuredTurns > 0))
              )}
            />
          </span>
        )}
      </header>
      {/* A period with nothing in it says so. A row of hairlines under
        "Peak 0" read as a chart that failed to draw. */}
      {loading ? (
        <div className="stats-trend-bars stats-trend-skeleton usage-skeleton" aria-hidden="true" />
      ) : peak > 0 ? (
        <div
          className="stats-trend-bars"
          {...popover.hostProps}
          onKeyDownCapture={(event) => {
            if (popover.open && event.key === 'Escape') {
              event.stopPropagation();
              popover.close();
            }
          }}
          data-single={series.length === 1 ? 'true' : undefined}
        >
          {series.map((entry) => (
            <TrendBar
              key={entry.key}
              bucket={entry}
              metric={metric}
              peak={peak}
              order={providerOrder}
              expanded={popover.open && activeKey === entry.key}
              controls={detailId}
              interaction={{
                onMouseEnter: (event) => activate(entry.key, event.currentTarget, 'hover'),
                onFocus: (event) => activate(entry.key, event.currentTarget, 'focus'),
                onClick: (event) => activate(entry.key, event.currentTarget, 'click'),
                onBlur: popover.triggerProps.onBlur,
              }}
            />
          ))}
          {popover.open && active && (
            <div
              className="stats-trend-detail"
              ref={detailRef}
              id={detailId}
              role="dialog"
              aria-modal="false"
              aria-labelledby={`${detailId}-period`}
              style={position}
              data-pinned={popover.pinned ? 'true' : undefined}
            >
              <div className="stats-trend-detail-heading">
                <b id={`${detailId}-period`}>{trendPeriodLabel(active)}</b>
                <button type="button" aria-label={t('Close')} onClick={popover.close}>
                  <X aria-hidden="true" />
                </button>
              </div>
              <dl className="stats-trend-detail-totals">
                {metrics.map((option) => (
                  <div key={option.key}>
                    <dt>{option.label}</dt>
                    <dd
                      title={
                        option.key === 'tokens'
                          ? t('Cache excluded')
                          : option.key === 'costUsd' && active.costUnpricedTurns > 0
                            ? t('Partial cost')
                            : undefined
                      }
                    >
                      {trendMetricText(active, option.key)}
                    </dd>
                  </div>
                ))}
              </dl>
              <ul aria-label={t('Provider')}>
                {providerOrder
                  .filter((id) => active.providers.has(id))
                  .map((id) => {
                    const usage = active.providers.get(id)!;
                    const provider = providers.find((row) => row.provider === id);
                    const plan = statsPlan(id, String(provider?.providerKind || ''));
                    return (
                      <li key={id}>
                        <span>
                          <i data-usage-provider={id} aria-hidden="true" />
                          {usageProviderLabel(providerDisplayName(id))}
                          {plan ? ` · ${statsPlanLabel(plan)}` : ''}
                        </span>
                        <b>{trendMetricText(usage, metric)}</b>
                      </li>
                    );
                  })}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <p className="stats-trend-empty">
          {metric === 'costUsd' && series.some((entry) => entry.costUnpricedTurns > 0)
            ? t('Price unavailable')
            : metric === 'costUsd' && series.some((entry) => entry.turns > 0)
              ? `${t('Cost')} ${usageMoney(0)}`
              : series.some((entry) => entry.unmeasuredTurns > 0)
                ? t('Unknown usage')
                : t('No usage in this period.')}
        </p>
      )}
      <footer data-single={axisStart === axisEnd ? 'true' : undefined}>
        <span>{axisStart}</span>
        {axisStart !== axisEnd && <span>{axisEnd}</span>}
      </footer>
      <ul className="stats-trend-legend">
        {providerOrder.map((id) => {
          const provider = providers.find((row) => row.provider === id);
          const plan = statsPlan(id, String(provider?.providerKind || ''));
          return (
            <li key={id}>
              <i data-usage-provider={id} aria-hidden="true" />
              {usageProviderLabel(providerDisplayName(id))}
              {plan ? ` · ${statsPlanLabel(plan)}` : ''}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RouteCells({ route }: { route: Row }) {
  const incomplete = statsNumber(route.unmeasuredTurns) > 0;
  return (
    <>
      <td>{statsCount(route.turns)}</td>
      <td className="stats-breakdown" title={promptDetail(route, incomplete)}>
        {statsTokens(promptTokens(route), incomplete)}
      </td>
      <td className="stats-breakdown">{statsTokens(route.output)}</td>
      <td className="stats-breakdown">{statsTokens(route.cacheRead, incomplete)}</td>
      <td className="stats-optional">{statsPercent(route.cacheHitRate)}</td>
      <td className="stats-total-cell">{statsTokens(route.tokens, incomplete)}</td>
      <td
        className="stats-cost-cell"
        title={
          unpricedTurns(route) > 0 ? t('Partial cost') : undefined
        }
      >
        {statsMoney(route)}
      </td>
    </>
  );
}

function SortHeader({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sort: SortKey;
  onSort: (next: SortKey) => void;
  className?: string;
}) {
  const active = sort === column;
  return (
    <th scope="col" className={className} aria-sort={active ? 'descending' : 'none'}>
      <button
        type="button"
        className="stats-sort"
        data-active={active ? 'true' : 'false'}
        onClick={() => onSort(column)}
      >
        {label}
      </button>
    </th>
  );
}

function periodLabel(view: StatsView, period: Row, firstDay?: string): string {
  if (view === 'hour') {
    if (!period.fromMs || !period.toMs) return t('Last 24 hours');
    return new Intl.DateTimeFormat(uiFormatLocale(), {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).formatRange(new Date(Number(period.fromMs)), new Date(Number(period.toMs)));
  }
  const startDay = view === 'year' ? firstDay : period.startDay;
  if (!startDay || !period.endDay) return view === 'year' ? t('All') : '—';
  return new Intl.DateTimeFormat(uiFormatLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).formatRange(new Date(`${String(startDay)}T00:00:00`), new Date(`${String(period.endDay)}T00:00:00`));
}

export function UsageStatsBody({
  data,
  request,
  loading = false,
}: {
  data: Record<string, unknown>;
  request: StatsRequest;
  loading?: boolean;
}) {
  const loaded = useMemo(() => record(data.getUsageStats), [data.getUsageStats]);
  // Read initial data directly: an effect-based copy exposed an empty frame
  // between the loading placeholder and the first real response.
  const [selection, setSelection] = useState<{ view: StatsView; stats: Row } | null>(null);
  const stats = selection?.stats ?? loaded;
  const view = selection?.view ?? 'hour';
  const initialPeriod = useMemo(() => {
    const toMs = Date.now();
    return { fromMs: toMs - 24 * 60 * 60 * 1000, toMs };
  }, []);
  const [sort, setSort] = useState<SortKey>('tokens');
  const [customOpen, setCustomOpen] = useState(false);
  // Editing a custom range selects its tab without replacing the applied data.
  const activeView = customOpen ? 'custom' : view;
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  // Models start visible, including providers arriving with a new period.
  // Only explicit collapses are retained.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleExpanded = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Only the newest request may publish: clicking through the chips must not
  // let a slower earlier answer overwrite the current selection.
  const sequence = useRef(0);
  const reload = (nextView: StatsView, anchor?: string, dates?: { startDay: string; endDay: string }) => {
    const ticket = ++sequence.current;
    setBusy(true);
    setError('');
    void request('getUsageStats', [{ view: nextView, ...(anchor ? { anchor } : {}), ...dates }])
      .then((value) => {
        if (sequence.current === ticket) {
          setSelection({ stats: record(value), view: nextView });
        }
      })
      .catch((reason) => {
        if (sequence.current === ticket) setError(String(reason?.message || reason));
      })
      .finally(() => {
        if (sequence.current === ticket) setBusy(false);
      });
  };

  const totals = record(stats.totals);
  const period: Row = loading ? initialPeriod : record(stats.period);
  const coverage = record(stats.coverage);
  const daily = (Array.isArray(stats.daily) ? (stats.daily as unknown[]) : []).map(record);
  const hourly = (Array.isArray(stats.hourly) ? (stats.hourly as unknown[]) : []).map(record);
  const providerRows = (Array.isArray(stats.providers) ? (stats.providers as unknown[]) : []).map(record);
  const providers = [...providerRows].sort((a, b) => statsNumber(b[sort]) - statsNumber(a[sort]));
  // Traffic determines band order. Provider identity owns its fixed colour.
  const providerOrder = [...providerRows]
    .sort((a, b) => statsNumber(b.tokens) - statsNumber(a.tokens))
    .map((row) => String(row.provider || ''));
  const subscriptionRows = providers.filter(
    (row) => statsPlan(String(row.provider || ''), String(row.providerKind || '')) === 'subscription'
  );
  const apiRows = providers.filter(
    (row) => statsPlan(String(row.provider || ''), String(row.providerKind || '')) === 'api'
  );
  const subscriptionCost = subscriptionRows.reduce((sum, row) => sum + statsNumber(row.costUsd), 0);
  const apiCost = apiRows.reduce((sum, row) => sum + statsNumber(row.costUsd), 0);
  const moneyFor = (rows: Row[], amount: number) =>
    statsMoney({
      costUsd: amount,
      turns: rows.reduce((sum, row) => sum + statsNumber(row.turns), 0),
      costUnpricedTurns: rows.reduce((sum, row) => sum + unpricedTurns(row), 0),
    });
  const tokens = statsNumber(totals.tokens);
  const turns = statsNumber(totals.turns);
  const historyDays = statsNumber(coverage.historyDays);
  const partialDays = statsNumber(coverage.partialDays);
  const incomplete = statsNumber(totals.unmeasuredTurns) > 0;
  const tokenInfo = [
    t('Input, output and cache hits combined.'),
    historyDays > 0
      ? t('Some historical days use estimated token counts, dates and costs.')
      : partialDays > 0
        ? t('Historical records may be incomplete; only surviving usage is counted.')
        : '',
  ]
    .filter(Boolean)
    .join('\n');
  const waiting = busy || loading;
  const views: ReadonlyArray<{ key: StatsView; label: string }> = [
    { key: 'hour', label: t('Last 24 hours') },
    { key: '7d', label: t('Last 7 days') },
    { key: 'day', label: t('Last 30 days') },
    { key: 'week', label: t('Last 90 days') },
    { key: 'month', label: t('Last year') },
    { key: 'year', label: t('All') },
    { key: 'custom', label: t('Custom') },
  ];
  return (
    <div
      className="stats-surface"
      aria-busy={waiting ? 'true' : undefined}
      data-loading={loading ? 'true' : undefined}
      data-empty={!loading && turns === 0 && !providers.length ? 'true' : undefined}
    >
      {loading && (
        <p className="sr-only" role="status">
          {t('Loading…')}
        </p>
      )}
      <div className="stats-controls">
        <div className="stats-ranges" role="group" aria-label={t('Period')}>
          {views.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`stats-range ${option.key === activeView ? 'is-active' : ''}`}
              aria-pressed={option.key === activeView}
              disabled={waiting}
              aria-expanded={option.key === 'custom' ? customOpen : undefined}
              onClick={() => {
                if (option.key === 'custom') {
                  setCustomStart(
                    String(period.startDay || record(stats.range).firstDay || localDayKey(initialPeriod.fromMs))
                  );
                  setCustomEnd(String(period.endDay || localDayKey(initialPeriod.toMs)));
                  setCustomOpen(true);
                } else {
                  setCustomOpen(false);
                  if (option.key !== view) reload(option.key);
                }
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="stats-period">
          {view !== 'hour' && view !== 'year' && view !== 'custom' && (
            <button
              type="button"
              className="stats-period-arrow"
              aria-label={t('Previous period')}
              title={t('Previous period')}
              disabled={waiting || !period.previousAnchor}
              onClick={() => reload(view, String(period.previousAnchor))}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
          )}
          <span className="stats-period-label">
            {periodLabel(view, period, String(record(stats.range).firstDay || ''))}
          </span>
          {view !== 'hour' && view !== 'year' && view !== 'custom' && (
            <button
              type="button"
              className="stats-period-arrow"
              aria-label={t('Next period')}
              title={t('Next period')}
              disabled={waiting || !period.nextAnchor}
              onClick={() => reload(view, String(period.nextAnchor))}
            >
              <ChevronRight aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {customOpen && (
        <form
          className="stats-custom-range"
          onSubmit={(event) => {
            event.preventDefault();
            reload('custom', undefined, { startDay: customStart, endDay: customEnd });
          }}
        >
          <label>
            {t('Start date')}
            <input
              type="date"
              required
              disabled={waiting}
              min="1970-01-01"
              max={customEnd || localDayKey(Date.now())}
              value={customStart}
              onChange={(event) => setCustomStart(event.target.value)}
            />
          </label>
          <label>
            {t('End date')}
            <input
              type="date"
              required
              disabled={waiting}
              min={customStart || '1970-01-01'}
              max={localDayKey(Date.now())}
              value={customEnd}
              onChange={(event) => setCustomEnd(event.target.value)}
            />
          </label>
          <button
            className="stats-range"
            type="submit"
            disabled={waiting || !customStart || !customEnd || customStart > customEnd}
          >
            {t('Apply')}
          </button>
        </form>
      )}
      <div className="stats-cards">
        <StatCard
          label={t('Subscription list-price value')}
          value={moneyFor(subscriptionRows, subscriptionCost)}
          detail={t('Subscription values use list prices. API costs may be estimates; neither is an invoice.')}
          loading={loading}
        />
        <StatCard
          label={t('API cost')}
          value={moneyFor(apiRows, apiCost)}
          detail={t('Subscription values use list prices. API costs may be estimates; neither is an invoice.')}
          loading={loading}
        />
        <StatCard label={t('Tokens')} value={statsTokens(tokens, incomplete)} detail={tokenInfo} loading={loading} />
        <StatCard label={t('Usage records')} value={statsCount(turns)} loading={loading} />
      </div>
      <TokenMix totals={totals} loading={loading} />
      {/* The legend and every bar band read from one order, so a provider keeps
        its colour no matter which metric or grain is showing. */}
      <UsageTrend
        daily={daily}
        hourly={hourly}
        view={view}
        providerOrder={providerOrder}
        providers={providers}
        period={period}
        loading={loading}
      />
      {error && (
        <p className="stats-error" role="alert">
          {error}
        </p>
      )}
      <div className="usage-table-shell">
        <table className="usage-table stats-table" aria-label={t('Token usage')} inert={loading ? true : undefined}>
          <thead>
            <tr>
              <th scope="col">{t('Provider')}</th>
              <th scope="col" className="stats-share-col">
                {t('Usage share')}
              </th>
              <SortHeader label={t('Usage records')} column="turns" sort={sort} onSort={setSort} />
              <th scope="col" className="stats-breakdown" title={t('Fresh input plus cache writes')}>
                {t('Input')}
              </th>
              <th scope="col" className="stats-breakdown">
                {t('Output')}
              </th>
              <th scope="col" className="stats-breakdown">
                {t('Cache hits')}
              </th>
              <th scope="col" className="stats-optional">
                {t('Hit rate')}
              </th>
              <SortHeader
                label={t('Tokens')}
                column="tokens"
                sort={sort}
                onSort={setSort}
                className="stats-total-cell"
              />
              <SortHeader label={t('Cost')} column="costUsd" sort={sort} onSort={setSort} className="stats-cost-cell" />
            </tr>
          </thead>
          {providers.map((provider) => {
            const id = String(provider.provider || '');
            const models = (Array.isArray(provider.models) ? (provider.models as unknown[]) : []).map(record);
            const open = !collapsed.has(id);
            const plan = statsPlan(id, String(provider.providerKind || ''));
            const share = Math.round(statsNumber(provider.share) * 100);
            return (
              <tbody key={id} className="stats-provider" data-usage-provider={id} data-open={open ? 'true' : 'false'}>
                <tr className="stats-provider-row">
                  <td className="stats-provider-cell">
                    <button
                      type="button"
                      className="stats-provider-toggle"
                      aria-expanded={open}
                      disabled={!models.length}
                      onClick={() => toggleExpanded(id)}
                    >
                      <ChevronDown className="stats-provider-chevron" aria-hidden="true" />
                      <ProviderIcon provider={id} />
                      <b>{usageProviderLabel(providerDisplayName(id))}</b>
                      {plan && (
                        <span className="usage-plan" data-plan={plan}>
                          {statsPlanLabel(plan)}
                        </span>
                      )}
                    </button>
                    <div className="stats-provider-share" aria-hidden="true">
                      <i className="stats-share">
                        <i style={{ width: `${incomplete ? 0 : share}%` }} />
                      </i>
                    </div>
                  </td>
                  <td className="stats-share-cell">{incomplete ? '—' : `${share}%`}</td>
                  <RouteCells route={provider} />
                </tr>
                {open &&
                  models.map((model) => {
                    const name = String(model.model || '');
                    return (
                      <tr className="stats-model-row" key={name}>
                        <td className="stats-model-cell" title={modelDisplayName(name, id)}>
                          {modelDisplayName(name, id)}
                        </td>
                        <td className="stats-share-cell" />
                        <RouteCells route={model} />
                      </tr>
                    );
                  })}
              </tbody>
            );
          })}
          {loading && (
            <tbody aria-hidden="true">
              {[0, 1, 2].map((row) => (
                <tr className="usage-skeleton-row" key={row}>
                  <td colSpan={9}>
                    <span className="usage-skeleton" style={{ width: '35%' }} />
                  </td>
                </tr>
              ))}
            </tbody>
          )}
          {!loading && !providers.length && (
            <tbody>
              <tr>
                <td className="usage-empty" colSpan={9}>
                  {t('No usage recorded yet.')}
                </td>
              </tr>
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}
