/**
 * The usage dialog (ℹ️ in the usage flyout) answers three questions: what was
 * SPENT (token usage), how a subscription's quota was used up (subscription
 * usage) and what each request did (request log). They are the dialog's own
 * tabs, in its header, above every control a body carries.
 */
import { useLayoutEffect, useRef } from 'react';
import { t } from './i18n';
import { QuotaUsageBody } from './QuotaUsageBody';
import type { QuotaApi } from './quota-usage-cache';
import { Tabs } from './ui/primitives';
import { UsageRequestLog } from './UsageRequestLog';
import { UsageStatsBody } from './UsageStatsSurface';
import type { StatsRequest } from './usage-stats-model';
import type { UsageSurfaceMode } from './usage-surface-mode';

export function UsageModeTabs({
  mode,
  onChange,
  requests = true,
}: {
  mode: UsageSurfaceMode;
  onChange(mode: UsageSurfaceMode): void;
  /** The host serves the request log (usageRequestsSupported). */
  requests?: boolean;
}) {
  // A row too narrow for every tab scrolls (a phone): the chosen one, restored
  // on opening or just picked, is brought into view.
  const list = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new choice moves the active tab
  useLayoutEffect(() => {
    list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [mode]);
  return (
    <Tabs
      listRef={list}
      className="command-surface-tabs"
      tabClassName="command-surface-tab"
      value={mode}
      onChange={onChange}
      items={[
        { id: 'tokens', label: t('Token usage') },
        { id: 'quota', label: t('OAuth usage') },
        ...(requests ? [{ id: 'requests' as const, label: t('Request log') }] : []),
      ]}
    />
  );
}

export function UsageSurfaceBody({
  data,
  request,
  api,
  loading = false,
  mode,
}: {
  data: Record<string, unknown>;
  request: StatsRequest;
  /** The host subscription usage reads through; its answers are kept per host. */
  api: QuotaApi;
  loading?: boolean;
  mode: UsageSurfaceMode;
}) {
  if (mode === 'requests') return <UsageRequestLog api={api} />;
  return mode === 'quota' ? (
    <QuotaUsageBody api={api} />
  ) : (
    <UsageStatsBody data={data} request={request} loading={loading} />
  );
}
