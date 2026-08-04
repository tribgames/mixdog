// Window title bar: a clean drag band. The workspace tab strips moved into
// the panes themselves (VS Code editor groups - WorkspaceTabStrip); the bar
// keeps the draggable run, the updater badge plus the three global layout
// toggles on its right edge, and the Windows caption reserve.
import { ArrowDown, ArrowLeft, ArrowRight, PanelBottom, PanelLeft, PanelRight } from "lucide-react";

import type { DesktopUpdaterState } from "../shared/contract";
import { t } from "./i18n";
import { ProgressSpinner } from "./ProgressSpinner";

interface DesktopTitlebarProps {
  sidebarOpen: boolean;
  onToggleSidebar(): void;
  panelOpen?: boolean;
  onTogglePanel?(): void;
  dockOpen?: boolean;
  onToggleDock?(): void;
  paneCount?: number;
  onFocusSiblingPane?(offset: number): void;
  sidebarLabel?: string;
  dockLabel?: string;
  updaterState?: DesktopUpdaterState;
  onOpenUpdate?(): void;
}

function SidebarToggleIcon({ open }: { open: boolean }) {
  // Outline-only glyph (user: no filled state) from the rounded lucide set,
  // matching the New task / Project icons.
  return <PanelLeft className="sidebar-toggle-icon" size={18}
    data-state={open ? "open" : "closed"} aria-hidden="true" />;
}

export function DesktopTitlebar({
  sidebarOpen,
  onToggleSidebar,
  panelOpen = false,
  onTogglePanel,
  dockOpen = false,
  onToggleDock,
  paneCount = 1,
  onFocusSiblingPane,
  sidebarLabel = "session sidebar",
  dockLabel = "utility panel",
  updaterState,
  onOpenUpdate,
}: DesktopTitlebarProps) {
  const windowsCaptionControls = typeof navigator !== "undefined" &&
    /Windows/i.test(navigator.userAgent);
  // Updater badge (user: 다운로드 아이콘을 사이드바 토글 왼쪽으로): the accent
  // circle moved from the Activity Bar foot into the layout-control cluster.
  const updateVisible = Boolean(onOpenUpdate)
    && (updaterState?.status === "ready" || updaterState?.status === "installing");
  const updateInstalling = updaterState?.status === "installing";
  return (
    <header className="topbar" aria-label={t("Window bar")}>
      {/* No brand mark (user: 로고는 날려버리고) — the bar opens straight on
          the navigation cluster and stays the drag band. */}
      {/* LEFT cluster (user: 화살표랑 왼쪽 열기는 좌측에): the sidebar
          toggle, then the persistent ◀ n/m ▶ pane cycle — the SAME
          reading-order focus cycle as Alt+Left/Right; narrow widths page
          the single-pane carousel, wide layouts move pane focus. */}
      <div className="titlebar-leading titlebar-nav" aria-label={t("Navigation")}>
        <button
          type="button"
          className="icon-button toolbar-sidebar"
          onClick={onToggleSidebar}
          aria-label={t(sidebarOpen ? "Collapse {{label}}" : "Expand {{label}}", { label: t(sidebarLabel) })}
          aria-expanded={sidebarOpen}
          aria-controls="session-sidebar"
        >
          <SidebarToggleIcon open={sidebarOpen} />
        </button>
        {onFocusSiblingPane && <>
          <button
            type="button"
            className="icon-button titlebar-pane-nav"
            onClick={() => onFocusSiblingPane(-1)}
            disabled={paneCount < 2}
            aria-label={t("Previous pane")}
            data-tooltip={t("Previous pane")}
          >
            {/* Full arrows (ChatGPT reference) in the cluster's shared
                optical box — sidebar-toggle-icon pins the 18px frame and
                1.25px stroke so weight/size match the neighbors (user:
                두께 맞추자). */}
            <ArrowLeft className="sidebar-toggle-icon" size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button titlebar-pane-nav"
            onClick={() => onFocusSiblingPane(1)}
            disabled={paneCount < 2}
            aria-label={t("Next pane")}
            data-tooltip={t("Next pane")}
          >
            <ArrowRight className="sidebar-toggle-icon" size={18} aria-hidden="true" />
          </button>
        </>}
      </div>
      <div className="titlebar-spacer" aria-hidden="true" />
      {/* RIGHT cluster (user: 하단·오른쪽은 우측에, 코덱스와 달리 윗줄에):
          updater badge + bottom-panel + right-dock toggles, ahead of the
          native caption reserve. */}
      <div className="titlebar-leading titlebar-controls" aria-label={t("Layout controls")}>
        {updateVisible && (
          <button
            type="button"
            className="icon-button titlebar-update"
            onClick={onOpenUpdate}
            disabled={updateInstalling}
            aria-busy={updateInstalling}
            aria-label={updateInstalling
              ? t("Installing update")
              : t("Install Mixdog {{version}}", { version: updaterState?.version })}
            data-tooltip={updateInstalling ? t("Installing update") : t("Update")}
          >
            {updateInstalling
              ? <ProgressSpinner size={10} className="sidebar-update-loader" aria-hidden="true" />
              : <ArrowDown size={16} strokeWidth={2.6} aria-hidden="true" />}
          </button>
        )}
        {onTogglePanel && (
          <button
            type="button"
            className="icon-button toolbar-panel"
            onClick={onTogglePanel}
            aria-pressed={panelOpen}
            aria-label={t(panelOpen ? "Close panel" : "Open panel")}
            data-tooltip={t(panelOpen ? "Close panel" : "Open panel")}
          >
            <PanelBottom className="sidebar-toggle-icon" size={18} aria-hidden="true" />
          </button>
        )}
        {onToggleDock && (
          <button
            type="button"
            className="icon-button toolbar-dock"
            onClick={onToggleDock}
            aria-pressed={dockOpen}
            aria-label={t(dockOpen ? "Close {{label}}" : "Open {{label}}", { label: t(dockLabel) })}
            data-tooltip={t(dockOpen ? "Close {{label}}" : "Open {{label}}", { label: t(dockLabel) })}
          >
            <PanelRight className="sidebar-toggle-icon" size={18} aria-hidden="true" />
          </button>
        )}
      </div>
      {windowsCaptionControls && <div className="titlebar-caption-space" aria-hidden="true" />}
    </header>
  );
}
