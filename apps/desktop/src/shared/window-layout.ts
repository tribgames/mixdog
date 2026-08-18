export const DESKTOP_SIDEBAR_MIN_WIDTH = 232;
export const DESKTOP_WORKSPACE_MIN_WIDTH = 360;
export const DESKTOP_UTILITY_DOCK_MIN_WIDTH = 300;
export const DESKTOP_WINDOW_DEFAULT_WIDTH = 1040;
export const DESKTOP_SIDEBAR_DEFAULT_WIDTH = DESKTOP_SIDEBAR_MIN_WIDTH;
export const DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH = DESKTOP_UTILITY_DOCK_MIN_WIDTH;

export function clampDesktopPanelWidth(value: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(
    minWidth,
    Math.round(Number.isFinite(value) ? value : minWidth),
  ));
}

/* The native desktop remains fully responsive when its real window narrows.
   Remote browsers use DESKTOP_WINDOW_DEFAULT_WIDTH as a virtual projection
   viewport, so phone screens scale this desktop composition instead of
   activating the native window's narrow layout bands. */
export const DESKTOP_WINDOW_MIN_WIDTH = 360;
