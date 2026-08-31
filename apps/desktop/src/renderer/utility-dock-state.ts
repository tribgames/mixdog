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

/**
 * Open state and width only. The active TAB is deliberately not restored
 * (user: 좌·우·하단 도크 전부 첫 메뉴로 초기화), which also retires the old
 * Tasks/Files tab identities: every launch starts on the leading tab.
 */
export function readDockState(): { open: boolean; width: number } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(DOCK_STATE_KEY) || "{}") as Record<string, unknown>;
    return {
      open: raw.open === true,
      width: clampDockWidth(Number(raw.width)),
    };
  } catch {
    return { open: false, width: DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH };
  }
}
