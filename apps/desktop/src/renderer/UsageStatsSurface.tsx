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

import { useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { modelDisplayName, providerDisplayName } from './provider-display';
import { record, rows } from './record-utils';
import { usageNumber, usageProviderLabel } from './usage-format';
import {
  StatsValue,
  localDayKey,
  periodLabel,
  promptDetail,
  promptTokens,
  statsCount,
  statsMoney,
  statsNumber,
  statsPercent,
  statsPlan,
  statsPlanLabel,
  statsSpeed,
  statsTokens,
  unpricedTurns,
} from './usage-stats-model';
import type { Row, SortKey, StatsRequest, StatsView } from './usage-stats-model';
import { UsagePeriodControls, usagePeriodOptions } from './UsagePeriodControls';
import { UsageTrend } from './UsageTrend';

export { resolveUsageTrendGrouping } from './usage-stats-model';

export function StatCard({
  label,
  value,
  detail,
  note,
  tone,
  loading,
}: {
  label: string;
  value: string;
  detail?: string;
  /** A second line under the figure: what it means right now. */
  note?: string;
  tone?: string;
  loading?: boolean;
}) {
  return (
    <div className="stats-card" data-tone={tone || undefined}>
      <small title={detail}>{label}</small>
      <b title={detail}>
        <StatsValue value={value} loading={loading} />
      </b>
      {note && !loading && <em title={note}>{note}</em>}
    </div>
  );
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

export function RouteCells({ route, costValue, speed }: { route: Row; costValue?: string; speed?: boolean }) {
  const incomplete = statsNumber(route.unmeasuredTurns) > 0;
  const priceMissing = unpricedTurns(route);
  const priceUnavailable = priceMissing > 0 && priceMissing >= statsNumber(route.turns);
  let priceTitle: string | undefined;
  if (priceUnavailable) priceTitle = t('Price unavailable');
  else if (priceMissing > 0) priceTitle = t('Partial cost');
  return (
    <>
      <td>{statsCount(route.turns)}</td>
      {speed && <td className="stats-optional">{statsSpeed(route.outputTokensPerSecond)}</td>}
      <td className="stats-breakdown" title={promptDetail(route, incomplete)}>
        {statsTokens(promptTokens(route), incomplete)}
      </td>
      <td className="stats-breakdown">{statsTokens(route.output)}</td>
      <td className="stats-breakdown">{statsTokens(route.cacheRead, incomplete)}</td>
      <td className="stats-optional">{statsPercent(route.cacheHitRate)}</td>
      <td className="stats-total-cell">{statsTokens(route.tokens, incomplete)}</td>
      <td className="stats-cost-cell" data-price={priceUnavailable ? 'unavailable' : undefined} title={priceTitle}>
        {costValue ?? statsMoney(route)}
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
  const daily = rows(stats.daily);
  const hourly = rows(stats.hourly);
  const providerRows = rows(stats.providers);
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
  const moneyFor = (group: Row[]) =>
    statsMoney({
      costUsd: group.reduce((sum, row) => sum + statsNumber(row.costUsd), 0),
      turns: group.reduce((sum, row) => sum + statsNumber(row.turns), 0),
      costUnpricedTurns: group.reduce((sum, row) => sum + unpricedTurns(row), 0),
    });
  const tokens = statsNumber(totals.tokens);
  const turns = statsNumber(totals.turns);
  const historyDays = statsNumber(coverage.historyDays);
  const partialDays = statsNumber(coverage.partialDays);
  const incomplete = statsNumber(totals.unmeasuredTurns) > 0;
  let historyNote = '';
  if (historyDays > 0) historyNote = t('Some historical days use estimated token counts, dates and costs.');
  else if (partialDays > 0) historyNote = t('Historical records may be incomplete; only surviving usage is counted.');
  const tokenInfo = [t('Input, output and cache hits combined.'), historyNote].filter(Boolean).join('\n');
  const waiting = busy || loading;
  // The server's clock, not this renderer's: a served period already knows
  // where "now" is, and tests pin it.
  const today = localDayKey(statsNumber(stats.generatedAt) || Date.now());
  const firstDay = String(record(stats.range).firstDay || '');
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
      <UsagePeriodControls
        views={usagePeriodOptions()}
        view={view}
        period={period}
        periodText={periodLabel(view, period, firstDay)}
        firstDay={firstDay}
        today={today}
        fallback={initialPeriod}
        waiting={waiting}
        paged={view !== 'hour' && view !== 'year'}
        onLoad={(next, anchor, dates) => reload(next as StatsView, anchor, dates)}
      />
      <div className="stats-cards">
        <StatCard
          label={t('Est. value')}
          value={moneyFor(subscriptionRows)}
          detail={t('OAuth values use list prices. API costs may be estimates; neither is an invoice.')}
          loading={loading}
        />
        <StatCard
          label={t('API cost')}
          value={moneyFor(apiRows)}
          detail={t('OAuth values use list prices. API costs may be estimates; neither is an invoice.')}
          loading={loading}
        />
        <StatCard label={t('Tokens')} value={statsTokens(tokens, incomplete)} detail={tokenInfo} loading={loading} />
        <StatCard label={t('Requests')} value={statsCount(turns)} loading={loading} />
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
      {error && <ErrorNotice error={error} className="stats-error" />}
      <div className="usage-table-shell">
        <table className="usage-table stats-table" aria-label={t('Token usage')} inert={loading ? true : undefined}>
          <thead>
            <tr>
              <th scope="col">{t('Provider')}</th>
              <th scope="col" className="stats-share-col">
                {t('Share')}
              </th>
              <SortHeader label={t('Requests')} column="turns" sort={sort} onSort={setSort} />
              <th scope="col" className="stats-optional" title={t('Speed')}>
                tok/s
              </th>
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
            const models = rows(provider.models);
            const open = !collapsed.has(id);
            const plan = statsPlan(id, String(provider.providerKind || ''));
            // Share is suppressed per row, not for the whole table: the model
            // already returns null only for a provider whose own turns went
            // unmeasured. Reading the table-wide flag here blanked every share
            // as soon as a single unmeasured route (Cursor) was present.
            const shareValue = usageNumber(provider.share);
            const share = shareValue === null ? null : Math.round(shareValue * 100);
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
                      <b>{usageProviderLabel(providerDisplayName(id))}</b>
                      <ChevronDown className="stats-provider-chevron" aria-hidden="true" />
                      {plan && (
                        <span className="usage-plan" data-plan={plan}>
                          {statsPlanLabel(plan)}
                        </span>
                      )}
                    </button>
                    <div className="stats-provider-share" aria-hidden="true">
                      <i className="stats-share">
                        <i style={{ width: `${share ?? 0}%` }} />
                      </i>
                    </div>
                  </td>
                  <td className="stats-share-cell">{share === null ? '—' : `${share}%`}</td>
                  <RouteCells route={provider} speed />
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
                        <RouteCells route={model} speed />
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
                  <td colSpan={10}>
                    <span className="usage-skeleton" style={{ width: '35%' }} />
                  </td>
                </tr>
              ))}
            </tbody>
          )}
          {!loading && !providers.length && (
            <tbody>
              <tr>
                <td className="usage-empty" colSpan={10}>
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
