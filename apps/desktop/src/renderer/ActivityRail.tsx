// VS Code-style global Activity Bar: the 48px left rail is a stable landmark
// on every surface (chat and code alike). It contains only destinations that
// swap the adjacent panel; creation actions live in the Sessions panel header.
// Usage and Settings live at the rail foot; the updater badge moved to the
// window bar beside the sidebar toggle (user: 다운로드 아이콘 위치).
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ChartPie,
  Clock,
  Layers3,
  MessageSquare,
  PanelsTopLeft,
  Settings,
  Webhook,
  Wrench,
} from "lucide-react";

import { schedulePostInteractionIdle } from "./app-idle-warmup";
import {
  desktopFeatureEnabled,
  desktopSidebarDestinationEnabled,
} from "./desktop-feature-config";
import { t } from "./i18n";
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from "./immediate-overlay";
import { ProviderIcon } from "./provider-display";
import { SidebarUsage, usagePinEntries } from "./SidebarUsage";
import {
  getUsageDashboardSnapshot,
  holdUsageDashboardCadence,
  refreshUsageDashboard,
  subscribeUsageDashboard,
  type UsageApi,
} from "./usage-dashboard-store";

/** Pin mode survives restarts: the rail button keeps showing the per-brand
 *  usage stack until the pin is switched off again (user: 핀 온오프). */
const USAGE_RAIL_PIN_KEY = "mixdog.desktop.usage-rail-pin.v1";

export type ActivityRailSurface =
  "utilities" | "projects" | "workflows" | "schedules" | "webhooks" | "settings";
export type ActivityRailWorkbenchSurface =
  "files" | "source-control";

export function ActivityRail({
  activeSurface,
  sidebarOpen,
  onToggleSessions,
  onOpenUtilities,
  onPrefetchUtilities,
  onOpenProjects,
  onPrefetchProjects,
  onOpenWorkflows,
  onPrefetchWorkflows,
  onOpenSchedules,
  onPrefetchSchedules,
  onOpenWebhooks,
  onPrefetchWebhooks,
  onCloseActiveSurface,
  onOpenSettings,
  onPrefetchSettings,
  usageApi,
}: {
  activeSurface: ActivityRailSurface | null;
  /* Workbench surfaces (Explorer/Search/SCM/Debug/Tests) belong to the RIGHT
     utility dock only (user: 좌우 분산 유지) — the rail accepts the props for
     compatibility but never renders that cluster. */
  activeWorkbenchSurface?: ActivityRailWorkbenchSurface | null;
  sidebarOpen: boolean;
  onToggleSessions(): void;
  onOpenUtilities(): void;
  onPrefetchUtilities?(): void;
  onOpenProjects(): void;
  onPrefetchProjects?(): void;
  onOpenWorkflows(): void;
  onPrefetchWorkflows?(): void;
  onOpenSchedules(): void;
  onPrefetchSchedules?(): void;
  onOpenWebhooks(): void;
  onPrefetchWebhooks?(): void;
  onCloseActiveSurface(): void;
  onOpenWorkbench?(surface: ActivityRailWorkbenchSurface): void;
  onOpenSettings(): void;
  onPrefetchSettings?(): void;
  /** Overridable only for tests; the rail warms usage through the host API. */
  usageApi?: UsageApi;
}) {
  const surfaces: ReadonlyArray<{
    id: ActivityRailSurface;
    label: string;
    tooltip: string;
    icon: typeof PanelsTopLeft;
    onOpen(): void;
    onPrefetch?(): void;
  }> = ([
    { id: "utilities", label: "Utilities", tooltip: "Utilities", icon: Wrench,
      onOpen: onOpenUtilities, onPrefetch: onPrefetchUtilities },
    { id: "projects", label: "Open projects", tooltip: "Projects", icon: PanelsTopLeft,
      onOpen: onOpenProjects, onPrefetch: onPrefetchProjects },
    { id: "workflows", label: "Open workflows", tooltip: "Workflows", icon: Layers3,
      onOpen: onOpenWorkflows, onPrefetch: onPrefetchWorkflows },
    { id: "schedules", label: "Open schedules", tooltip: "Schedules", icon: Clock,
      onOpen: onOpenSchedules, onPrefetch: onPrefetchSchedules },
    { id: "webhooks", label: "Open webhooks", tooltip: "Webhooks", icon: Webhook,
      onOpen: onOpenWebhooks, onPrefetch: onPrefetchWebhooks },
  ] as const).filter((surface) => desktopSidebarDestinationEnabled(surface.id));
  // Subscription usage moved off the session panel (user decision): the rail
  // hosts a VS Code account-style toggle and the panel stays a pure session
  // list. Only the dashboard MARKUP is flyout-scoped; its data lives in the
  // shared store below so the first open never starts from nothing.
  const [usageOpen, setUsageOpen] = useState(false);
  // Pin mode (user: 핀모드): pinned, the Usage button trades the pie glyph
  // for one icon per brand with its worst-window percentage beneath it. The
  // shared store the rail already prewarms feeds it; no extra requests.
  const [usagePinned, setUsagePinned] = useState(() => {
    try {
      return window.localStorage.getItem(USAGE_RAIL_PIN_KEY) === "1";
    } catch { return false; }
  });
  const toggleUsagePin = () => {
    setUsagePinned((pinned) => {
      const next = !pinned;
      try {
        window.localStorage.setItem(USAGE_RAIL_PIN_KEY, next ? "1" : "0");
      } catch { /* the toggle still applies for this session */ }
      return next;
    });
  };
  const usageSnapshot = useSyncExternalStore(subscribeUsageDashboard, getUsageDashboardSnapshot);
  // Data-less pinning (store not warmed yet, nothing connected) falls back to
  // the pie glyph instead of an empty stack.
  const usagePinRows = usagePinned ? usagePinEntries(usageSnapshot.dashboard) : [];
  // Anchor the flyout's bottom edge to the Usage button itself, measured at
  // open time (static offsets drifted a few px from the real rail layout).
  const [usageAnchorBottom, setUsageAnchorBottom] = useState(48);
  const preparedUsageAnchor = useRef<number | null>(null);
  const usageClickGuard = useImmediateOverlayClickGuard();
  const rememberUsageAnchor = (element: HTMLButtonElement) => {
    const bounds = element.getBoundingClientRect();
    preparedUsageAnchor.current = Math.max(8, Math.round(window.innerHeight - bounds.bottom));
  };
  const toggleUsage = (element: HTMLButtonElement) => {
    if (!usageOpen && preparedUsageAnchor.current === null) rememberUsageAnchor(element);
    commitImmediateOverlay(() => {
      if (!usageOpen && preparedUsageAnchor.current !== null) {
        setUsageAnchorBottom(preparedUsageAnchor.current);
      }
      setUsageOpen((open) => !open);
    });
  };
  // The rail is always mounted, so the usage warmup finally has a host that
  // outlives the popup: one low-priority post-boot idle prewarm fills the
  // shared store before the first click, and one cadence holder keeps the
  // refresh timer independent of flyout mounts.
  useEffect(() => {
    if (!desktopFeatureEnabled("usage")) return undefined;
    const api = usageApi ?? window.mixdogDesktop;
    const release = holdUsageDashboardCadence(api);
    const cancelPrewarm = schedulePostInteractionIdle(
      () => void refreshUsageDashboard(api),
      5_000,
      1_500,
      5_000,
    );
    return () => {
      cancelPrewarm();
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
      if (target?.closest(".rail-usage-popup, .sidebar-usage-toggle")) return;
      setUsageOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUsageOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", keydown);
    };
  }, [usageOpen]);
  return (
    <aside className="activity-rail" aria-label={t("Activity Bar")}>
      <nav className="sidebar-primary-nav" aria-label={t("Workspace")}>
        {/* The Sessions toggle mirrors VS Code's Explorer button: pressing it
            expands/collapses the session panel. is-active (not selected)
            tracks the OPEN panel so surface selection stays separate. */}
        {desktopFeatureEnabled("sessions") && <button type="button" className={`sessions-link ${sidebarOpen ? "is-active" : ""}`}
          aria-label={t("Sessions")} aria-expanded={sidebarOpen} aria-controls="session-sidebar"
          data-tooltip={t("Sessions")} onClick={onToggleSessions}>
          <MessageSquare size={20} aria-hidden="true" />
        </button>}
        {/* Workbench tools (Explorer/Search/SCM/Debug/Tests) live ONLY on the
            right utility dock (user: 원래 의도 — 좌측은 앱 목적지, 우측은
            코드 도구). Duplicating them here split one destination across
            both rails. */}
        {surfaces.map(({ id, label, tooltip, icon: Icon, onOpen, onPrefetch }) => {
          const selected = activeSurface === id;
          return (
            <button key={id} type="button"
              className={`projects-link ${selected ? "selected" : ""}`}
              aria-label={t(label)} aria-current={selected ? "page" : undefined}
              data-tooltip={t(tooltip)}
              onPointerEnter={onPrefetch}
              onFocus={onPrefetch}
              onClick={selected ? onCloseActiveSurface : onOpen}>
              <Icon size={20} aria-hidden="true" />
            </button>
          );
        })}
      </nav>
      <div className="activity-rail-spacer" />
      {desktopFeatureEnabled("usage") && <button type="button"
        className={`sidebar-usage-toggle ${usageOpen ? "is-active" : ""}${
          usagePinRows.length ? " is-pinned" : ""}`}
        aria-label={t("Usage")} aria-expanded={usageOpen} aria-haspopup="dialog"
        data-tooltip={t("Usage")}
        onPointerEnter={(event) => rememberUsageAnchor(event.currentTarget)}
        onFocus={(event) => rememberUsageAnchor(event.currentTarget)}
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
        onPointerCancel={usageClickGuard.clearPointerActivation}>
        {/* Pie-slice glyph: the classic usage/quota mark — gauge, columns and
            gantt bars all read clipped or generic at 20px (user feedback).
            Pinned, the same button becomes the brand stack. */}
        {usagePinRows.length
          ? <span className="rail-usage-pin-stack" aria-hidden="true">
            {usagePinRows.map((entry) => {
              const percent = Math.round(entry.percent);
              // Glanceable readout (user: 프로그래스 중간에): icon, then the
              // flyout's meter grammar in miniature, then the number — bar
              // and number turn warning/danger as the worst window fills up.
              const tone = entry.percent >= 90 ? " tone-danger"
                : entry.percent >= 70 ? " tone-warning" : "";
              return <span className={`rail-usage-pin-brand${tone}`}
                key={entry.key} data-usage-pin={entry.key}>
                <ProviderIcon provider={entry.provider} />
                <i><i style={{ width: `${percent}%` }} /></i>
                <small>{percent}%</small>
              </span>;
            })}
          </span>
          : <ChartPie size={20} aria-hidden="true" />}
      </button>}
      {desktopFeatureEnabled("settings") && <button type="button"
        className={`sidebar-settings-button ${activeSurface === "settings" ? "selected" : ""}`}
        aria-label={t("Open settings")} aria-current={activeSurface === "settings" ? "page" : undefined}
        data-tooltip={t("Settings")} onPointerEnter={onPrefetchSettings}
        onFocus={onPrefetchSettings} onClick={onOpenSettings}>
        <Settings size={20} aria-hidden="true" />
      </button>}
      {/* The flyout's bottom edge tracks the Usage button itself (user). */}
      {desktopFeatureEnabled("usage") && usageOpen && <div className="rail-usage-popup" role="dialog" aria-label={t("Subscription usage")}
        style={{ "--rail-usage-popup-bottom": `${usageAnchorBottom}px` } as React.CSSProperties}
        data-state="open">
        {/* The popup shares the rail's host API so its open-time revalidation
            hits the same store entry the rail already prewarmed. */}
        <SidebarUsage sidebarOpen api={usageApi}
          pinned={usagePinned} onTogglePin={toggleUsagePin} />
      </div>}
    </aside>
  );
}
