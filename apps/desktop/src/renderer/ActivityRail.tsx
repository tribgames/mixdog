// The 48px global activity rail is a stable landmark
// on every surface (chat and code alike). It contains only destinations that
// swap the adjacent panel; creation actions live in the Sessions panel header.
// Usage and Settings live at the rail foot; the updater badge moved to the
// window bar beside the sidebar toggle (user: 다운로드 아이콘 위치).
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { schedulePostInteractionIdle } from "./app-idle-warmup";
import {
  desktopFeatureEnabled,
  desktopSidebarDestinationEnabled,
} from "./desktop-feature-config";
import { t } from "./i18n";
import { useMobileBack } from "./mobile-back";
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
import { displayUsagePercent } from "./usage-percent";
import type { SidebarPanelKey } from "./app-shell-components";
import {
  SIDEBAR_GROUP_MIME,
  SIDEBAR_VIEW_MIME,
  sidebarGroupDragId,
  sidebarViewDragId,
  type SidebarViewGroup,
  type SidebarViewPlacement,
} from "./sidebar-view-layout";

/** Pin mode survives restarts: the rail button keeps showing the per-brand
 *  usage stack until the pin is switched off again (user: 핀 온오프). */
const USAGE_RAIL_PIN_KEY = "mixdog.desktop.usage-rail-pin.v1";

export type ActivityRailSurface =
  "utilities" | "projects" | "workflows" | "schedules" | "webhooks" | "settings";
export type ActivityRailWorkbenchSurface =
  "search" | "source-control";

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
  viewGroups,
  onMoveViewGroup,
  onMoveView,
  primaryNavigation,
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
  viewGroups?: readonly SidebarViewGroup[];
  onMoveViewGroup?(
    sourceRoot: SidebarPanelKey,
    targetRoot: SidebarPanelKey,
    placement: "before" | "after",
  ): void;
  onMoveView?(
    sourceId: SidebarPanelKey,
    targetId: SidebarPanelKey,
    placement: SidebarViewPlacement,
  ): void;
  primaryNavigation?: React.ReactNode;
}) {
  // Codicon names (user: 레일 아이콘이 오히려 흐려 — B안 확장): the rail
  // renders codicon activity-bar font glyphs, pixel-crisp at their native
  // sizes, instead of scaled lucide SVG strokes.
  const surfaces: ReadonlyArray<{
    id: ActivityRailSurface;
    label: string;
    tooltip: string;
    icon: string;
    onOpen(): void;
    onPrefetch?(): void;
  }> = ([
    { id: "projects", label: "Open projects", tooltip: "Projects", icon: "project",
      onOpen: onOpenProjects, onPrefetch: onPrefetchProjects },
    { id: "workflows", label: "Open workflows", tooltip: "Workflows", icon: "layers",
      onOpen: onOpenWorkflows, onPrefetch: onPrefetchWorkflows },
    { id: "schedules", label: "Open schedules", tooltip: "Schedules", icon: "calendar",
      onOpen: onOpenSchedules, onPrefetch: onPrefetchSchedules },
    { id: "webhooks", label: "Open webhooks", tooltip: "Webhooks", icon: "plug",
      onOpen: onOpenWebhooks, onPrefetch: onPrefetchWebhooks },
    // Utilities sit last in the rail (user: 사이드탭 순서 중 가장 아래로),
    // keeping the creative wand icon (user: 렌치 말고 마법봉처럼).
    { id: "utilities", label: "Utilities", tooltip: "Utilities", icon: "wand",
      onOpen: onOpenUtilities, onPrefetch: onPrefetchUtilities },
  ] as const).filter((surface) => desktopSidebarDestinationEnabled(surface.id));
  const orderedSurfaceGroups = (viewGroups?.length
    ? viewGroups
    : surfaces.map((surface) => [surface.id] as SidebarViewGroup))
    .map((group) => ({
      group,
      surface: surfaces.find((candidate) => candidate.id === group[0]),
    }))
    .filter((entry): entry is {
      group: SidebarViewGroup;
      surface: (typeof surfaces)[number];
    } => Boolean(entry.surface));
  const [railDrop, setRailDrop] = useState<{
    target: SidebarPanelKey;
    placement: SidebarViewPlacement;
  } | null>(null);
  // Subscription usage moved off the session panel (user decision): the rail
  // hosts an account toggle and the panel stays a pure session
  // list. Only the dashboard MARKUP is flyout-scoped; its data lives in the
  // shared store below so the first open never starts from nothing.
  const [usageOpen, setUsageOpen] = useState(false);
  // ABB: the usage flyout closes on hardware back.
  useMobileBack(usageOpen, () => setUsageOpen(false));
  // Pin mode (user: 핀모드): pinned, the Usage button trades the pie glyph
  // for one icon per brand with its worst-window percentage beneath it. The
  // shared store the rail already prewarms feeds it; no extra requests.
  const [usagePinned, setUsagePinned] = useState(() => {
    try {
      return window.localStorage.getItem(USAGE_RAIL_PIN_KEY) === "1";
    } catch { return false; }
  });
  // The pin is a shared desktop SETTING (user: 모바일/웹에서도 연동): the
  // localStorage seed paints instantly, then the canonical value loads
  // through the same settings lane both surfaces share.
  useEffect(() => {
    let live = true;
    void window.mixdogDesktop?.readSettings?.()
      .then((settings) => {
        if (!live || typeof settings?.usagePinned !== "boolean") return;
        setUsagePinned(settings.usagePinned);
        try {
          window.localStorage.setItem(USAGE_RAIL_PIN_KEY, settings.usagePinned ? "1" : "0");
        } catch { /* seed only */ }
      })
      .catch(() => { /* keep the local seed */ });
    return () => { live = false; };
  }, []);
  const toggleUsagePin = () => {
    setUsagePinned((pinned) => {
      const next = !pinned;
      try {
        window.localStorage.setItem(USAGE_RAIL_PIN_KEY, next ? "1" : "0");
      } catch { /* the toggle still applies for this session */ }
      void window.mixdogDesktop?.updateSetting?.("usagePinned", next)
        ?.catch(() => { /* local state still applies */ });
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
      <nav className="sidebar-primary-nav" aria-label={t("Sidebar")}>
        {primaryNavigation ?? <>
        {/* The Sessions toggle behaves like an Explorer button: pressing it
            expands/collapses the session panel. is-active (not selected)
            tracks the OPEN panel so surface selection stays separate. */}
        {desktopFeatureEnabled("sessions") && <button type="button" className={`sessions-link ${sidebarOpen ? "is-active" : ""}`}
          aria-label={t("Sessions")} aria-expanded={sidebarOpen} aria-controls="session-sidebar"
          data-tooltip={t("Sessions")} onClick={onToggleSessions}>
          <span className="codicon codicon-comment-discussion" aria-hidden="true" />
        </button>}
        {/* Workbench tools (Explorer/Search/SCM/Debug/Tests) live ONLY on the
            right utility dock (user: 원래 의도 — 좌측은 앱 목적지, 우측은
            코드 도구). Duplicating them here split one destination across
            both rails. */}
        {orderedSurfaceGroups.map(({ group, surface }) => {
          const { id, label, tooltip, icon, onOpen, onPrefetch } = surface;
          const rootId = group[0];
          const selected = activeSurface !== null
            && group.includes(activeSurface as SidebarPanelKey);
          return (
            <button key={id} type="button"
              className={`projects-link ${selected ? "selected" : ""}`}
              aria-label={t(label)} aria-current={selected ? "page" : undefined}
              data-tooltip={t(tooltip)}
              data-drop-position={railDrop?.target === rootId ? railDrop.placement : undefined}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(SIDEBAR_GROUP_MIME, rootId);
                event.dataTransfer.setData("text/plain", rootId);
              }}
              onDragOver={(event) => {
                const types = Array.from(event.dataTransfer.types);
                const groupDrag = types.includes(SIDEBAR_GROUP_MIME);
                const viewDrag = types.includes(SIDEBAR_VIEW_MIME);
                if (!groupDrag && !viewDrag) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const bounds = event.currentTarget.getBoundingClientRect();
                const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height);
                const placement: SidebarViewPlacement = groupDrag
                  ? ratio < .5 ? "before" : "after"
                  : ratio < .25 ? "before" : ratio > .75 ? "after" : "inside";
                setRailDrop({ target: rootId, placement });
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setRailDrop((current) => current?.target === rootId ? null : current);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                const placement = railDrop?.target === rootId ? railDrop.placement : "inside";
                const groupSource = sidebarGroupDragId(event.nativeEvent);
                const viewSource = sidebarViewDragId(event.nativeEvent);
                if (groupSource && placement !== "inside") {
                  onMoveViewGroup?.(groupSource, rootId, placement);
                } else if (viewSource) {
                  onMoveView?.(viewSource, rootId, placement);
                  if (placement === "inside" && !selected) onOpen();
                }
                setRailDrop(null);
              }}
              onDragEnd={() => setRailDrop(null)}
              onPointerEnter={onPrefetch}
              onFocus={onPrefetch}
              onClick={selected ? onCloseActiveSurface : onOpen}>
              <span className={`codicon codicon-${icon}`} aria-hidden="true" />
            </button>
          );
        })}
        </>}
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
              const percent = displayUsagePercent(entry.percent) ?? 0;
              // Glanceable readout (user: 프로그래스 중간에): icon, then the
              // flyout's meter grammar in miniature, then the number — bar
              // and number reflect the provider's final quota window.
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
          : <span className="codicon codicon-pie-chart" aria-hidden="true" />}
      </button>}
      {desktopFeatureEnabled("settings") && <button type="button"
        className={`sidebar-settings-button ${activeSurface === "settings" ? "selected" : ""}`}
        aria-label={t("Open settings")} aria-current={activeSurface === "settings" ? "page" : undefined}
        data-tooltip={t("Settings")} onPointerEnter={onPrefetchSettings}
        onFocus={onPrefetchSettings} onClick={onOpenSettings}>
        <span className="codicon codicon-settings-gear" aria-hidden="true" />
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
