import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { DesktopModelSelection } from '../shared/contract';
import type { CommandSurface as CommandSurfaceName, SettingsSection } from './slash-commands';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { trappedTabIndex } from './list-navigation';
import { acquireModalLayer } from './modal-layer';
import { useErrorToast } from './notifications';
import { PaneSurfaceGate } from './PaneSurfaceGate';
import type { SurfaceApi } from './command-surface-cache';
import { useCommandSurfaceLifecycle } from './command-surface-lifecycle';
import { SurfaceBody } from './command-surface-body';
import { commandSurfaceDisplaySnapshot } from './command-surface-state';
import { ContextReading } from './ContextBody';
import { UsageSkeleton } from './command-surface-usage';
import { UsageModeTabs } from './UsageSurface';
import { useUsageSurfaceMode } from './usage-surface-mode';
import './settings/settings.css';

export function commandSurfaceTitle(surface: CommandSurfaceName): string {
  switch (surface) {
    case 'context':
      return t('Context');
    case 'usage':
      return t('Provider usage');
    case 'doctor':
      return t('Doctor');
    case 'inherit':
      return t('Inherit session');
    case 'stats':
      return t('Usage');
  }
}

export function CommandSurface({
  surface,
  open = true,
  api = window.mixdogDesktop,
  snapshot,
  sessionId: explicitSessionId = '',
  onInherit,
  onOpenSettings,
  onClose,
}: {
  surface: CommandSurfaceName;
  open?: boolean;
  api?: SurfaceApi;
  snapshot?: unknown;
  sessionId?: string;
  /** /inherit only: hand the source session to the host and open the heir. */
  onInherit?: (sourceSessionId: string, route: DesktopModelSelection, options?: { compact: boolean }) => Promise<void>;
  /** /doctor only: open the settings page that fixes a failing check. */
  onOpenSettings?: (section: SettingsSection) => void;
  onClose(): void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const surfaceLayer = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // The usage dialog's two questions are its tabs; the dialog keeps its name.
  const [usageMode, setUsageMode] = useUsageSurfaceMode(surface === 'stats' && open);
  const { data, loading, refreshing, pending, error, sessionId, run, requestCapability } = useCommandSurfaceLifecycle({
    surface,
    open,
    api,
    snapshot,
    sessionId: explicitSessionId,
    // Subscription usage reads its own history; token statistics wait for
    // their tab instead of queueing ahead of it on the ledger worker.
    deferLoad: surface === 'stats' && usageMode === 'quota',
  });

  useErrorToast(open && surface !== 'stats' ? error : '', `command:${surface}`);

  useEffect(() => {
    if (!open) return undefined;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector<HTMLElement>('.app-shell');
    const isolatedElements = Array.from(shell?.children || []).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && !element.matches('.mx-toast-region')
    );
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
      const focusable = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), ' +
            'select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) || []
      ).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialog.current?.focus();
        return;
      }
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = trappedTabIndex(current, focusable.length, event.shiftKey);
      event.preventDefault();
      focusable[next]?.focus();
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      layer.release();
      prior?.focus();
    };
  }, [open]);

  const title = commandSurfaceTitle(surface);
  if (surface === 'stats' && !open) return null;

  // These surfaces read their headline from the snapshot they already hold, so
  // they paint complete at once and fill in the measured detail when it lands
  // (user: 컨텍스트창 왜 바로 안 열리고 로딩이 심하지).
  const paintsFromSnapshot = surface === 'context' || surface === 'inherit' || surface === 'stats';
  const showStatsErrorOnly = surface === 'stats' && Boolean(error) && !data.getUsageStats;
  const showLoadingPlaceholder = loading && !paintsFromSnapshot;

  return createPortal(
    <div
      ref={surfaceLayer}
      className="mixdog-settings-layer stable-surface-preserved"
      data-surface-active={open ? 'true' : 'false'}
      inert={open ? undefined : true}
      aria-hidden={open ? undefined : true}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className="mixdog-settings command-surface"
        data-surface={surface}
        role="dialog"
        aria-modal={open ? 'true' : 'false'}
        aria-labelledby="command-surface-title"
        aria-describedby="command-surface-description"
        tabIndex={-1}
        aria-busy={loading || refreshing || Boolean(pending)}
      >
        <div className="mixdog-settings__panel">
          <header className="mixdog-settings__header">
            <h1 id="command-surface-title" className={surface === 'stats' ? 'sr-only' : undefined}>
              {title}
            </h1>
            {surface === 'stats' && <UsageModeTabs mode={usageMode} onChange={setUsageMode} />}
            <div className="command-surface-header-actions">
              {surface === 'context' && (
                <ContextReading status={data.contextStatus} snapshot={commandSurfaceDisplaySnapshot(data, snapshot)} />
              )}
              {surface === 'stats' && refreshing && !loading && (
                <span className="stats-refresh-status" role="status">
                  {t('Refreshing…')}
                </span>
              )}
              <button
                type="button"
                className="mixdog-settings__close"
                onClick={onClose}
                aria-label={t('Close {{title}}', { title })}
              >
                <X size={16} />
              </button>
            </div>
          </header>
          <div className="mixdog-settings__body">
            {/* /inherit only waits on the context percentage before unlocking
              the decision, and /context opens on the gauge reading it was
              clicked from — neither belongs behind a loading cover. */}
            <PaneSurfaceGate ready={!loading || paintsFromSnapshot} label={t('Loading {{title}}…', { title })}>
              <div className="command-surface-content">
                {/* The dialog heading already names the surface, so the old
              "/usage — Read-only …" restatement only pushed the content down
              (user decision). Keep the sentence for screen readers only. */}
                <p id="command-surface-description" className="sr-only">
                  {t('{{title}} for the active Mixdog session.', { title })}
                </p>
                {surface === 'stats' && error && <ErrorNotice error={error} className="stats-error" />}
                {!showStatsErrorOnly && showLoadingPlaceholder && surface === 'usage' && <UsageSkeleton />}
                {!showStatsErrorOnly && showLoadingPlaceholder && surface !== 'usage' && (
                  <p className="settings-loading" role="status">
                    {t('Loading…')}
                  </p>
                )}
                {!showStatsErrorOnly && !showLoadingPlaceholder && (
                  <SurfaceBody
                    surface={surface}
                    data={data}
                    snapshot={snapshot}
                    sessionId={sessionId}
                    onInherit={onInherit}
                    onOpenSettings={onOpenSettings}
                    onClose={onClose}
                    loading={loading}
                    pending={pending}
                    run={run}
                    request={requestCapability}
                    api={api}
                    usageMode={usageMode}
                  />
                )}
              </div>
            </PaneSurfaceGate>
          </div>
        </div>
      </section>
    </div>,
    document.body
  );
}
