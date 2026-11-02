/**
 * The request log: every model request in a period, newest first, read-only.
 * The ledger keeps all history, so rows arrive a page at a time and the next
 * page is read when the end of the list scrolls into view.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { agentRoleLabel } from './agent-activity-model';
import { readUsageRequestPage } from './command-surface-cache';
import type { QuotaApi } from './quota-usage-cache';
import type { DayRange } from './DateRangePicker';
import { ErrorNotice } from './ErrorNotice';
import { t, uiFormatLocale } from './i18n';
import { customProviderDisplayNames, resolveProviderDisplayName } from './model-catalog';
import { OpenSelect } from './OpenSelect';
import { modelDisplayName } from './provider-display';
import { record, rows } from './record-utils';
import { type SidebarReferenceKey, useSidebarReferences } from './sidebar-reference-cache';
import { usageMoney, usageProviderLabel } from './usage-format';
import {
  localDayKey,
  periodLabel,
  statsNumber,
  statsPlan,
  statsTokens,
  type Row,
  type StatsView,
} from './usage-stats-model';
import { UsagePeriodControls, usagePeriodOptions } from './UsagePeriodControls';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const STATUSES = ['completed', 'substituted', 'retried', 'failed'] as const;
const REFERENCE_KEYS = ['providerSetup'] as const satisfies readonly SidebarReferenceKey[];

type Question = { view: string; anchor?: string; dates?: DayRange; status: string; model: string };

function statusLabel(status: string): string {
  if (status === 'substituted') return t('Substituted');
  if (status === 'retried') return t('Retried');
  if (status === 'failed') return t('Failed');
  if (status === 'completed') return t('Completed');
  return t('All');
}

// The table's columns, once: the header, the column widths (CSS, by `key`) and
// every full-width row's span derive from this list, so a column added or
// removed cannot leave a spanned row one cell off.
const COLUMNS = [
  { key: 'time', label: 'Time' },
  { key: 'session', label: 'Session' },
  { key: 'model', label: 'Model' },
  { key: 'tokens', label: 'Tokens', numeric: true },
  { key: 'cost', label: 'Cost', numeric: true },
  { key: 'duration', label: 'Time taken', numeric: true },
  { key: 'status', label: 'Status' },
] as const;

// What the user would call the work of a background dispatch, by the source
// type its requests carry; any other source type reads as a generic task.
function internalKindLabel(kind: string): string {
  if (kind === 'memory-cycle') return t('Memory cycle');
  if (kind === 'native-web-search') return t('Web search');
  if (kind === 'cache-warm') return t('Cache warm-up');
  if (kind === 'exec') return t('Heartbeat or exec run');
  return t('Background task');
}

function requestTime(ts: number, today: string): string {
  const date = new Date(ts);
  const clock: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  return localDayKey(ts) === today
    ? date.toLocaleTimeString(uiFormatLocale(), clock)
    : date.toLocaleString(uiFormatLocale(), { month: 'numeric', day: 'numeric', ...clock });
}

function requestCost(row: Row): string {
  const plan = statsPlan(String(row.provider || ''), String(row.kind || ''));
  if (plan === 'subscription') return t('Subscription');
  if (plan === 'local') return t('Local');
  return row.costUsd == null ? '—' : usageMoney(row.costUsd);
}

function requestDuration(ms: number): string {
  if (!(ms > 0)) return '—';
  const seconds = ms / 1000;
  return t('{{seconds}}s', {
    seconds: seconds.toLocaleString(uiFormatLocale(), { maximumFractionDigits: seconds < 100 ? 1 : 0 }),
  });
}

function StatusTone({ status }: { status: string }) {
  return <i className="request-log-tone" data-status={status} aria-hidden="true" />;
}

export function UsageRequestLog({ api }: { api: QuotaApi }) {
  const { values: references } = useSidebarReferences(window.mixdogDesktop, REFERENCE_KEYS, true);
  const providerNames = useMemo(() => customProviderDisplayNames(references.providerSetup), [references.providerSetup]);
  const [question, setQuestion] = useState<Question>({ view: 'hour', status: '', model: '' });
  const [answer, setAnswer] = useState<Row | null>(null);
  const [requests, setRequests] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  // Only the newest question may publish its pages.
  const sequence = useRef(0);
  const ask = (current: Question) => ({
    view: current.view,
    ...(current.anchor ? { anchor: current.anchor } : {}),
    ...current.dates,
    ...(current.status ? { status: current.status } : {}),
    ...(current.model ? { model: current.model } : {}),
    limit: PAGE_SIZE,
  });
  // `asOf` pins later pages to the first page's time, so a rolling period
  // does not slide while the list is scrolled.
  const load = (current: Question, after: string | null, asOf?: number) => {
    const ticket = after ? sequence.current : ++sequence.current;
    setBusy(true);
    setError('');
    // A new question drops the old rows and cursor: if its first page fails,
    // nothing can page on with a cursor from another question.
    if (!after) {
      setRequests([]);
      setCursor(null);
    }
    readUsageRequestPage(api, { ...ask(current), ...(after ? { cursor: after, asOf } : {}) })
      .then((page) => {
        if (sequence.current !== ticket) return;
        if (!after) setAnswer(page);
        setRequests((shown) => [...(after ? shown : []), ...rows(page.requests)]);
        setCursor(typeof page.nextCursor === 'string' ? page.nextCursor : null);
      })
      .catch((reason) => {
        if (sequence.current === ticket) setError(String(reason?.message || reason));
      })
      .finally(() => {
        if (sequence.current === ticket) setBusy(false);
      });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new question reads its first page
  useEffect(() => load(question, null), [api, question]);

  // The next page is read once the end of the list comes into view.
  const end = useRef<HTMLTableRowElement>(null);
  const loadMore = useRef(() => {});
  loadMore.current = () => {
    if (!busy && cursor) load(question, cursor, statsNumber(answer?.generatedAt) || undefined);
  };
  useEffect(() => {
    const target = end.current;
    if (!target || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore.current();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [cursor]);

  const loaded = answer ?? {};
  const period = record(loaded.period);
  const now = statsNumber(loaded.generatedAt) || Date.now();
  const today = localDayKey(now);
  const loading = !answer;
  const models = (Array.isArray(loaded.models) ? loaded.models : []).map(String);
  const change = (next: Partial<Question>) => setQuestion((current) => ({ ...current, ...next }));
  const filters = (
    <div className="request-log-filters">
      <OpenSelect
        className="request-log-filter"
        ariaLabel={t('Status')}
        displayValue={`${t('Status')}: ${statusLabel(question.status)}`}
        value={question.status}
        options={[
          { value: '', label: t('All') },
          ...STATUSES.map((status, index) => ({
            value: status,
            label: statusLabel(status),
            separatorBefore: index === 0,
            leading: <StatusTone status={status} />,
          })),
        ]}
        onChange={(status) => change({ status })}
      />
      <OpenSelect
        className="request-log-filter"
        ariaLabel={t('Model')}
        displayValue={`${t('Model')}: ${question.model || t('All')}`}
        value={question.model}
        options={[
          { value: '', label: t('All') },
          ...models.map((model, index) => ({ value: model, label: model, separatorBefore: index === 0 })),
        ]}
        onChange={(model) => change({ model })}
      />
    </div>
  );
  return (
    <div className="stats-surface request-log" aria-busy={busy ? 'true' : undefined}>
      <UsagePeriodControls
        views={usagePeriodOptions()}
        view={String(period.view || question.view)}
        period={period}
        periodText={periodLabel(question.view as StatsView, period, '')}
        firstDay=""
        today={today}
        fallback={{ fromMs: now - DAY_MS, toMs: now }}
        waiting={busy && !requests.length}
        paged={false}
        trailing={filters}
        onLoad={(view, anchor, dates) => change({ view, anchor, dates })}
      />
      {error && <ErrorNotice error={error} className="stats-error" />}
      <div className="usage-table-shell">
        <table className="usage-table request-log-table" aria-label={t('Request log')}>
          <colgroup>
            {COLUMNS.map((column) => (
              <col key={column.key} className={`request-log-col-${column.key}`} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th key={column.key} scope="col" className={'numeric' in column ? 'request-log-num' : undefined}>
                  {t(column.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {requests.map((row) => {
              const provider = String(row.provider || '');
              const model = String(row.model || '');
              const status = String(row.status || 'completed');
              // A substituted request names what was asked for beside what answered.
              const requested = status === 'substituted' ? String(row.requestedModel || '') : '';
              const modelTitle = requested && requested !== model ? `${requested} → ${model}` : model;
              const internal = String(row.internalKind || '');
              const title = internal
                ? internalKindLabel(internal)
                : String(row.sessionTitle || '') || t('Untitled session');
              const role = row.agent === true ? agentRoleLabel(row.agentRole) : '';
              // A background run on a session the user can open: named like the role.
              const background = row.backgroundKind ? internalKindLabel(String(row.backgroundKind)) : '';
              const suffix = [role, background].filter(Boolean).join(' · ');
              const internalHint = t(
                'Internal session: a background run Mixdog started itself. You cannot open it as a conversation.'
              );
              return (
                <tr key={String(row.id)}>
                  <td className="request-log-time">{requestTime(statsNumber(row.ts), today)}</td>
                  <td
                    className="request-log-session"
                    title={internal ? `${title} — ${internalHint}` : suffix ? `${title} · ${suffix}` : title}
                  >
                    {/* Before the name, so the ellipsis never cuts it off. */}
                    {internal && <em className="request-log-internal">{t('Internal')}</em>}
                    {title}
                    {suffix && <span> · {suffix}</span>}
                  </td>
                  <td className="request-log-model" title={modelTitle}>
                    <b>{modelDisplayName(model, provider)}</b>
                    <small>{usageProviderLabel(resolveProviderDisplayName(provider, providerNames))}</small>
                  </td>
                  <td className="request-log-num">{statsTokens(row.tokens)}</td>
                  <td className="request-log-num">{requestCost(row)}</td>
                  <td className="request-log-num">{requestDuration(statsNumber(row.durationMs))}</td>
                  <td className="request-log-status" data-status={status}>
                    {statusLabel(status)}
                  </td>
                </tr>
              );
            })}
            {!loading && !requests.length && (
              <tr>
                <td className="usage-empty" colSpan={COLUMNS.length}>
                  {t('No requests recorded in this period.')}
                </td>
              </tr>
            )}
            {cursor && (
              <tr ref={end} className="request-log-more" aria-hidden="true">
                <td colSpan={COLUMNS.length} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
