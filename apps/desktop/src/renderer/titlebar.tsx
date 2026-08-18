// Window title bar: a clean drag band. The workspace tab strips moved into
// the panes themselves (WorkspaceTabStrip); the bar
// keeps the draggable run, the updater badge plus the three global layout
// toggles on its right edge, and the Windows caption reserve.
import { ArrowDown } from "lucide-react";

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
  sidebarLabel?: string;
  dockLabel?: string;
  updaterState?: DesktopUpdaterState;
  onOpenUpdate?(): void;
}

function SidebarToggleIcon({ open }: { open: boolean }) {
  // VS Code's own codicon glyph (user: B안 — codicon 도입): font-rendered on
  // the 16px grid so its lines land on device pixels, unlike lucide's 24-grid
  // SVGs whose strokes go fractional when scaled to 16/18px boxes.
  return <span className="sidebar-toggle-icon codicon codicon-layout-sidebar-left"
    data-state={open ? "open" : "closed"} aria-hidden="true" />;
}

export function DesktopTitlebar({
  sidebarOpen,
  onToggleSidebar,
  panelOpen = false,
  onTogglePanel,
  dockOpen = false,
  onToggleDock,
  sidebarLabel = "session sidebar",
  dockLabel = "utility panel",
  updaterState,
  onOpenUpdate,
}: DesktopTitlebarProps) {
  // The - ㅁ x caption band belongs to the ELECTRON shell alone. A browser or
  // web surface serves the SAME bundle through the relay/LAN bridge
  // (remote-shim installs mixdogRemoteServer there), and reserving a caption
  // strip there only steals the title row of a window that has no caption.
  const electronShell = typeof navigator !== "undefined"
    && /Electron/i.test(navigator.userAgent);
  const windowsCaptionControls = electronShell && /Windows/i.test(navigator.userAgent);
  // Updater badge (user: 다운로드 아이콘을 사이드바 토글 왼쪽으로): the accent
  // circle moved from the Activity Bar foot into the layout-control cluster.
  const updateVisible = Boolean(onOpenUpdate)
    && (updaterState?.status === "ready" || updaterState?.status === "installing");
  const updateInstalling = updaterState?.status === "installing";
  return (
    <header className="topbar" aria-label={t("Window bar")}>
      {/* No brand mark (user: 로고는 날려버리고) — the bar opens straight on
          the navigation cluster and stays the drag band. */}
      {/* LEFT cluster: the brand mark only (VS Code grammar — user: 왼쪽
          사이드탭 열기는 오른쪽으로, 그 자리에 로고). The sidebar toggle
          moved into the right layout cluster below. */}
      <div className="titlebar-leading titlebar-nav" aria-label={t("Navigation")}>
        <span className="titlebar-brand" aria-hidden="true">
          <img src="./mixdog.svg" alt="" draggable={false} />
        </span>
      </div>
      <div className="titlebar-spacer" aria-hidden="true" />
      {/* RIGHT cluster (user: 하단·오른쪽은 우측에, 코덱스와 달리 윗줄에):
          updater badge + bottom-panel + right-dock toggles, ahead of the
          native caption reserve. */}
      <div className="titlebar-leading titlebar-controls" aria-label={t("Layout controls")}>
        {/* VS Code layout-control order: primary sidebar, panel, secondary
            sidebar — all clustered at the right edge. */}
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
              ? <ProgressSpinner size={12} className="sidebar-update-loader" aria-hidden="true" />
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
            <span className="sidebar-toggle-icon codicon codicon-layout-panel" aria-hidden="true" />
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
            <span className="sidebar-toggle-icon codicon codicon-layout-sidebar-right" aria-hidden="true" />
          </button>
        )}
      </div>
      {windowsCaptionControls && <div className="titlebar-caption-space" aria-hidden="true" />}
    </header>
  );
}
