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
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Info } from 'lucide-react';
import type { DesktopCapability } from '../shared/contract';
import { t, uiFormatLocale } from './i18n';
import { modelDisplayName, providerDisplayName, ProviderIcon } from './provider-display';
import { record } from './record-utils';
import { usageCompact, usageMoney, usageNumber, usageProviderLabel } from './usage-format';

type Row = Record<string, unknown>;
type StatsRequest = (capability: DesktopCapability, args?: unknown[]) => Promise<unknown>;
type SortKey = 'tokens' | 'costUsd' | 'turns' | 'sessions';

type Grain = 'hour' | 'day' | 'week' | 'month';
type StatsView = Grain | 'all';
type Metric = 'tokens' | 'costUsd' | 'turns';

function statsNumber(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function statsTokens(value: unknown): string {
  return usageCompact(value) || '—';
}

function statsCount(value: unknown): string {
  const count = usageNumber(value);
  return count === null ? '—' : count.toLocaleString(uiFormatLocale());
}

// A count some turns could not join is a floor, not an unknown: the seen
// sessions are still shown and the "+" says more may exist. Only a floor of
// zero has nothing to show.
function statsSessions(route: Row): { text: string; title?: string } {
  const count = usageNumber(route.sessions);
  if (count === null) return { text: '—' };
  const formatted = count.toLocaleString(uiFormatLocale());
  if (route.sessionsComplete !== false) return { text: formatted };
  return {
    text: count > 0 ? `${formatted}+` : '—',
    title: t('Some usage carries no session id; the count is a lower bound.'),
  };
}

function statsPercent(value: unknown): string {
  return `${Math.round(statsNumber(value) * 100)}%`;
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

function StatCard({ label, value, detail }: {
  label: string;
  value: string;
  detail?: string;
}) {
  return <div className="stats-card">
    <small title={detail}>{label}</small>
    <b title={detail}>{value}</b>
  </div>;
}

function TokenMix({ totals }: { totals: Row }) {
  // Cache stays OUT of the bar. It runs two orders of magnitude above the rest
  // on a long session, so including it painted one flat grey block and buried
  // the only split worth reading here: how much was sent versus generated.
  const parts = [
    { key: 'input', label: t('Input'), value: statsNumber(totals.input) },
    { key: 'output', label: t('Output'), value: statsNumber(totals.output) },
  ];
  const cache = statsNumber(totals.cacheRead);
  const cacheWrite = statsNumber(totals.cacheWrite);
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  return <section className="stats-mix">
    <header>
      <h4>{t('Token mix')}</h4>
      {cache > 0 && <span>{t('Cache hit rate')} {statsPercent(totals.cacheHitRate)}</span>}
    </header>
    <div className="stats-mix-bar" role="img" aria-label={t('Token mix')}>
      {total > 0
        ? parts.filter((part) => part.value > 0).map((part) => <i key={part.key}
          data-part={part.key} style={{ width: `${(part.value / total) * 100}%` }} />)
        : <i data-part="empty" style={{ width: '100%' }} />}
    </div>
    <ul>
      {parts.map((part) => <li key={part.key}>
        <i data-part={part.key} aria-hidden="true" />{part.label}<b>{statsTokens(part.value)}</b>
      </li>)}
      <li title={`${t('Cache writes')}: ${statsTokens(cacheWrite)}`}>
        <i data-part="cache" aria-hidden="true" />{t('Cache hits')}<b>{statsTokens(cache)}</b>
      </li>
    </ul>
  </section>;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Monday of the week a `YYYY-MM-DD` day belongs to. */
function weekBucketKey(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return day;
  // getDay() counts Sunday as 0; the week is read as Monday-first.
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

type TrendBucket = {
  key: string;
  label: string;
  future: boolean;
  tokens: number;
  costUsd: number;
  turns: number;
  providers: Map<string, number>;
};

function groupTrend(daily: Row[], grain: Grain, metric: Metric): TrendBucket[] {
  const buckets = new Map<string, TrendBucket>();
  for (const entry of daily) {
    const day = String(grain === 'hour' ? entry.key || '' : entry.day || '');
    if (!day) continue;
    const key = grain === 'month' ? day.slice(0, 7) : grain === 'week' ? weekBucketKey(day) : day;
    const bucket = buckets.get(key)
      || { key, label: grain === 'hour'
        ? entry.unknown ? t('Unknown time') : String(entry.label || key) : key,
      future: true, tokens: 0, costUsd: 0, turns: 0, providers: new Map<string, number>() };
    bucket.future = bucket.future && entry.future === true;
    bucket.tokens += statsNumber(entry.tokens);
    bucket.costUsd += statsNumber(entry.costUsd);
    bucket.turns += statsNumber(entry.turns);
    for (const raw of (Array.isArray(entry.providers) ? entry.providers as unknown[] : [])) {
      const slice = record(raw);
      const id = String(slice.provider || '');
      if (!id) continue;
      bucket.providers.set(id, (bucket.providers.get(id) || 0) + statsNumber(slice[metric]));
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function metricValue(bucket: TrendBucket, metric: Metric): number {
  return metric === 'costUsd' ? bucket.costUsd : metric === 'turns' ? bucket.turns : bucket.tokens;
}

function metricText(value: number, metric: Metric): string {
  return metric === 'costUsd' ? usageMoney(value) : metric === 'turns' ? statsCount(value) : statsTokens(value);
}

/** Provider identity, not rank or metric, owns the colour of every band. */
function TrendBar({ bucket, metric, peak, order }: {
  bucket: TrendBucket;
  metric: Metric;
  peak: number;
  order: string[];
}) {
  const total = metricValue(bucket, metric);
  const height = peak > 0 ? Math.max(total > 0 ? 3 : 1, (total / peak) * 100) : 1;
  const parts = order
    .map((id) => ({ id, value: bucket.providers.get(id) || 0 }))
    .filter((part) => part.value > 0);
  const summed = parts.reduce((sum, part) => sum + part.value, 0);
  const title = bucket.future ? bucket.label : `${bucket.label} · ${metricText(total, metric)}`;
  return <i style={{ height: `${height}%` }} title={title} data-empty={total > 0 ? undefined : 'true'}
    data-future={bucket.future ? 'true' : undefined}>
    {/* A bar with no split to draw stays a plain block rather than an empty
        outline: an unattributed day must not read as a different colour. */}
    {summed > 0 && parts.map((part) => <b key={part.id}
      data-usage-provider={part.id}
      style={{ height: `${(part.value / summed) * 100}%` }} />)}
  </i>;
}

function UsageTrend({ daily, hourly, view, providerOrder }: {
  daily: Row[]; hourly: Row[]; view: StatsView; providerOrder: string[];
}) {
  const [metric, setMetric] = useState<Metric>('tokens');
  const grain = view === 'all' ? 'month' : view;
  const series = groupTrend(view === 'hour' ? hourly : daily, grain, metric);
  const peak = series.reduce((max, entry) => Math.max(max, metricValue(entry, metric)), 0);
  // Tokens and cost diverge by several times: a provider can be a small share
  // of the traffic and most of the spend. The chart draws whichever question
  // is being asked rather than implying one answers the other.
  const metrics: ReadonlyArray<{ key: Metric; label: string }> = [
    { key: 'tokens', label: t('Tokens') },
    { key: 'costUsd', label: t('Cost') },
    { key: 'turns', label: t('Usage records') },
  ];
  return <section className="stats-trend">
    <header>
      <h4>{t('Trend')}</h4>
      <div className="stats-ranges stats-grains" role="group" aria-label={t('Metric')}>
        {metrics.map((option) => <button key={option.key} type="button"
          className={`stats-range ${option.key === metric ? 'is-active' : ''}`}
          aria-pressed={option.key === metric}
          onClick={() => setMetric(option.key)}>{option.label}</button>)}
      </div>
      {peak > 0 && <span>{t('Peak')} {metricText(peak, metric)}</span>}
    </header>
    {/* A period with nothing in it says so. A row of hairlines under
        "Peak 0" read as a chart that failed to draw. */}
    {peak > 0
      ? <div className="stats-trend-bars" data-single={series.length === 1 ? 'true' : undefined}>
        {series.map((entry) => <TrendBar key={entry.key}
          bucket={entry} metric={metric} peak={peak} order={providerOrder} />)}
      </div>
      : <p className="stats-trend-empty">{t('No usage in this period.')}</p>}
    <footer data-single={series.length === 1 ? 'true' : undefined}>
      <span>{series.length ? series[0].label : ''}</span>
      {series.length > 1 && <span>{series[series.length - 1].label}</span>}
    </footer>
    <ul className="stats-trend-legend">
      {providerOrder.map((id) => <li key={id}>
        <i data-usage-provider={id} aria-hidden="true" />
        {usageProviderLabel(providerDisplayName(id))}
      </li>)}
    </ul>
  </section>;
}

function RouteCells({ route }: { route: Row }) {
  const sessions = statsSessions(route);
  return <>
    <td title={sessions.title}>{sessions.text}</td>
    <td>{statsCount(route.turns)}</td>
    <td className="stats-breakdown">{statsTokens(route.input)}</td>
    <td className="stats-breakdown">{statsTokens(route.output)}</td>
    <td className="stats-breakdown" title={`${t('Cache writes')}: ${statsTokens(route.cacheWrite)}`}>
      {statsTokens(route.cacheRead)}
    </td>
    <td className="stats-optional">{statsPercent(route.cacheHitRate)}</td>
    <td className="stats-total-cell">{statsTokens(route.tokens)}</td>
    <td className="stats-cost-cell" title={statsNumber(route.costCoverage) < 1 && statsNumber(route.turns) > 0
      ? t('Some usage has no known price; the displayed cost is incomplete.') : undefined}>{usageMoney(
      statsNumber(route.costCoverage) === 0 && statsNumber(route.turns) > 0 ? null : route.costUsd
    )}</td>
  </>;
}

function SortHeader({ label, column, sort, onSort, className }: {
  label: string;
  column: SortKey;
  sort: SortKey;
  onSort: (next: SortKey) => void;
  className?: string;
}) {
  const active = sort === column;
  return <th scope="col" className={className} aria-sort={active ? 'descending' : 'none'}>
    <button type="button" className="stats-sort" data-active={active ? 'true' : 'false'}
      onClick={() => onSort(column)}>{label}</button>
  </th>;
}

function periodLabel(view: StatsView, period: Row): string {
  if (view === 'all') return t('All');
  if (!period.startDay) return view === 'hour' ? t('Today') : '—';
  const start = new Date(`${String(period.startDay)}T00:00:00`);
  if (view === 'hour') return `${t('Today')} · ${new Intl.DateTimeFormat(uiFormatLocale(), {
    month: 'short', day: 'numeric',
  }).format(start)}`;
  const format = new Intl.DateTimeFormat(uiFormatLocale(), view === 'month'
    ? { year: 'numeric' } : { year: 'numeric', month: 'long' });
  return view === 'week'
    ? format.formatRange(start, new Date(`${String(period.endDay)}T00:00:00`))
    : format.format(start);
}

export function UsageStatsBody({ data, request }: {
  data: Record<string, unknown>;
  request: StatsRequest;
}) {
  const loaded = useMemo(() => record(data.getUsageStats), [data.getUsageStats]);
  const [stats, setStats] = useState<Record<string, unknown>>(loaded);
  const [view, setView] = useState<StatsView>('hour');
  const [sort, setSort] = useState<SortKey>('tokens');
  // Models start visible, including providers arriving with a new period.
  // Only explicit collapses are retained.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleExpanded = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Only the newest request may publish: clicking through the chips must not
  // let a slower earlier answer overwrite the current selection.
  const sequence = useRef(0);
  useEffect(() => {
    if (view === 'hour') setStats(loaded);
  }, [loaded]);

  const reload = (nextView: StatsView, anchor?: string) => {
    const ticket = ++sequence.current;
    setBusy(true);
    setError('');
    void request('getUsageStats', [{ view: nextView, ...(anchor ? { anchor } : {}) }])
      .then((value) => {
        if (sequence.current === ticket) {
          setStats(record(value));
          setView(nextView);
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
  const period = record(stats.period);
  const coverage = record(stats.coverage);
  const daily = (Array.isArray(stats.daily) ? stats.daily as unknown[] : []).map(record);
  const hourly = (Array.isArray(stats.hourly) ? stats.hourly as unknown[] : []).map(record);
  const providerRows = (Array.isArray(stats.providers) ? stats.providers as unknown[] : []).map(record);
  const providers = [...providerRows].sort((a, b) => statsNumber(b[sort]) - statsNumber(a[sort]));
  // Traffic determines band order. Provider identity owns its fixed colour.
  const providerOrder = [...providerRows]
    .sort((a, b) => statsNumber(b.tokens) - statsNumber(a.tokens))
    .map((row) => String(row.provider || ''));
  const subscriptionRows = providers.filter((row) =>
    statsPlan(String(row.provider || ''), String(row.providerKind || '')) === 'subscription');
  const apiRows = providers.filter((row) =>
    statsPlan(String(row.provider || ''), String(row.providerKind || '')) === 'api');
  const subscriptionCost = subscriptionRows.reduce((sum, row) => sum + statsNumber(row.costUsd), 0);
  const apiCost = apiRows.reduce((sum, row) => sum + statsNumber(row.costUsd), 0);
  const moneyFor = (rows: Row[], amount: number) => rows.length > 0 && rows.every((row) => statsNumber(row.costCoverage) === 0)
    ? usageMoney(null) : usageMoney(amount);
  const tokens = statsNumber(totals.tokens);
  const turns = statsNumber(totals.turns);
  const historyDays = statsNumber(coverage.historyDays);
  const partialDays = statsNumber(coverage.partialDays);
  const usageInfo = [
    t('Subscription values use list prices. API costs may be estimates; neither is an invoice.'),
    `${t('Tokens')}: ${t('Cache excluded')}`,
    historyDays > 0 ? t('Some historical days use estimated token counts, dates and costs.')
      : partialDays > 0 ? t('Historical records may be incomplete; only surviving usage is counted.') : '',
    statsNumber(totals.costCoverage) < 1 && turns > 0
      ? t('Some usage has no known price; the displayed cost is incomplete.') : '',
    totals.sessionsComplete === false && turns > 0
      ? t('Some usage carries no session id; the count is a lower bound.') : '',
  ].filter(Boolean).join('\n');
  const sessionsCard = statsSessions(totals);
  const waiting = busy;
  const views: ReadonlyArray<{ key: StatsView; label: string }> = [
    { key: 'hour', label: t('By hour') },
    { key: 'day', label: t('By day') },
    { key: 'week', label: t('By week') },
    { key: 'month', label: t('By month') },
    { key: 'all', label: t('All') },
  ];
  return <div className="stats-surface" aria-busy={waiting ? 'true' : undefined}>
    <div className="stats-controls">
      <div className="stats-ranges" role="group" aria-label={t('Period')}>
        {views.map((option) => <button key={option.key} type="button"
          className={`stats-range ${option.key === view ? 'is-active' : ''}`}
          aria-pressed={option.key === view} disabled={waiting}
          onClick={() => { if (option.key !== view) reload(option.key); }}>{option.label}</button>)}
      </div>
      <div className="stats-period">
        {view !== 'hour' && view !== 'all' && <button type="button" className="stats-period-arrow"
          aria-label={t('Previous period')} title={t('Previous period')}
          disabled={waiting || !period.previousAnchor}
          onClick={() => reload(view, String(period.previousAnchor))}><ChevronLeft aria-hidden="true" /></button>}
        <span className="stats-period-label">{periodLabel(view, period)}</span>
        {view !== 'hour' && view !== 'all' && <button type="button" className="stats-period-arrow"
          aria-label={t('Next period')} title={t('Next period')}
          disabled={waiting || !period.nextAnchor}
          onClick={() => reload(view, String(period.nextAnchor))}><ChevronRight aria-hidden="true" /></button>}
        {view !== 'hour' && view !== 'all' && period.isCurrent === false && <button type="button"
          className="stats-range stats-current" disabled={waiting}
          onClick={() => reload(view)}>{t('Current period')}</button>}
      </div>
      <span className="stats-help" role="img" tabIndex={0} aria-label={usageInfo} title={usageInfo}>
        <Info aria-hidden="true" />
      </span>
    </div>
    <div className="stats-cards">
      <StatCard label={t('Subscription list-price value')} value={moneyFor(subscriptionRows, subscriptionCost)}
        detail={t('Subscription values use list prices. API costs may be estimates; neither is an invoice.')} />
      <StatCard label={t('API usage cost')} value={moneyFor(apiRows, apiCost)}
        detail={t('Subscription values use list prices. API costs may be estimates; neither is an invoice.')} />
      <StatCard label={t('Tokens')} value={statsTokens(tokens)}
        detail={t('Cache excluded')} />
      <StatCard label={t('Usage records')} value={statsCount(turns)} />
      <StatCard label={t('Sessions')} value={sessionsCard.text} detail={sessionsCard.title} />
    </div>
    <TokenMix totals={totals} />
    {/* The legend and every bar band read from one order, so a provider keeps
        its colour no matter which metric or grain is showing. */}
    <UsageTrend daily={daily} hourly={hourly} view={view} providerOrder={providerOrder} />
    {error && <p className="stats-error" role="alert">{error}</p>}
    <div className="usage-table-shell">
      <table className="usage-table stats-table" aria-label={t('Token usage')}>
        <thead><tr>
          <th scope="col">{t('Provider')}</th>
          <SortHeader label={t('Sessions')} column="sessions" sort={sort} onSort={setSort} />
          <SortHeader label={t('Usage records')} column="turns" sort={sort} onSort={setSort} />
          <th scope="col" className="stats-breakdown">{t('Input')}</th>
          <th scope="col" className="stats-breakdown">{t('Output')}</th>
          <th scope="col" className="stats-breakdown">{t('Cache hits')}</th>
          <th scope="col" className="stats-optional">{t('Hit rate')}</th>
          <SortHeader label={t('Tokens')} column="tokens" sort={sort} onSort={setSort}
            className="stats-total-cell" />
          <SortHeader label={t('Cost')} column="costUsd" sort={sort} onSort={setSort}
            className="stats-cost-cell" />
        </tr></thead>
        {providers.map((provider) => {
          const id = String(provider.provider || '');
          const models = (Array.isArray(provider.models) ? provider.models as unknown[] : []).map(record);
          const open = !collapsed.has(id);
          const plan = statsPlan(id, String(provider.providerKind || ''));
          const share = Math.round(statsNumber(provider.share) * 100);
          return <tbody key={id} className="stats-provider" data-usage-provider={id} data-open={open ? 'true' : 'false'}>
            <tr>
              <td className="stats-provider-cell">
                <button type="button" className="stats-provider-toggle"
                  aria-expanded={open} disabled={!models.length}
                  onClick={() => toggleExpanded(id)}>
                  <ChevronDown className="stats-provider-chevron" aria-hidden="true" />
                  <ProviderIcon provider={id} />
                  <b>{usageProviderLabel(providerDisplayName(id))}</b>
                  {plan && <span className="usage-plan" data-plan={plan}>
                    {plan === 'subscription' ? t('Subscription') : plan === 'local' ? t('Local') : 'API'}
                  </span>}
                  <small>{share}%</small>
                </button>
                <i className="stats-share"><i style={{ width: `${share}%` }} /></i>
              </td>
              <RouteCells route={provider} />
            </tr>
            {open && models.map((model) => {
              const name = String(model.model || '');
              return <tr className="stats-model-row" key={name}>
                <td className="stats-model-cell" title={modelDisplayName(name, id)}>{modelDisplayName(name, id)}</td>
                <RouteCells route={model} />
              </tr>;
            })}
          </tbody>;
        })}
        {!providers.length && <tbody><tr>
          <td className="usage-empty" colSpan={9}>{t('No usage recorded yet.')}</td>
        </tr></tbody>}
      </table>
    </div>
  </div>;
}
