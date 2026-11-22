import { ChevronDown, ChevronUp } from 'lucide-react';
import type React from 'react';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

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

/** One mouse-wheel notch in pixel units. */
const WHEEL_NOTCH_PIXELS = 100;

const prefetchSidebarUsage = () => void loadSidebarUsageModule().catch(() => undefined);

type UsagePinRow = ReturnType<typeof useUsageRailPin>['usagePinRows'][number];

/** Capsule tops in the 23x7 meter under the mark: one 3px capsule, or two a
 *  pixel apart with the short window on top. */
const METER_LENGTH = 23;
const METER_HEIGHT = 7;
const CAPSULE_HEIGHT = 3;
const SINGLE_BAR = [0];
const STACKED_BARS = [0, 4];

/** The slot's meter: a faint capsule per drawn window, its toned fill clipped
 *  to the capsule; while loading, a dashed line in its place. */
function UsagePinMeter({ entry }: { entry: UsagePinRow }) {
  const clipId = useId();
  const tops = entry.bars.length > 1 ? STACKED_BARS : SINGLE_BAR;
  return (
    <svg
      className="rail-usage-pin-meter"
      viewBox={`0 0 ${METER_LENGTH} ${METER_HEIGHT}`}
      aria-hidden="true"
      focusable="false"
    >
      {entry.bars.map((bar, index) => {
        const y = tops[index];
        if (entry.pending) {
          const centre = y + CAPSULE_HEIGHT / 2;
          return (
            <g key={bar.label} data-usage-window={bar.label}>
              <line
                className="rail-usage-pin-track"
                x1="0"
                y1={centre}
                x2={METER_LENGTH}
                y2={centre}
                strokeWidth={CAPSULE_HEIGHT}
              />
            </g>
          );
        }
        const percent = displayUsagePercent(bar.percent) ?? 0;
        const capsule = { x: 0, y, width: METER_LENGTH, height: CAPSULE_HEIGHT, rx: CAPSULE_HEIGHT / 2 };
        const clip = `${clipId}-${index}`;
        return (
          <g key={bar.label} data-usage-window={bar.label}>
            <clipPath id={clip}>
              <rect {...capsule} />
            </clipPath>
            <rect className="rail-usage-pin-track" {...capsule} />
            {percent > 0 && (
              <rect
                className={`rail-usage-pin-fill${usageToneClass(bar.percent)}`}
                clipPath={`url(#${clip})`}
                x="0"
                y={y}
                width={(METER_LENGTH * percent) / 100}
                height={CAPSULE_HEIGHT}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function usagePinGlyph(rows: readonly UsagePinRow[], loading: boolean) {
  if (rows.length) {
    return (
      <span className="rail-usage-pin-stack">
        {rows.map((entry) => (
          // No figure: the bar and its tone carry the reading; the exact
          // values live in the tooltip, the button's description and the flyout.
          <span
            className="rail-usage-pin-brand"
            key={entry.key}
            data-usage-pin={entry.key}
            aria-busy={entry.pending || undefined}
            data-tooltip={entry.tooltip}
          >
            <span className="rail-usage-pin-mark">
              <ProviderIcon provider={entry.provider} />
              {entry.accountIndex !== undefined && (
                <sup className={entry.accountSelected ? 'is-selected' : undefined}>{entry.accountIndex}</sup>
              )}
            </span>
            <UsagePinMeter entry={entry} />
          </span>
        ))}
      </span>
    );
  }
  if (loading) return <InitialSurface variant="icon" />;
  return <span className="codicon codicon-pie-chart" aria-hidden="true" />;
}

/** The Usage button's accessible description: every drawn slot in order, as
 *  provider (and account), every window its tooltip names with its usage, and
 *  "Loading…" while its quota is pending. */
function usagePinDescription(rows: readonly UsagePinRow[]): string | undefined {
  if (!rows.length) return undefined;
  return rows.map((entry) => (entry.pending ? `${entry.name} · ${t('Loading…')}` : entry.name)).join('; ');
}

/** The usage button's slot stack steps by wheel notch or by its step buttons. */
function useUsageSlotStepping(
  usagePinScroll: ReturnType<typeof useUsageRailPin>['usagePinScroll'],
  railRef: { current: HTMLElement | null }
) {
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
  return { stepOnWheel, stepFromControl };
}

function useSidebarUsageComponent(open: boolean) {
  const [fetched, setFetched] = useState(loadedSidebarUsageModule);
  const usageModule = fetched ?? loadedSidebarUsageModule();
  useEffect(() => {
    if (!open || usageModule) return undefined;
    let live = true;
    loadSidebarUsageModule().then(
      (module) => {
        if (live) setFetched(module);
      },
      // A failed chunk keeps the placeholder; the next open retries the load.
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [open, usageModule]);
  return usageModule?.SidebarUsage;
}

function useDismissOnOutsidePress(open: boolean, dismiss: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest(
          '.rail-usage-popup, .sidebar-usage-toggle, [data-provider-account-overlay], [data-usage-menu-overlay]'
        )
      )
        return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, dismiss]);
}

function useUsageFlyout() {
  const [usageOpen, setUsageOpen] = useState(false);
  // ABB: the usage flyout closes on hardware back.
  useMobileBack(usageOpen, () => setUsageOpen(false));
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
  const SidebarUsage = useSidebarUsageComponent(usageOpen);
  const closeUsage = useCallback(() => setUsageOpen(false), []);
  useDismissOnOutsidePress(usageOpen, closeUsage);
  useEffect(() => {
    if (!usageOpen) preparedUsageAnchor.current = null;
  }, [usageOpen]);
  const toggleUsage = (element: HTMLButtonElement) => {
    if (!usageOpen && preparedUsageAnchor.current === null) rememberUsageAnchor(element);
    commitImmediateOverlay(() => {
      if (!usageOpen && preparedUsageAnchor.current !== null) {
        setUsageAnchorBottom(preparedUsageAnchor.current);
      }
      setUsageOpen((open) => !open);
    });
  };
  return {
    usageOpen,
    setUsageOpen,
    usageAnchorBottom,
    usageClickGuard,
    rememberUsageAnchor,
    toggleUsage,
    SidebarUsage,
  };
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
  /** Overridable only for tests; the rail warms usage through the host API. */
  usageApi?: UsageApi;
  navigationItems: readonly WorkbenchSideViewDescriptor[];
  activeNavigationId: WorkbenchSideViewId | null;
  onSelectNavigation(id: WorkbenchSideViewId): void;
}) {
  const {
    usageOpen,
    setUsageOpen,
    usageAnchorBottom,
    usageClickGuard,
    rememberUsageAnchor,
    toggleUsage,
    SidebarUsage,
  } = useUsageFlyout();
  const plainBrowserChrome = usePlainBrowserChrome();
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
  const { stepOnWheel, stepFromControl } = useUsageSlotStepping(usagePinScroll, railRef);
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
            <ChevronUp size={8} strokeWidth={4.5} aria-hidden="true" />
          </button>
        </div>
      )}
      {desktopFeatureEnabled('usage') && (
        <button
          type="button"
          onWheel={stepOnWheel}
          className={`sidebar-usage-toggle ${usageOpen ? 'is-active' : ''}${usagePinRows.length ? ' is-pinned' : ''}`}
          aria-label={t('Usage')}
          aria-description={usagePinDescription(usagePinRows)}
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
            <ChevronDown size={8} strokeWidth={4.5} aria-hidden="true" />
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
