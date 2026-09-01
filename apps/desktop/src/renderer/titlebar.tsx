// Window title bar: a clean drag band. The workspace tab strips moved into
// the panes themselves (WorkspaceTabStrip); the bar
// keeps the draggable run, the updater badge, and the Windows caption reserve.
import { ArrowDown } from "lucide-react";

import type { DesktopUpdaterState } from "../shared/contract";
import { t } from "./i18n";
import { ProgressSpinner } from "./ProgressSpinner";

interface DesktopTitlebarProps {
  updaterState?: DesktopUpdaterState;
  onOpenUpdate?(): void;
}

export function DesktopTitlebar({
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
  // The updater stays window-global; layout controls belong to their panes.
  const updateVisible = Boolean(onOpenUpdate)
    && (updaterState?.status === "ready" || updaterState?.status === "installing");
  const updateInstalling = updaterState?.status === "installing";
  return (
    <header className="topbar" aria-label={t("Window bar")}>
      {/* No brand mark (user: 로고는 날려버리고) — the bar opens straight on
          the navigation cluster and stays the drag band. */}
      {/* LEFT cluster: the brand mark only (user: 왼쪽
          사이드탭 열기는 오른쪽으로, 그 자리에 로고). The sidebar toggle
          moved into the right layout cluster below. */}
      <div className="titlebar-leading titlebar-nav" aria-label={t("Navigation")}>
        <span className="titlebar-brand" aria-hidden="true">
          <img src="./mixdog.svg" alt="" draggable={false} />
        </span>
      </div>
      <div className="titlebar-spacer" aria-hidden="true" />
      {/* RIGHT cluster: updater badge ahead of the native caption reserve.
          Layout surfaces use contextual pane entry points. */}
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
              ? <ProgressSpinner size={12} className="sidebar-update-loader" aria-hidden="true" />
              : <ArrowDown size={16} strokeWidth={2.6} aria-hidden="true" />}
          </button>
        )}
      </div>
      {windowsCaptionControls && <div className="titlebar-caption-space" aria-hidden="true" />}
    </header>
  );
}
