// The 48px global activity rail is a stable landmark
// on every surface (chat and code alike). It contains only destinations that
// swap the adjacent panel; creation actions live in the Sessions panel header.
// Usage and Settings live at the rail foot.
import { ChevronDown, ChevronUp } from 'lucide-react';
import type React from 'react';
import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { DesktopUpdaterState } from '../shared/contract';
import {
  RAIL_UPDATE_SLOT_HEIGHT,
  RailUpdateSlot,
  type RailUpdateSettingsTarget,
  useRailUpdate,
} from './RailUpdateSlot';
import { DESKTOP_SIDEBAR_DEFAULT_WIDTH } from '../shared/window-layout';
import { desktopFeatureEnabled } from './desktop-feature-config';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { ProviderIcon } from './provider-display';
import { InitialSurface } from './InitialSurface';
import { loadedSidebarUsageModule, loadSidebarUsageModule, useUsageRailPin } from './use-usage-rail-pin';
import {
  getUsageDashboardSnapshot,
  holdUsageDashboardCadence,
  refreshUsageDashboard,
  subscribeUsageDashboard,
  type UsageApi,
} from './usage-dashboard-store';
import { displayUsagePercent, usageToneClass } from './usage-percent';
import { ActivityRailNavigation } from './activity-rail-navigation';
import { RemotePcSwitcher } from './RemotePcSwitcher';
import { usePlainBrowserChrome } from './titlebar';
import type { WorkbenchSideViewDescriptor, WorkbenchSideViewId } from './workbench-side-view-layout';

// The flyout body loads in the post-boot warm-up lane, on hover/focus intent,
// or on the open itself — not with the rail; its data is already warm in the
// shared usage store. A loaded module renders directly: React.lazy suspended
// every first mount even when the chunk was cached, and React's fallback
// throttle then held an empty popup for 300ms+.
/** One mouse-wheel notch in pixel units. */
const WHEEL_NOTCH_PIXELS = 100;

const prefetchSidebarUsage = () => void loadSidebarUsageModule().catch(() => undefined);

function usagePinGlyph(rows: ReturnType<typeof useUsageRailPin>['usagePinRows'], loading: boolean) {
  if (rows.length) {
    return (
      <span className="rail-usage-pin-stack">
        {rows.map((entry) => {
          const percent = displayUsagePercent(entry.percent) ?? 0;
          // Glanceable readout: icon, then the flyout's meter grammar in
          // miniature, then the number — the bars
          // are the final window (plus the shortest one in short + long mode)
          // and the number is the higher of the drawn bars.
          const tone = usageToneClass(entry.percent);
          return (
            <span
              className={`rail-usage-pin-brand${tone}`}
              key={entry.key}
              data-usage-pin={entry.key}
              aria-busy={entry.pending || undefined}
              data-tooltip={entry.tooltip}
            >
              {entry.accountIndex === undefined ? (
                <ProviderIcon provider={entry.provider} />
              ) : (
                <span className="rail-usage-pin-mark">
                  <ProviderIcon provider={entry.provider} />
                  <sup className={entry.accountSelected ? 'is-selected' : undefined}>{entry.accountIndex}</sup>
                </span>
              )}
              {entry.bars.map((bar, index) => (
                <i key={bar.label} className={entry.bars.length > 1 && index !== entry.hot ? 'is-cool' : undefined}>
                  <i style={{ width: `${displayUsagePercent(bar.percent) ?? 0}%` }} />
                </i>
              ))}
              <small>
                <span className="rail-usage-pin-value">{entry.pending ? '–' : `${percent}%`}</span>
              </small>
            </span>
          );
        })}
      </span>
    );
  }
  if (loading) return <InitialSurface variant="icon" />;
  return <span className="codicon codicon-pie-chart" aria-hidden="true" />;
}

// Memoised: the rail sits beside every App commit (a session switch is four)
// and changes only with its destinations, the shown one and Settings.
export const ActivityRail = memo(function ActivityRail({
  settingsOpen,
  onOpenSettings,
  desktopUpdaterState,
  onInstallDesktopUpdate,
  onOpenProviders,
  onOpenUsageStats,
  onPrefetchSettings,
  usageApi,
  navigationItems,
  activeNavigationId,
  onSelectNavigation,
}: {
  /** The settings surface is open, so the rail-foot button reads selected. */
  settingsOpen: boolean;
  /** A section opens Settings on it (the update slot's "see progress"). */
  onOpenSettings(section?: RailUpdateSettingsTarget): void;
  /** The desktop app's own updater, for the slot above Usage. */
  desktopUpdaterState?: DesktopUpdaterState;
  onInstallDesktopUpdate?(): void;
  onOpenProviders?(): void;
  /** Opens the token-usage statistics dialog from the usage flyout header. */
  onOpenUsageStats?(): void;
  onPrefetchSettings?(): void;
  /** Overridable only for tests; the rail warms usage through the host API. */
  usageApi?: UsageApi;
  navigationItems: readonly WorkbenchSideViewDescriptor[];
  activeNavigationId: WorkbenchSideViewId | null;
  onSelectNavigation(id: WorkbenchSideViewId): void;
}) {
  // Subscription usage moved off the session panel (user decision): the rail
  // hosts an account toggle and the panel stays a pure session
  // list. Only the dashboard MARKUP is flyout-scoped; its data lives in the
  // shared store below so the first open never starts from nothing.
  const [usageOpen, setUsageOpen] = useState(false);
  const plainBrowserChrome = usePlainBrowserChrome();
  // ABB: the usage flyout closes on hardware back.
  useMobileBack(usageOpen, () => setUsageOpen(false));
  const usageSnapshot = useSyncExternalStore(subscribeUsageDashboard, getUsageDashboardSnapshot);
  const railRef = useRef<HTMLElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const settingsRef = useRef<HTMLButtonElement | null>(null);
  const railUpdate = useRailUpdate(desktopUpdaterState, onInstallDesktopUpdate, onOpenSettings);
  const {
    usagePinned,
    toggleUsagePin,
    railBars,
    setRailBars,
    accountsExpanded,
    setAccountsExpanded,
    railSlots,
    setRailSlots,
    usagePinRows,
    usagePinScroll,
    loading: usagePinLoading,
  } = useUsageRailPin(
    usageSnapshot,
    { rail: railRef, nav: navRef, settings: settingsRef },
    desktopFeatureEnabled('usage'),
    railUpdate ? RAIL_UPDATE_SLOT_HEIGHT : 0,
    usageApi ?? window.mixdogDesktop
  );
  // The wheel moves the stack one slot per discrete notch; a smooth (trackpad)
  // stream of small pixel deltas accumulates to a notch before it steps.
  // Horizontal or zero vertical deltas never step.
  const wheelPixels = useRef(0);
  const stepOnWheel = (event: React.WheelEvent) => {
    if (!usagePinScroll.hasPrev && !usagePinScroll.hasNext) return;
    if (event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const direction = event.deltaY > 0 ? 1 : -1;
    // Line and page deltas are always whole notches.
    if (event.deltaMode !== 0) {
      usagePinScroll.step(direction);
      return;
    }
    if (Math.sign(wheelPixels.current) !== direction) wheelPixels.current = 0;
    wheelPixels.current += event.deltaY;
    if (Math.abs(wheelPixels.current) < WHEEL_NOTCH_PIXELS) return;
    wheelPixels.current = 0;
    usagePinScroll.step(direction);
  };
  // A step control leaves when its end is reached; focus held on it moves to
  // the opposite control (which that very step just made available) so
  // keyboard stepping does not drop to the page.
  const focusedStep = useRef<1 | -1 | null>(null);
  const stepFromControl = (direction: 1 | -1, event: React.MouseEvent<HTMLButtonElement>) => {
    focusedStep.current = document.activeElement === event.currentTarget ? direction : null;
    usagePinScroll.step(direction);
  };
  useLayoutEffect(() => {
    const direction = focusedStep.current;
    if (direction === null) return;
    focusedStep.current = null;
    const rail = railRef.current;
    if (rail?.querySelector(`[data-rail-step="${direction}"]`)) return;
    rail?.querySelector<HTMLButtonElement>(`[data-rail-step="${-direction}"]`)?.focus();
  });
  // Anchor the flyout's bottom edge to the Usage button itself, measured at
  // open time (static offsets drifted a few px from the real rail layout).
  const [usageAnchorBottom, setUsageAnchorBottom] = useState(48);
  const preparedUsageAnchor = useRef<number | null>(null);
  const usageClickGuard = useImmediateOverlayClickGuard();
  const rememberUsageAnchor = (element: HTMLButtonElement) => {
    const bounds = element.getBoundingClientRect();
    preparedUsageAnchor.current = Math.max(
      8,
      Math.round((window.visualViewport?.height ?? window.innerHeight) - bounds.bottom)
    );
  };
  const [fetchedUsageModule, setFetchedUsageModule] = useState(loadedSidebarUsageModule);
  const usageModule = fetchedUsageModule ?? loadedSidebarUsageModule();
  useEffect(() => {
    if (!usageOpen || usageModule) return undefined;
    let live = true;
    loadSidebarUsageModule().then(
      (module) => {
        if (live) setFetchedUsageModule(module);
      },
      // A failed chunk keeps the placeholder; the next open retries the load.
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [usageOpen, usageModule]);
  const SidebarUsage = usageModule?.SidebarUsage;
  const toggleUsage = (element: HTMLButtonElement) => {
    if (!usageOpen && preparedUsageAnchor.current === null) rememberUsageAnchor(element);
    commitImmediateOverlay(() => {
      if (!usageOpen && preparedUsageAnchor.current !== null) {
        setUsageAnchorBottom(preparedUsageAnchor.current);
      }
      setUsageOpen((open) => !open);
    });
  };
  // The rail is always mounted, so restore the synchronous cache seed and start
  // one deduped refresh immediately. This lets pinned usage paint on first entry
  // instead of waiting for the post-boot idle queue.
  useEffect(() => {
    if (!desktopFeatureEnabled('usage')) return undefined;
    const api = usageApi ?? window.mixdogDesktop;
    const release = holdUsageDashboardCadence(api);
    void refreshUsageDashboard(api);
    return () => {
      release();
    };
  }, [usageApi]);
  useEffect(() => {
    if (!usageOpen) {
      preparedUsageAnchor.current = null;
      return undefined;
    }
    const dismiss = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest(
          '.rail-usage-popup, .sidebar-usage-toggle, [data-provider-account-overlay], [data-usage-menu-overlay]'
        )
      )
        return;
      setUsageOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setUsageOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown);
    };
  }, [usageOpen]);
  const openUsageStats = onOpenUsageStats
    ? () => {
        setUsageOpen(false);
        onOpenUsageStats();
      }
    : undefined;
  return (
    <aside className="activity-rail" aria-label={t('Activity Bar')} ref={railRef}>
      {/* A plain browser tab has no title band: the PC switcher heads the rail. */}
      {plainBrowserChrome && <RemotePcSwitcher placement="rail" />}
      <nav className="sidebar-primary-nav" aria-label={t('Sidebar')} ref={navRef}>
        <ActivityRailNavigation entries={navigationItems} activeId={activeNavigationId} onSelect={onSelectNavigation} />
      </nav>
      <div className="activity-rail-spacer" />
      {desktopFeatureEnabled('usage') && usagePinScroll.hasPrev && (
        <div className="rail-usage-pin-step-row">
          <button
            type="button"
            className="rail-usage-pin-step"
            aria-label={t('Show earlier slots')}
            data-rail-step="-1"
            onClick={(event) => stepFromControl(-1, event)}
          >
            <ChevronUp size={8} strokeWidth={3} aria-hidden="true" />
          </button>
        </div>
      )}
      {desktopFeatureEnabled('usage') && (
        <button
          type="button"
          onWheel={stepOnWheel}
          className={`sidebar-usage-toggle ${usageOpen ? 'is-active' : ''}${usagePinRows.length ? ' is-pinned' : ''}`}
          aria-label={t('Usage')}
          aria-expanded={usageOpen}
          aria-haspopup="dialog"
          data-tooltip={t('Usage')}
          onPointerEnter={(event) => {
            prefetchSidebarUsage();
            rememberUsageAnchor(event.currentTarget);
          }}
          onFocus={(event) => {
            prefetchSidebarUsage();
            rememberUsageAnchor(event.currentTarget);
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            usageClickGuard.markPointerActivation();
            toggleUsage(event.currentTarget);
          }}
          onClick={(event) => {
            if (usageClickGuard.consumePointerClick()) return;
            if (event.detail !== 0) return;
            toggleUsage(event.currentTarget);
          }}
          onPointerCancel={usageClickGuard.clearPointerActivation}
        >
          {/* Pie-slice glyph: the classic usage/quota mark — gauge, columns and
            gantt bars all read clipped or generic at 20px (user feedback).
            Pinned, the same button becomes the brand stack. */}
          {usagePinGlyph(usagePinRows, usagePinLoading)}
        </button>
      )}
      {desktopFeatureEnabled('usage') && usagePinScroll.hasNext && (
        <div className="rail-usage-pin-step-row">
          <button
            type="button"
            className="rail-usage-pin-step"
            aria-label={t('Show more slots')}
            data-rail-step="1"
            onClick={(event) => stepFromControl(1, event)}
          >
            <ChevronDown size={8} strokeWidth={3} aria-hidden="true" />
          </button>
        </div>
      )}
      {/* Directly above Settings, under the Usage block (user: 설정 버튼 위). */}
      <RailUpdateSlot update={railUpdate} />
      {desktopFeatureEnabled('settings') && (
        <button
          type="button"
          ref={settingsRef}
          className={`sidebar-settings-button ${settingsOpen ? 'selected' : ''}`}
          aria-label={t('Open settings')}
          aria-current={settingsOpen ? 'page' : undefined}
          data-tooltip={t('Settings')}
          onPointerEnter={onPrefetchSettings}
          onFocus={onPrefetchSettings}
          onPointerDown={(event) => {
            if (event.button === 0) onPrefetchSettings?.();
          }}
          onClick={() => onOpenSettings()}
        >
          <span className="codicon codicon-settings-gear" aria-hidden="true" />
        </button>
      )}
      {/* The flyout's bottom edge tracks the Usage button itself (user). */}
      {desktopFeatureEnabled('usage') && usageOpen && (
        <div
          className="rail-usage-popup"
          role="dialog"
          aria-label={t('OAuth usage')}
          style={
            {
              '--rail-usage-popup-bottom': `${usageAnchorBottom}px`,
              width: DESKTOP_SIDEBAR_DEFAULT_WIDTH + 88,
              maxWidth: 'calc(100vw - 116px)',
            } as React.CSSProperties
          }
          data-state="open"
        >
          {/* The popup shares the rail's host API so its open-time revalidation
            hits the same store entry the rail already prewarmed. */}
          {SidebarUsage ? (
            <SidebarUsage
              sidebarOpen
              api={usageApi}
              onAddProviders={() => {
                setUsageOpen(false);
                (onOpenProviders || onOpenSettings)();
              }}
              onOpenStats={openUsageStats}
              pinned={usagePinned}
              onTogglePin={toggleUsagePin}
              railBars={railBars}
              onRailBarsChange={setRailBars}
              accountsExpanded={accountsExpanded}
              onAccountsExpandedChange={setAccountsExpanded}
              railSlots={railSlots}
              onRailSlotsChange={setRailSlots}
            />
          ) : (
            <InitialSurface />
          )}
        </div>
      )}
    </aside>
  );
});
