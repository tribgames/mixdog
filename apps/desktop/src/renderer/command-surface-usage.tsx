import type React from 'react';
import { t, uiFormatLocale } from './i18n';
import { record } from './record-utils';
import {
  usageCompact,
  usageMoney,
  usageNumber,
  usageProviderLabel as stripPlanSuffix,
} from './usage-format';
import { displayUsagePercent } from './usage-percent';

type Row = Record<string, unknown>;

export function usageClock(value: unknown): string {
  const at = usageNumber(value);
  if (at === null || at <= 0) return '';
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return '';
  const time = date.toLocaleTimeString(uiFormatLocale(), { hour: '2-digit', minute: '2-digit' });
  if (at - Date.now() < 24 * 60 * 60_000) return time;
  // Beyond a day out, the exact minute is noise that forces chip wrapping —
  // the reset date alone keeps every provider row on one line.
  return date.toLocaleDateString(uiFormatLocale(), { month: 'short', day: 'numeric' });
}

// A window with no provider source is a LOCAL estimate, not reported truth:
// it renders in the warning tone and drops its (meaningless) reset clock.
export function usageEstimated(window: Row): boolean {
  const source = String(window.source || '').toLowerCase();
  return !source || source.includes('local') || source.includes('config');
}

export function usageTone(window: Row): string {
  if (usageEstimated(window)) return 'estimate';
  const percent = usageNumber(window.usedPct);
  if (percent === null) return 'ok';
  if (percent >= 95) return 'danger';
  if (percent >= 80) return 'warn';
  return 'ok';
}

// Percent first (same order as the TUI panel): quota windows read as "5H 17%"
// so provider rows stay uniform, and dollar/credit remainders only fill in for
// billing-style windows that report no percentage.
export function usageWindowValue(window: Row): string {
  const percent = usageNumber(window.usedPct);
  const displayedPercent = displayUsagePercent(percent);
  if (displayedPercent !== null) return `${displayedPercent}%`;
  const remainingUsd = usageNumber(window.remainingUsd);
  if (remainingUsd !== null) return usageMoney(remainingUsd);
  const usedUsd = usageNumber(window.usedUsd);
  const limitUsd = usageNumber(window.limitUsd);
  if (usedUsd !== null && limitUsd !== null) return `${usageMoney(usedUsd)}/${usageMoney(limitUsd)}`;
  const remainingCredits = usageNumber(window.remainingCredits);
  const limitCredits = usageNumber(window.limitCredits);
  if (remainingCredits !== null && limitCredits !== null) {
    return `${usageCompact(remainingCredits)}/${usageCompact(limitCredits)}`;
  }
  if (remainingCredits !== null) return usageCompact(remainingCredits);
  const usedCredits = usageNumber(window.usedCredits);
  if (usedCredits !== null && limitCredits !== null) {
    return `${usageCompact(usedCredits)}/${usageCompact(limitCredits)}`;
  }
  return '';
}

export function usagePlanType(provider: Row): 'api' | 'subscription' | '' {
  const id = String(provider.id || '').toLowerCase();
  const group = String(provider.group || '').toLowerCase();
  if (id === 'opencode-go' || group === 'oauth') return 'subscription';
  if (group === 'api') return 'api';
  return '';
}

export function usageProviderLabel(provider: Row): string {
  return stripPlanSuffix(String(provider.label || provider.id || 'Provider'));
}

export function UsageTableFrame({ children }: React.PropsWithChildren) {
  return <div className="usage-table-shell">
    <table className="usage-table" aria-label={t('Provider usage')}>
      <colgroup><col className="usage-provider-column" /><col className="usage-plan-column" />
        <col className="usage-values-column" /></colgroup>
      <thead><tr><th scope="col">{t('Provider')}</th><th scope="col">{t('Type')}</th><th scope="col">{t('Usage')}</th></tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>;
}

// Entry skeleton mirrors the loaded table geometry, so the dialog opens at
// its real size instead of collapsing around a bare "Loading…" line.
export function UsageSkeleton() {
  return <>
    <p className="sr-only" role="status">{t('Loading provider usage…')}</p>
    <UsageTableFrame>
      {[104, 88, 64, 112, 72, 96].map((width, index) => (
        <tr className="usage-skeleton-row" key={index} aria-hidden="true">
          <td className="usage-provider-cell">
            <span className="usage-skeleton" style={{ width }} />
            <span className="usage-skeleton" style={{ width: 58 }} />
          </td>
          <td className="usage-plan-cell"><span className="usage-skeleton usage-skeleton-pill" /></td>
          <td><div className="usage-row-values">
            <span className="usage-skeleton usage-skeleton-chip" style={{ width: index % 2 ? 132 : 180 }} />
          </div></td>
        </tr>
      ))}
    </UsageTableFrame>
  </>;
}

// API-key providers mostly have NO balance endpoint at all (Anthropic and the
// OpenAI platform expose spend only, Gemini nothing), so the row links to the
// console that does show it instead of printing a dead "—" (user decision).
// OpenCode Go is excluded: its console usage already lands in the row.
export const BILLING_CONSOLES: Record<string, string> = {
  openai: 'https://platform.openai.com/settings/organization/billing/overview',
  anthropic: 'https://console.anthropic.com/settings/billing',
  xai: 'https://console.x.ai',
  gemini: 'https://aistudio.google.com/usage',
  deepseek: 'https://platform.deepseek.com/usage',
};

export function billingUrl(provider: Row): string {
  if (String(provider.group || '') !== 'api') return '';
  return BILLING_CONSOLES[String(provider.id || '').toLowerCase()] || '';
}

export function UsageBody({ data }: { data: Record<string, unknown> }) {
  const dashboard = record(data.getUsageDashboard);
  const providers = (Array.isArray(dashboard.rows) ? (dashboard.rows as unknown[]).map(record) : [])
    .filter((provider) => usagePlanType(provider) !== '');
  return <UsageTableFrame>
    {providers.map((provider, index) => {
        const windows = Array.isArray(provider.windows) ? (provider.windows as unknown[]).map(record) : [];
        const credit = usageNumber(provider.remainingUsd);
        // A $0 credit chip carries no information — hide it so subscription
        // rows read as their quota windows alone (cleaner, per user request).
        const showCredit = credit !== null && credit > 0;
        const note = String(provider.primary || provider.detail || '');
        const plan = usagePlanType(provider);
        const connected = provider.authenticated === true;
        return <tr key={String(provider.id || provider.label || index)}>
          <td className="usage-provider-cell">
            <b>{usageProviderLabel(provider)}</b>
            <span>{connected ? t('Connected') : String(provider.sourceLabel || provider.status || '')}</span>
          </td>
          <td className="usage-plan-cell"><span className="usage-plan" data-plan={plan}>
            {plan === 'subscription' ? t('Subscription') : 'API'}
          </span></td>
          <td><div className="usage-row-values">
            {windows.map((window, windowIndex) => {
              const reset = usageEstimated(window) ? '' : usageClock(window.resetAt);
              return <span className="usage-chip" key={windowIndex} data-tone={usageTone(window)}>
                <em>{String(window.label || 'USE').toUpperCase()}</em>
                <b>{usageWindowValue(window) || '—'}</b>
                {reset && <i>↻ {reset}</i>}
              </span>;
            })}
            {showCredit && <span className="usage-chip" data-tone="credit">
              <em>CREDIT</em><b>{usageMoney(credit)}</b></span>}
            {!windows.length && !showCredit
              && <span className="usage-row-note">{note || '—'}</span>}
            {billingUrl(provider) && <button className="usage-row-link" type="button"
              onClick={() => void window.mixdogDesktop?.openExternal?.(billingUrl(provider))
                .catch(() => undefined)}>{t('Billing ↗')}</button>}
          </div></td>
        </tr>;
    })}
    {!providers.length && <tr><td className="usage-empty" colSpan={3}>{t('No provider usage available.')}</td></tr>}
  </UsageTableFrame>;
}
