import type { DesktopUtilityDockTab } from "./desktop-feature-config";
import {
  clampDesktopPanelWidth,
  DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH,
  DESKTOP_UTILITY_DOCK_MIN_WIDTH,
} from "../shared/window-layout";

export const DOCK_STATE_KEY = "mixdog.desktop-utility-dock.v1";
export { DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH };
export const DESKTOP_UTILITY_DOCK_MAX_WIDTH = 560;
export type UtilityDockTab = DesktopUtilityDockTab;

export function clampDockWidth(value: number): number {
  return clampDesktopPanelWidth(
    value,
    DESKTOP_UTILITY_DOCK_MIN_WIDTH,
    DESKTOP_UTILITY_DOCK_MAX_WIDTH,
  );
}

export function readDockState(): { open: boolean; tab: UtilityDockTab; width: number } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(DOCK_STATE_KEY) || "{}") as Record<string, unknown>;
    return {
      open: raw.open === true,
      // Migrate the retired Tasks/Files identities without discarding width
      // and open-state preferences from existing installs.
      tab: raw.tab === "agents" || raw.tab === "search"
        || raw.tab === "source-control" || raw.tab === "pull-requests"
        ? raw.tab
        : raw.tab === "tasks" ? "agents"
          : raw.tab === "files" ? "search"
            : "agents",
      width: clampDockWidth(Number(raw.width)),
    };
  } catch {
    return { open: false, tab: "agents", width: DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH };
  }
}
