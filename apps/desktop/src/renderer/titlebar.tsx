// Window title bar: a clean drag band. The workspace tab strips moved into
// the panes themselves (VS Code editor groups - WorkspaceTabStrip); the bar
// keeps the draggable run, the updater badge plus the three global layout
// toggles on its right edge, and the Windows caption reserve.
import { ArrowDown, PanelBottom, PanelLeft, PanelRight } from "lucide-react";

import type { DesktopUpdaterState } from "../shared/contract";
import { ProgressSpinner } from "./ProgressSpinner";
import { BrandTile } from "./WorkspaceEmptyState";

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
    <header className="topbar" aria-label="Window bar">
      {/* Brand mark pinned to the window's TOP-LEFT (user correction — Orca
          grammar); the rest of the bar stays the drag band. */}
      <span className="titlebar-brand" aria-hidden="true"><BrandTile /></span>
      <div className="titlebar-spacer" aria-hidden="true" />
      <div className="titlebar-leading" aria-label="Layout controls">
        {updateVisible && (
          <button
            type="button"
            className="icon-button titlebar-update"
            onClick={onOpenUpdate}
            disabled={updateInstalling}
            aria-busy={updateInstalling}
            aria-label={updateInstalling
              ? "Installing update"
              : `Install Mixdog ${updaterState?.version}`}
            data-tooltip={updateInstalling ? "Installing update" : "Update"}
          >
            {updateInstalling
              ? <ProgressSpinner size={10} className="sidebar-update-loader" aria-hidden="true" />
              : <ArrowDown size={16} strokeWidth={2.6} aria-hidden="true" />}
          </button>
        )}
        <button
          type="button"
          className="icon-button toolbar-sidebar"
          onClick={onToggleSidebar}
          aria-label={`${sidebarOpen ? "Collapse" : "Expand"} ${sidebarLabel}`}
          aria-expanded={sidebarOpen}
          aria-controls="session-sidebar"
        >
          <SidebarToggleIcon open={sidebarOpen} />
        </button>
        {onTogglePanel && (
          <button
            type="button"
            className="icon-button toolbar-panel"
            onClick={onTogglePanel}
            aria-pressed={panelOpen}
            aria-label={`${panelOpen ? "Close" : "Open"} panel`}
            data-tooltip={`${panelOpen ? "Close" : "Open"} panel`}
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
            aria-label={`${dockOpen ? "Close" : "Open"} ${dockLabel}`}
            data-tooltip={`${dockOpen ? "Close" : "Open"} ${dockLabel}`}
          >
            <PanelRight className="sidebar-toggle-icon" size={18} aria-hidden="true" />
          </button>
        )}
      </div>
      {windowsCaptionControls && <div className="titlebar-caption-space" aria-hidden="true" />}
    </header>
  );
}
