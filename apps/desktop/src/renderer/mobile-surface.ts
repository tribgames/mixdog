// Projected-phone surface detection + pre-paint root marker. The
// Chrome-toolbar, drawer, and popup CSS all key on
// `html[data-mixdog-mobile-tabs]` and `--mx-device-scale`; installing them in
// a mount effect meant the FIRST paint used the desktop grammar and the
// phone visibly re-arranged itself a frame later (user: 처음 들어가면
// 레이아웃 시프트가 심하다). main.tsx installs the marker synchronously
// BEFORE React renders, so the phone lays out correctly exactly once.
import { isRemoteBrowserRenderer } from "./remote-ui-projection";

export function isMobileRemoteSurface(): boolean {
  if (!isRemoteBrowserRenderer()) return false;
  try {
    return (navigator.maxTouchPoints || 0) > 0
      && Math.min(window.screen.width, window.screen.height) < 768;
  } catch {
    return false;
  }
}

/** Idempotent; safe to call again after viewport-defining loads. */
export function installMobileSurfaceMarker(): void {
  if (!isMobileRemoteSurface()) return;
  document.documentElement.setAttribute("data-mixdog-mobile-tabs", "");
  // Projection factor (layout px per device dp) so CSS can size chrome in
  // Chrome-Android dp terms on ANY phone instead of one device's ratio.
  try {
    const layout = document.documentElement.clientWidth || 1040;
    const device = Math.min(window.screen.width, window.screen.height) || layout;
    const scale = Math.max(1, Math.round((layout / device) * 100) / 100);
    document.documentElement.style.setProperty("--mx-device-scale", String(scale));
  } catch { /* CSS falls back to its default factor */ }
}
