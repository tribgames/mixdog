// Usage trend chart: grouped bars over the selected period.
import { useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';
import { X } from 'lucide-react';
import { t, uiFormatLocale } from './i18n';
import { providerDisplayName } from './provider-display';
import { usageProviderLabel } from './usage-format';
import { useHoverPopover } from './hover-popover';
import { acquireModalLayer } from './modal-layer';
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
    // A capture listener on window sees EVERY scroller in the document, and a
    // transcript pinned to its end scrolls on each streamed token — a session
    // running BEHIND the popup kept closing this card while the pointer still
    // sat on the bar (user: 바 위에 호버를 했는데 왜 팝업이 자동으로 사라지냐).
    // Only a scroller that CARRIES the chart moves the anchor the card is
    // placed against, so nothing else may dismiss it; the card scrolls inside
    // the host and is excluded by the same containment test.
    const dismissOnScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && !target.contains(host)) return;
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
      {loading && <div className="stats-trend-bars stats-trend-skeleton usage-skeleton" aria-hidden="true" />}
      {!loading && peak > 0 && (
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
            </div>
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
