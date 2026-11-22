export const DESKTOP_SIDEBAR_MIN_WIDTH = 252;
export const DESKTOP_WORKSPACE_MIN_WIDTH = 360;
export const DESKTOP_UTILITY_DOCK_MIN_WIDTH = 300;
/* The first-install window: wide enough for the session cards beside a
   conversation at its full reading width, with the sidebar open. */
export const DESKTOP_WINDOW_DEFAULT_WIDTH = 1460;
export const DESKTOP_WINDOW_DEFAULT_HEIGHT = 864;
export const DESKTOP_SIDEBAR_DEFAULT_WIDTH = DESKTOP_SIDEBAR_MIN_WIDTH;
export const DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH = DESKTOP_UTILITY_DOCK_MIN_WIDTH;

export function clampDesktopPanelWidth(value: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, Math.round(Number.isFinite(value) ? value : minWidth)));
}

export const DESKTOP_WINDOW_MIN_WIDTH = 400;
