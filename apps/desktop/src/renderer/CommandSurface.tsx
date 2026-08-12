import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { DesktopApi, DesktopCapability } from '../shared/contract';
import type { CommandSurface as CommandSurfaceName } from './slash-commands';
import { t } from './i18n';
import { acquireModalLayer } from './modal-layer';
import { showDesktopToast } from './notifications';
import { ContextBody } from './ContextBody';
import { PaneSurfaceGate } from './PaneSurfaceGate';
import './settings/settings.css';

export { ContextBody } from './ContextBody';

type Row = Record<string, unknown>;
type SurfaceApi = Pick<DesktopApi, 'invokeCapability'> &
  Partial<Pick<DesktopApi, 'getSnapshot' | 'subscribeState'>>;

function record(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}
function pretty(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

// The desktop slash menu keeps only session-scoped commands (user decision),
// so this dialog hosts exactly the READ surfaces that own no page of their
// own. Agents, memory, channels and effort moved to their GUI homes.
const LOADERS: Record<CommandSurfaceName, DesktopCapability[]> = {
  context: ['contextStatus'],
  usage: ['getUsageDashboard'],
  doctor: ['runDoctor'],
};

// The usage dashboard's first service pass probes live provider quotas and
// can take seconds. Keep the last loaded payload for the window's lifetime so
// reopening /usage paints instantly while a silent refresh runs behind it.
const surfaceDataCache = new Map<CommandSurfaceName, Record<string, unknown>>();

export function CommandSurface({ surface, api = window.mixdogDesktop, snapshot, onClose }: {
  surface: CommandSurfaceName;
  api?: SurfaceApi;
  snapshot?: unknown;
  onClose(): void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const surfaceLayer = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const loadSequence = useRef(0);
  const loadingSurface = useRef<CommandSurfaceName | null>(null);
  const cachedSurface = surface === 'usage' ? surfaceDataCache.get(surface) : undefined;
  const [data, setData] = useState<Record<string, unknown>>(() => cachedSurface ?? {});
  const [loading, setLoading] = useState(() => !cachedSurface);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const sessionId = surface === 'context' ? String(record(snapshot).sessionId || '').trim() : '';
  const capabilityRequest = useCallback((capability: DesktopCapability, args: unknown[] = []) => ({
    capability,
    args,
    ...(sessionId ? { sessionId } : {}),
  }), [sessionId]);
  const load = useCallback(async () => {
    if (loadingSurface.current === surface) return;
    const request = ++loadSequence.current;
    loadingSurface.current = surface;
    const cached = surface === 'usage' ? surfaceDataCache.get(surface) : undefined;
    if (cached) setData(cached);
    setLoading(!cached);
    setError('');
    try {
      const capabilities = LOADERS[surface];
      const results = await Promise.all(capabilities.map((capability) => (
        api.invokeCapability(capabilityRequest(capability))
      )));
      if (loadSequence.current === request) {
        const next = {
          ...Object.fromEntries(capabilities.map((capability, index) => [capability, results[index]?.value])),
          ...(surface === 'context' ? { snapshot: results[0]?.snapshot ?? null } : {}),
        };
        if (surface === 'usage') surfaceDataCache.set(surface, next);
        setData(next);
      }
    } catch (reason) {
      if (loadSequence.current === request) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (loadSequence.current === request) setLoading(false);
      if (loadingSurface.current === surface) loadingSurface.current = null;
    }
  }, [api, capabilityRequest, surface]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (error) showDesktopToast(error, 'error');
  }, [error]);
  useEffect(() => {
    if (surface !== 'context' || loading || typeof api.subscribeState !== 'function') return undefined;
    let disposed = false;
    let refreshRunning = false;
    let refreshQueued = false;
    const refreshContextStatus = async () => {
      if (refreshRunning) {
        refreshQueued = true;
        return;
      }
      refreshRunning = true;
      while (!disposed) {
        refreshQueued = false;
        try {
          const result = await api.invokeCapability(capabilityRequest('contextStatus'));
          if (disposed) break;
          // A newer state arrived while this request was in flight. Skip the
          // stale pair and immediately fetch once more for the latest snapshot.
          if (refreshQueued) continue;
          setData((current) => ({
            ...current,
            contextStatus: result.value,
            snapshot: result.snapshot,
          }));
          setError('');
        } catch (reason) {
          if (!disposed && !refreshQueued) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        }
        if (!refreshQueued) break;
      }
      refreshRunning = false;
    };
    const unsubscribe = api.subscribeState(() => {
      void refreshContextStatus();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [api, capabilityRequest, loading, surface]);
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector<HTMLElement>('.app-shell');
    const isolatedElements = Array.from(shell?.children || [])
      .filter((element): element is HTMLElement =>
        element instanceof HTMLElement && !element.matches('.mx-toast-region'));
    const layer = acquireModalLayer(isolatedElements);
    layer.attachSurface(surfaceLayer.current);
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (event.key === 'Escape') {
        // OpenSelect menus are portaled to document.body and own the first Escape.
        if (document.querySelector('.mx-menu[role="listbox"]')) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const openMenu = document.querySelector<HTMLElement>('.mx-menu[role="listbox"]');
      if (openMenu?.contains(document.activeElement)) return;
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), ' +
        'select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || []).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialog.current?.focus();
        return;
      }
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (current <= 0 ? focusable.length - 1 : current - 1)
        : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
      event.preventDefault();
      focusable[next]?.focus();
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      layer.release();
      prior?.focus();
    };
  }, []);
  const run = async (capability: DesktopCapability, args: unknown[] = []) => {
    if (pending) return undefined;
    setPending(capability);
    setError('');
    try {
      const result = await api.invokeCapability(capabilityRequest(capability, args));
      await load();
      return result.value;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally { setPending(''); }
  };
  const title = t(({ context: 'Context', usage: 'Provider usage', doctor: 'Doctor' })[surface]);
  return createPortal(<div ref={surfaceLayer} className="mixdog-settings-layer" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section ref={dialog} className="mixdog-settings command-surface" data-surface={surface}
      role="dialog" aria-modal="true"
      aria-labelledby="command-surface-title" aria-describedby="command-surface-description" tabIndex={-1}
      aria-busy={loading || Boolean(pending)}>
      <div className="mixdog-settings__panel">
        <header className="mixdog-settings__header"><h1 id="command-surface-title">{title}</h1>
          <div className="command-surface-header-actions">
            <button className="mixdog-settings__close" onClick={onClose} aria-label={t('Close {{title}}', { title })}><X size={16} /></button>
          </div>
        </header>
        <div className="mixdog-settings__body">
          <PaneSurfaceGate ready={!loading} label={t('Loading {{title}}…', { title })}>
          <div className="command-surface-content">
          {/* The dialog heading already names the surface, so the old
              "/usage — Read-only …" restatement only pushed the content down
              (user decision). Keep the sentence for screen readers only. */}
          <p id="command-surface-description" className="sr-only">
            {t('{{title}} for the active Mixdog session.', { title })}</p>
          {loading
            ? surface === 'usage'
              ? <UsageSkeleton />
              : <p className="settings-loading" role="status">{t('Loading…')}</p>
            : <SurfaceBody surface={surface} data={data} snapshot={snapshot}
                pending={pending} run={run} />}
          </div>
          </PaneSurfaceGate>
        </div>
      </div>
    </section>
  </div>, document.body);
}

type SurfaceRun = (capability: DesktopCapability, args?: unknown[]) => Promise<unknown>;

function SurfaceBody({ surface, data, snapshot, pending, run }: {
  surface: CommandSurfaceName;
  data: Record<string, unknown>;
  snapshot?: unknown;
  pending: string;
  run: SurfaceRun;
}) {
  const busy = Boolean(pending);
  if (surface === 'context') return <ContextBody status={data.contextStatus} snapshot={snapshot ?? data.snapshot} />;
  if (surface === 'usage') return <UsageBody data={data} />;
  if (surface === 'doctor') {
    return <Group title={t('Diagnostic result')}>
      <pre className="tool-detail">{pretty(data.runDoctor) || t('No data available.')}</pre>
      <button disabled={busy} onClick={() => void run('runDoctor')}>{t('Run diagnostics again')}</button>
    </Group>;
  }
  return null;
}

function usageNumber(value: unknown): number | null {
  const number = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(number) ? null : number;
}
function usageMoney(value: unknown): string {
  const amount = usageNumber(value);
  if (amount === null) return '—';
  if (amount === 0) return '$0';
  if (amount >= 10) return `$${amount.toFixed(0)}`;
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}
function usageCompact(value: unknown): string {
  const amount = usageNumber(value);
  if (amount === null) return '';
  if (Math.abs(amount) >= 1_000_000) return `${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(amount) >= 1_000) return `${(amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1)}K`;
  return amount.toFixed(Math.abs(amount) >= 10 ? 0 : 1);
}
function usageClock(value: unknown): string {
  const at = usageNumber(value);
  if (at === null || at <= 0) return '';
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return '';
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (at - Date.now() < 24 * 60 * 60_000) return time;
  // Beyond a day out, the exact minute is noise that forces chip wrapping —
  // the reset date alone keeps every provider row on one line.
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
// A window with no provider source is a LOCAL estimate, not reported truth:
// it renders in the warning tone and drops its (meaningless) reset clock.
function usageEstimated(window: Row): boolean {
  const source = String(window.source || '').toLowerCase();
  return !source || source.includes('local') || source.includes('config');
}
function usageTone(window: Row): string {
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
function usageWindowValue(window: Row): string {
  const percent = usageNumber(window.usedPct);
  if (percent !== null) return `${Math.round(percent)}%`;
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

function usagePlanType(provider: Row): 'api' | 'subscription' | '' {
  const id = String(provider.id || '').toLowerCase();
  const group = String(provider.group || '').toLowerCase();
  if (id === 'opencode-go' || group === 'oauth') return 'subscription';
  if (group === 'api') return 'api';
  return '';
}

function usageProviderLabel(provider: Row): string {
  const label = String(provider.label || provider.id || 'Provider');
  return label.replace(/\s+(?:API|OAuth)$/i, '');
}

function UsageTableFrame({ children }: React.PropsWithChildren) {
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
function UsageSkeleton() {
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

function UsageBody({ data }: { data: Record<string, unknown> }) {
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

// API-key providers mostly have NO balance endpoint at all (Anthropic and the
// OpenAI platform expose spend only, Gemini nothing), so the row links to the
// console that does show it instead of printing a dead "—" (user decision).
// OpenCode Go is excluded: its console usage already lands in the row.
const BILLING_CONSOLES: Record<string, string> = {
  openai: 'https://platform.openai.com/settings/organization/billing/overview',
  anthropic: 'https://console.anthropic.com/settings/billing',
  xai: 'https://console.x.ai',
  gemini: 'https://aistudio.google.com/usage',
  deepseek: 'https://platform.deepseek.com/usage',
};
function billingUrl(provider: Row): string {
  if (String(provider.group || '') !== 'api') return '';
  return BILLING_CONSOLES[String(provider.id || '').toLowerCase()] || '';
}

function Group({ title, children }: React.PropsWithChildren<{ title: string }>) {
  return <section className="settings-group"><header><h3>{title}</h3></header><div className="settings-group-body">{children}</div></section>;
}
