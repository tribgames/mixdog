/**
 * Subscription usage: what a provider's own quota meter did — each limit
 * window rising, resetting and rising again — and which models moved it.
 * Token usage answers what was SPENT; this answers how the subscription was
 * used up. The layout follows token usage: period, cards, mix, trend and the
 * model table, then the history of the windows.
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import type { DayRange } from './DateRangePicker';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { OpenSelect } from './OpenSelect';
import { modelDisplayName, providerDisplayName, ProviderIcon } from './provider-display';
import { QuotaTrend } from './QuotaTrend';
import {
  quotaClock,
  quotaPace,
  quotaPercent,
  quotaSeries,
  quotaTone,
  quotaValue,
  quotaValueBreakdown,
  quotaValueCaution,
} from './quota-usage-model';
import {
  cachedQuotaAnswer,
  openingQuotaQuestion,
  quotaHistoryQuestion,
  readQuotaAnswer,
  rememberQuotaAnswer,
  type QuotaApi,
} from './quota-usage-cache';
import { record, rows } from './record-utils';
import { usageMoney, usageProviderLabel } from './usage-format';
import { UsagePeriodControls, usagePeriodOptions } from './UsagePeriodControls';
import { formatUsageResetRemaining } from './usage-reset-time';
import { RouteCells, StatCard } from './UsageStatsSurface';
import { subscriptionLabel, subscriptionRank } from './subscription-providers';
import {
  StatsValue,
  localDayKey,
  periodLabel,
  statsCount,
  statsNumber,
  trendPeriodLabel,
  type Row,
  type StatsView,
} from './usage-stats-model';
import { clearQuotaFocus, writeQuotaSubscription } from './usage-surface-mode';
import { subscribeAccountSwitches } from './usage-dashboard-store';

type QuotaView = StatsView | 'window';
type QuotaQuery = {
  provider: string;
  account: string;
  window: string;
  view: QuotaView;
  anchor?: string;
  dates?: DayRange;
};
type CardSpec = { label: string; value: string; note?: string; tone?: string; detail?: string };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ACCOUNT_SEPARATOR = '\u0000';

function quotaArgs(query: QuotaQuery): Row {
  return {
    provider: query.provider,
    account: query.account,
    window: query.window,
    view: query.view,
    ...(query.anchor ? { anchor: query.anchor } : {}),
    ...query.dates,
  };
}

function rangeLabel(fromMs: unknown, toMs: unknown): string {
  return trendPeriodLabel({
    fromMs: statsNumber(fromMs),
    toMs: statsNumber(toMs),
    startDay: '',
    endDay: '',
    label: '',
  });
}

function QuotaMix({
  models,
  outside,
  remaining,
  provider,
  seriesInk,
  loading,
}: {
  models: Row[];
  outside: number;
  remaining: number | null;
  provider: string;
  seriesInk: (model: string) => string;
  loading: boolean;
}) {
  const parts = [
    ...models
      .filter((row) => statsNumber(row.consumed) > 0)
      .map((row) => ({
        key: `model:${String(row.model)}`,
        ink: seriesInk(String(row.model || '')),
        label: modelDisplayName(String(row.model || ''), provider),
        value: statsNumber(row.consumed),
      })),
    ...(outside > 0 ? [{ key: 'outside', ink: 'outside', label: t('Outside Mixdog'), value: outside }] : []),
    ...(remaining !== null ? [{ key: 'remaining', ink: 'remaining', label: t('Remaining'), value: remaining }] : []),
  ];
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  return (
    <section className="stats-mix quota-mix">
      <header>
        <h4>{t('Consumption mix')}</h4>
        <span title={t('Model shares are estimates split by list-price value.')}>{t('Estimated')}</span>
      </header>
      <div className={`stats-mix-bar${loading ? ' usage-skeleton' : ''}`} role="img" aria-label={t('Consumption mix')}>
        {total > 0 ? (
          parts
            .filter((part) => part.value > 0)
            .map((part) => (
              <i key={part.key} data-series={part.ink} style={{ width: `${(part.value / total) * 100}%` }} />
            ))
        ) : (
          <i data-part="empty" style={{ width: '100%' }} />
        )}
      </div>
      <ul>
        {parts.map((part) => (
          <li key={part.key}>
            <i data-series={part.ink} aria-hidden="true" />
            {part.label}
            <b>
              <StatsValue value={quotaPercent(part.value)} loading={loading} />
            </b>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Laid out like token usage: the subscription's own row with its totals,
 *  its models beneath it, each with the share of the limit it used. */
function QuotaTable({
  provider,
  totals,
  summary,
  consumed,
  models,
  outside,
  loading,
}: {
  provider: string;
  totals: Row;
  summary: Row;
  /** Share of the limit used in the period, by Mixdog and from outside it. */
  consumed: number;
  models: Row[];
  outside: number;
  loading: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="usage-table-shell">
      <table
        className="usage-table stats-table quota-table"
        aria-label={t('OAuth usage')}
        inert={loading ? true : undefined}
      >
        <thead>
          <tr>
            <th scope="col">{t('Provider')}</th>
            <th
              scope="col"
              className="stats-share-col"
              title={t('Model shares are estimates split by list-price value.')}
            >
              {t('Share')}
            </th>
            <th scope="col">{t('Requests')}</th>
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
            <th scope="col" className="stats-total-cell">
              {t('Tokens')}
            </th>
            <th scope="col" className="stats-cost-cell" title={t('List-price value')}>
              {t('Est. value')}
            </th>
          </tr>
        </thead>
        {(models.length > 0 || outside > 0) && (
          <tbody className="stats-provider" data-usage-provider={provider} data-open={open ? 'true' : 'false'}>
            <tr className="stats-provider-row">
              <td className="stats-provider-cell">
                <button
                  type="button"
                  className="stats-provider-toggle"
                  aria-expanded={open}
                  onClick={() => setOpen((current) => !current)}
                >
                  <b>{subscriptionLabel(provider) ?? usageProviderLabel(providerDisplayName(provider))}</b>
                  <ChevronDown className="stats-provider-chevron" aria-hidden="true" />
                </button>
                <div className="stats-provider-share" aria-hidden="true">
                  <i className="stats-share">
                    <i style={{ width: `${Math.min(100, consumed)}%` }} />
                  </i>
                </div>
              </td>
              <td className="stats-share-cell">{quotaPercent(consumed)}</td>
              <RouteCells route={totals} costValue={quotaValue(summary)} speed />
            </tr>
            {open &&
              models.map((row) => {
                const name = modelDisplayName(String(row.model || ''), provider);
                return (
                  <tr className="stats-model-row" key={String(row.model)}>
                    <td className="stats-model-cell" title={name}>
                      {name}
                    </td>
                    <td className="stats-share-cell">{quotaPercent(row.consumed)}</td>
                    <RouteCells route={row} speed />
                  </tr>
                );
              })}
            {open && outside > 0 && (
              <tr className="stats-model-row">
                <td className="stats-model-cell">{t('Outside Mixdog')}</td>
                <td className="stats-share-cell">{quotaPercent(outside)}</td>
                <td colSpan={7} />
                <td className="stats-cost-cell" title={quotaValueCaution()}>
                  {summary.outsideCostUsd == null ? '—' : usageMoney(summary.outsideCostUsd)}
                </td>
              </tr>
            )}
          </tbody>
        )}
        {loading && (
          <tbody aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <tr className="usage-skeleton-row" key={index}>
                <td colSpan={10}>
                  <span className="usage-skeleton" style={{ width: '35%' }} />
                </td>
              </tr>
            ))}
          </tbody>
        )}
        {!loading && !models.length && !(outside > 0) && (
          <tbody>
            <tr>
              <td className="usage-empty" colSpan={10}>
                {t('No usage in this period.')}
              </td>
            </tr>
          </tbody>
        )}
      </table>
    </div>
  );
}

function QuotaHistory({
  windows,
  page,
  pageCount,
  turning,
  anchor,
  forecastAt,
  now,
  onOpen,
  onPage,
}: {
  windows: Row[];
  page: number;
  pageCount: number;
  /** The rows are still the page before the one asked for. */
  turning: boolean;
  /** The window the chart shows, when it shows one. */
  anchor: string;
  forecastAt: number;
  now: number;
  onOpen: (key: string) => void;
  onPage: (page: number) => void;
}) {
  if (!windows.length) return null;
  return (
    // Headed by its column labels like the model table above; past one page a
    // pager sits below the rows.
    <section className="usage-table-shell quota-history" aria-busy={turning ? 'true' : undefined}>
      <table className="usage-table stats-table quota-history-table" aria-label={t('Window history')}>
        <thead>
          <tr>
            <th scope="col">{t('Period')}</th>
            <th scope="col">{t('Used')}</th>
            <th scope="col">{t('Maxed out')}</th>
            <th scope="col" title={t('List-price value')}>
              {t('Est. value')}
            </th>
            <th scope="col">{t('Per 1%')}</th>
            <th scope="col">{t('At 100%')}</th>
          </tr>
        </thead>
        <tbody>
          {windows.map((row) => {
            const key = String(row.key);
            const exhaustedAt = statsNumber(row.exhaustedAt);
            const estimated = !exhaustedAt && row.current === true && forecastAt > 0;
            let maxed = '—';
            if (exhaustedAt) maxed = quotaClock(exhaustedAt, now);
            else if (estimated) maxed = quotaClock(forecastAt, now);
            // What the window's requests cost at list price: in all, per
            // percent of the limit, and the whole limit at Mixdog's rate.
            const perPercent = row.costPerPercent == null ? null : statsNumber(row.costPerPercent);
            return (
              <tr key={key} data-active={key === anchor ? 'true' : undefined}>
                <td>
                  <button type="button" className="quota-history-open" onClick={() => onOpen(key)}>
                    {rangeLabel(row.startMs, row.endMs)}
                    {row.current === true && <span className="usage-plan">{t('In progress')}</span>}
                  </button>
                </td>
                <td>{quotaPercent(row.peak)}</td>
                <td>
                  {maxed}
                  {estimated && <span className="quota-history-estimate">{t('Estimated')}</span>}
                </td>
                <td title={`${quotaValueBreakdown(row)}\n${quotaValueCaution()}`}>{quotaValue(row)}</td>
                <td>{perPercent === null ? '—' : usageMoney(perPercent)}</td>
                <td>{quotaValue(row, true)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {pageCount > 1 && (
        <nav className="quota-history-pager" aria-label={t('Window history')}>
          <button
            type="button"
            className="stats-period-arrow"
            aria-label={t('Previous')}
            title={t('Previous')}
            disabled={page <= 0}
            onClick={() => onPage(page - 1)}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <span>{`${page + 1} / ${pageCount}`}</span>
          <button
            type="button"
            className="stats-period-arrow"
            aria-label={t('Next')}
            title={t('Next')}
            disabled={page >= pageCount - 1}
            onClick={() => onPage(page + 1)}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </nav>
      )}
    </section>
  );
}

export function QuotaUsageBody({ api }: { api: QuotaApi }) {
  // A provider meter that opened the dialog picks the subscription; otherwise
  // the one shown last does.
  const [query, setQuery] = useState<QuotaQuery>(() => openingQuotaQuestion());
  useEffect(() => clearQuotaFocus(), []);
  const [data, setData] = useState<Row | null>(() => cachedQuotaAnswer(api, quotaArgs(query)) ?? null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  // Only the newest query may publish: clicking through the chips must not
  // let a slower earlier answer overwrite the current selection. A question
  // answered before paints that answer at once while the new one is read.
  useEffect(() => {
    let current = true;
    const question = quotaArgs(query);
    const known = cachedQuotaAnswer(api, question);
    if (known) setData(known);
    setBusy(true);
    setError('');
    readQuotaAnswer(api, question)
      .then((answer) => {
        if (!current) return;
        setData(answer);
        const shown = record(answer.selection);
        if (shown.provider) {
          const resolved = {
            provider: String(shown.provider),
            account: String(shown.account || ''),
            window: String(shown.label || ''),
          };
          // The next opening asks for what was shown, which may differ from
          // what was asked (a default window, a window this one lacks).
          rememberQuotaAnswer(api, quotaArgs({ ...query, ...resolved }), answer);
          // Openings ask for the account in use without naming it.
          if (!query.account) rememberQuotaAnswer(api, quotaArgs({ ...query, ...resolved, account: '' }), answer);
          writeQuotaSubscription({ provider: resolved.provider, window: resolved.window });
        }
      })
      .catch((reason) => {
        if (current) setError(String(reason?.message || reason));
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [api, query]);

  const loaded: Row = data ?? {};
  const loading = !data;
  const selection = record(loaded.selection);
  const provider = String(selection.provider || query.provider);
  const account = String(selection.account || '');
  const label = String(selection.label || query.window);

  // The shown subscription switching its account in use (an exhausted one
  // replaced automatically, or another picked by hand) moves to the new one.
  useEffect(
    () =>
      subscribeAccountSwitches((switched) => {
        if (switched !== provider) return;
        setQuery((current) => ({
          ...current,
          provider,
          account: '',
          window: label,
          ...(current.view === 'window' ? { anchor: undefined } : {}),
        }));
      }),
    [provider, label]
  );

  // The window history is read on its own, a page at a time, for the
  // subscription and window on show; another one starts at its newest page.
  const shownSelection = Boolean(selection.provider);
  const subject = [provider, account, label].join(ACCOUNT_SEPARATOR);
  const [paging, setPaging] = useState({ subject, page: 0 });
  const historyPage = paging.subject === subject ? paging.page : 0;
  const historyQuestion = useMemo(
    () => (shownSelection ? quotaHistoryQuestion(provider, account, label, historyPage) : null),
    [shownSelection, provider, account, label, historyPage]
  );
  const [historyAnswer, setHistoryAnswer] = useState<Row | null>(null);
  const [historyError, setHistoryError] = useState('');
  useEffect(() => {
    if (!historyQuestion) return undefined;
    let current = true;
    const known = cachedQuotaAnswer(api, historyQuestion);
    if (known) setHistoryAnswer(known);
    setHistoryError('');
    readQuotaAnswer(api, historyQuestion)
      .then((answer) => {
        if (current) setHistoryAnswer(answer);
      })
      .catch((reason) => {
        if (current) setHistoryError(String(reason?.message || reason));
      });
    return () => {
      current = false;
    };
  }, [api, historyQuestion]);
  // Another subscription's rows never stand in while this one's are read.
  const historyOf = record(historyAnswer?.selection);
  const history =
    historyOf.provider === provider && historyOf.account === account && historyOf.label === label
      ? record(historyAnswer)
      : {};
  const historyRows = rows(history.windows);
  const subscriptions = rows(loaded.subscriptions);
  const period = record(loaded.period);
  const view = String(loaded.view || query.view) as QuotaView;
  const windowView = view === 'window';
  const now = statsNumber(loaded.generatedAt) || Date.now();
  const focus = record(loaded.focus);
  const forecast = record(loaded.forecast);
  const summary = record(loaded.summary);
  const models = rows(loaded.models);
  const outside = statsNumber(loaded.outside);
  const firstDay = String(record(loaded.range).firstDay || '');
  const empty = !loading && !subscriptions.length;
  const ranks = new Map(models.map((row, index) => [String(row.model || ''), index]));
  const seriesInk = (model: string) => quotaSeries(ranks.get(model) ?? -1);
  const change = (next: Partial<QuotaQuery>) => {
    // A calendar period survives a change of subscription or window; a
    // limit window is that subscription's own, so it restarts at the latest.
    const keepsAnchor = query.view !== 'window';
    setQuery({ ...query, provider, account, window: label, ...(keepsAnchor ? {} : { anchor: undefined }), ...next });
  };

  // Each subscription once: the one shown first, then the flyout's order and
  // names, so a subscription reads the same in both. One with several
  // accounts picks among them beside it — the one shown, then the order of
  // its account pool.
  const subscriptionOptions = [...new Set(subscriptions.map((row) => String(row.provider || '')))]
    .sort((a, b) => Number(b === provider) - Number(a === provider) || subscriptionRank(a) - subscriptionRank(b))
    .map((id) => ({ value: id, label: subscriptionLabel(id) ?? usageProviderLabel(providerDisplayName(id)) }));
  const rosterRank = (row: Row) => (typeof row.accountRank === 'number' ? row.accountRank : Number.MAX_SAFE_INTEGER);
  const accountOptions = subscriptions
    .filter((row) => row.provider === provider && row.accountInRoster !== false)
    .sort((a, b) => Number(b.account === account) - Number(a.account === account) || rosterRank(a) - rosterRank(b))
    .map((row) => {
      return { value: String(row.account || ''), label: String(row.accountLabel || row.account || '') };
    });
  const windowLabels = subscriptions
    .filter((row) => row.provider === provider && row.account === account)
    .flatMap((row) => (Array.isArray(row.windows) ? row.windows.map(String) : []));

  const used = statsNumber(focus.usedPct);
  const resetAt = statsNumber(focus.resetAt);
  const current = windowView && focus.current === true;
  const pace =
    current && focus.paced === true ? quotaPace(statsNumber(focus.startMs), statsNumber(focus.endMs), now) : null;
  const paceDelta = pace === null ? null : used - pace;
  const runsOutAt = statsNumber(forecast.exhaustAt);
  const tone = current ? quotaTone(used, paceDelta, runsOutAt > 0) : '';
  // A limit window: the whole limit at Mixdog's own rate, outside use excluded.
  const perPercent = summary.costPerPercent == null ? null : statsNumber(summary.costPerPercent);
  const valueCard: CardSpec = {
    label: t('Est. value'),
    value: quotaValue(summary, windowView),
    // A window is valued over its whole limit, which needs Mixdog's rate.
    note: windowView && perPercent === null ? t('Not enough measured usage to estimate.') : '',
    detail: `${quotaValueBreakdown(summary)}\n${quotaValueCaution()}\n${t('OAuth values use list prices. API costs may be estimates; neither is an invoice.')}`,
  };
  const perPercentCard: CardSpec = {
    label: t('Per 1%'),
    value: perPercent === null ? '—' : usageMoney(perPercent),
    note: perPercent === null ? t('Not enough measured usage to estimate.') : '',
    detail: quotaValueCaution(),
  };
  let paceNote = '';
  if (paceDelta !== null && Math.round(paceDelta) > 0) {
    paceNote = t('{{points}} pts ahead of an even pace', { points: Math.round(paceDelta) });
  } else if (paceDelta !== null && Math.round(paceDelta) < 0) {
    paceNote = t('{{points}} pts behind an even pace', { points: Math.round(-paceDelta) });
  }
  // The reset and the forecast run-out already read off the period and the
  // chart; the card says what is left to spend: the rest of the limit spread
  // evenly to the reset — per day while more than a day is left, per hour
  // otherwise, and never more than the rest itself. An ended window shows how
  // fast it went instead, per hour in a window shorter than a day.
  const spanMs = statsNumber(focus.endMs) - statsNumber(focus.startMs);
  const unitFor = (ms: number) => (ms > DAY_MS ? DAY_MS : HOUR_MS);
  const perUnit = (percent: number, unitMs: number) =>
    unitMs === DAY_MS
      ? t('{{percent}} a day', { percent: quotaPercent(percent) })
      : t('{{percent}} an hour', { percent: quotaPercent(percent) });
  const leftMs = resetAt - now;
  let allowanceCard: CardSpec;
  if (!current) {
    const unitMs = unitFor(spanMs);
    allowanceCard = {
      label: t('Average pace'),
      value: spanMs > 0 ? perUnit((statsNumber(focus.peak) * unitMs) / spanMs, unitMs) : '—',
    };
  } else if (used >= 100) {
    allowanceCard = { label: t('Allowance to reset'), value: '—', note: t('Maxed out'), tone: 'danger' };
  } else {
    const unitMs = unitFor(leftMs);
    allowanceCard = {
      label: t('Allowance to reset'),
      value: leftMs > 0 ? perUnit(Math.min(100 - used, ((100 - used) * unitMs) / leftMs), unitMs) : '—',
      note: leftMs > 0 ? t('{{time}} left', { time: formatUsageResetRemaining(leftMs) }) : '',
    };
  }
  const cards: CardSpec[] = windowView
    ? [{ label: t('Used'), value: quotaPercent(used), note: paceNote, tone }, allowanceCard, valueCard, perPercentCard]
    : [
        { label: t('Times maxed out'), value: statsCount(summary.maxedOut) },
        { label: t('Period usage'), value: quotaPercent(summary.consumed) },
        valueCard,
        perPercentCard,
      ];
  const selectors = (
    <div className="quota-selectors">
      {subscriptionOptions.length > 0 && (
        <OpenSelect
          className="quota-subscription"
          ariaLabel={t('OAuth')}
          options={subscriptionOptions}
          value={provider}
          disabled={busy}
          leading={<ProviderIcon provider={provider} />}
          onChange={(value) => {
            // Another subscription opens on its account in use.
            if (value !== provider) change({ provider: value, account: '' });
          }}
        />
      )}
      {accountOptions.length > 1 && (
        <OpenSelect
          className="quota-account"
          ariaLabel={t('Account')}
          options={accountOptions}
          value={account}
          disabled={busy}
          onChange={(value) => {
            if (value !== account) change({ account: value });
          }}
        />
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: tag must stay a div; <fieldset> brings its own border and padding. */}
      <div className="quota-windows" role="group" aria-label={t('Limit window')}>
        {windowLabels.map((option) => (
          <button
            key={option}
            type="button"
            className="quota-window"
            aria-pressed={option === label}
            disabled={busy}
            onClick={() => {
              if (option !== label) change({ window: option });
            }}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div
      className="stats-surface quota-surface"
      aria-busy={busy ? 'true' : undefined}
      data-loading={loading ? 'true' : undefined}
      data-empty={empty ? 'true' : undefined}
    >
      {loading && (
        <p className="sr-only" role="status">
          {t('Loading…')}
        </p>
      )}
      {empty ? (
        <p className="quota-empty">
          <b>{t('No OAuth usage recorded yet.')}</b>
          <span>{t('Mixdog records it from now on whenever it checks provider usage.')}</span>
        </p>
      ) : (
        <>
          <UsagePeriodControls
            leading={selectors}
            views={[{ key: 'window', label: t('Since last reset') }, ...usagePeriodOptions()]}
            view={view}
            period={period}
            periodText={periodLabel(view, period, firstDay)}
            firstDay={firstDay}
            today={localDayKey(now)}
            fallback={{ fromMs: now - DAY_MS, toMs: now }}
            waiting={busy}
            paged={view !== 'hour' && view !== 'year'}
            onLoad={(next, anchor, dates) =>
              setQuery({ provider, account, window: label, view: next as QuotaView, anchor, dates })
            }
          />
          <div className="stats-cards">
            {cards.map((card) => (
              <StatCard key={card.label} {...card} loading={loading} />
            ))}
          </div>
          <QuotaMix
            models={models}
            outside={outside}
            remaining={windowView && !loading ? Math.max(0, 100 - used) : null}
            provider={provider}
            seriesInk={seriesInk}
            loading={loading}
          />
          <QuotaTrend
            data={loaded}
            provider={provider}
            windowView={windowView}
            seriesInk={seriesInk}
            loading={loading}
          />
          {(error || historyError) && <ErrorNotice error={error || historyError} className="stats-error" />}
          <QuotaTable
            provider={provider}
            totals={record(loaded.totals)}
            summary={summary}
            consumed={statsNumber(summary.consumed)}
            models={models}
            outside={outside}
            loading={loading}
          />
          <QuotaHistory
            windows={historyRows}
            page={historyPage}
            pageCount={statsNumber(history.pageCount)}
            turning={historyRows.length > 0 && statsNumber(history.page) !== historyPage}
            anchor={windowView ? String(period.anchor || '') : ''}
            forecastAt={runsOutAt}
            now={now}
            onOpen={(key) => setQuery({ provider, account, window: label, view: 'window', anchor: key })}
            onPage={(page) => setPaging({ subject, page })}
          />
        </>
      )}
    </div>
  );
}
