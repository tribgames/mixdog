// Usage trend chart: grouped bars over the selected period.
import { useState, type ButtonHTMLAttributes } from 'react';
import { t, uiFormatLocale } from './i18n';
import { providerDisplayName } from './provider-display';
import { usageProviderLabel } from './usage-format';
import { TrendDetailCard, useTrendDetail } from './trend-detail';
import {
  StatsValue,
  groupTrend,
  metricText,
  metricValue,
  resolveUsageTrendGrouping,
  statsNumber,
  statsPlan,
  statsPlanLabel,
  trendEmptyText,
  trendMetricText,
  trendMetricTitle,
  trendPeriodLabel,
} from './usage-stats-model';
import type { Grain, Metric, Row, StatsView, TrendBucket, TrendGrouping } from './usage-stats-model';

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
  const minimumHeight = total > 0 ? 3 : 1;
  const height = peak > 0 ? Math.max(minimumHeight, (total / peak) * 100) : 1;
  const parts = order
    .map((id) => ({ id, value: statsNumber(bucket.providers.get(id)?.[metric]) }))
    .filter((part) => part.value > 0);
  const summed = parts.reduce((sum, part) => sum + part.value, 0);
  const title = bucket.future ? bucket.label : `${bucket.label} · ${trendMetricText(bucket, metric)}`;
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

export function UsageTrend({
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
  let presetGrain: TrendGrouping['grain'] = calendarGrouping.grain;
  if (view === '7d') presetGrain = 'day';
  else if (view !== 'custom') presetGrain = view;
  const grouping: TrendGrouping = { ...calendarGrouping, grain: presetGrain };
  const { grain } = grouping;
  const series = groupTrend(view === 'hour' ? hourly : daily, grouping);
  const detail = useTrendDetail([metric, view, daily, hourly]);
  const active = series.find((bucket) => bucket.key === detail.activeKey);
  // The legend and the detail rows name a provider the same way.
  const providerPlanSuffix = (id: string) => {
    const plan = statsPlan(id, String(providers.find((row) => row.provider === id)?.providerKind || ''));
    return plan ? ` · ${statsPlanLabel(plan)}` : '';
  };
  // Partial weeks/months must not label the axis outside the queried dates.
  const axisStart = view === 'hour' ? series[0]?.label : startDay;
  const axisEnd = view === 'hour' ? series.at(-1)?.label : endDay;
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
    { key: 'turns', label: t('Requests') },
  ];
  return (
    <section className="stats-trend" aria-label={t('Trend')}>
      <header>
        <div className="stats-ranges stats-grains" role="group" aria-label={t('Metric')}>
          {metrics.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`stats-range ${option.key === metric ? 'is-active' : ''}`}
              aria-pressed={option.key === metric}
              disabled={loading}
              onClick={() => {
                detail.popover.close();
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
      {loading && <div className="stats-trend-bars stats-trend-skeleton usage-skeleton" aria-hidden="true" />}
      {!loading && peak > 0 && (
        <div className="stats-trend-bars" {...detail.hostProps} data-single={series.length === 1 ? 'true' : undefined}>
          {series.map((entry) => (
            <TrendBar
              key={entry.key}
              bucket={entry}
              metric={metric}
              peak={peak}
              order={providerOrder}
              expanded={detail.popover.open && detail.activeKey === entry.key}
              controls={detail.detailId}
              interaction={detail.interaction(entry.key)}
            />
          ))}
          {detail.popover.open && active && (
            <TrendDetailCard detail={detail} title={trendPeriodLabel(active)}>
              <dl className="stats-trend-detail-totals">
                {metrics.map((option) => (
                  <div key={option.key}>
                    <dt>{option.label}</dt>
                    <dd title={trendMetricTitle(option.key, active)}>{trendMetricText(active, option.key)}</dd>
                  </div>
                ))}
              </dl>
              <ul aria-label={t('Provider')}>
                {providerOrder.flatMap((id) => {
                  const usage = active.providers.get(id);
                  if (!usage) return [];
                  return (
                    <li key={id}>
                      <span>
                        <i data-usage-provider={id} aria-hidden="true" />
                        {usageProviderLabel(providerDisplayName(id))}
                        {providerPlanSuffix(id)}
                      </span>
                      <b>{trendMetricText(usage, metric)}</b>
                    </li>
                  );
                })}
              </ul>
            </TrendDetailCard>
          )}
        </div>
      )}
      {!loading && !(peak > 0) && <p className="stats-trend-empty">{trendEmptyText(metric, series)}</p>}
      <footer data-single={axisStart === axisEnd ? 'true' : undefined}>
        <span>{axisStart}</span>
        {axisStart !== axisEnd && <span>{axisEnd}</span>}
      </footer>
      <ul className="stats-trend-legend">
        {providerOrder.map((id) => (
          <li key={id}>
            <i data-usage-provider={id} aria-hidden="true" />
            {usageProviderLabel(providerDisplayName(id))}
            {providerPlanSuffix(id)}
          </li>
        ))}
      </ul>
    </section>
  );
}
