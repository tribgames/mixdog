// Projected-phone surface detection + pre-paint root marker. The
// Chrome-toolbar, drawer, and popup CSS all key on
// `html[data-mixdog-mobile-tabs]` and `--mx-device-scale`; installing them in
// a mount effect meant the FIRST paint used the desktop grammar and the
// phone visibly re-arranged itself a frame later (user: 처음 들어가면
// 레이아웃 시프트가 심하다). main.tsx installs the marker synchronously
// BEFORE React renders, so the phone lays out correctly exactly once.
import { isRemoteBrowserRenderer } from "./remote-ui-projection";

export function isIOSWebSurface(): boolean {
  if (!isRemoteBrowserRenderer()) return false;
  try {
    return /iPad|iPhone|iPod/iu.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);
  } catch {
    return false;
  }
}

export function isMobileRemoteSurface(): boolean {
  if (!isRemoteBrowserRenderer()) return false;
  try {
    if (isIOSWebSurface()) return true;
    return (navigator.maxTouchPoints || 0) > 0
      && Math.min(window.screen.width, window.screen.height) < 768;
  } catch {
    return false;
  }
}

export function mobileSurfaceScale(): number {
  if (!isMobileRemoteSurface() || isIOSWebSurface()) return 1;
  try {
    const layout = document.documentElement.clientWidth || 1040;
    const device = Math.min(window.screen.width, window.screen.height) || layout;
    return Math.max(1, Math.round((layout / device) * 100) / 100);
  } catch {
    return 1;
  }
}

/** Keeps phone markers and projection metrics current across rotation/PWA restore. */
export function installMobileSurfaceMarker(): () => void {
  const sync = () => {
    const root = document.documentElement;
    if (!isMobileRemoteSurface()) {
      root.removeAttribute("data-mixdog-mobile-tabs");
      root.removeAttribute("data-mixdog-ios-web");
      root.style.removeProperty("--mx-device-scale");
      return;
    }
    root.setAttribute("data-mixdog-mobile-tabs", "");
    if (isIOSWebSurface()) root.setAttribute("data-mixdog-ios-web", "");
    else root.removeAttribute("data-mixdog-ios-web");
    root.style.setProperty("--mx-device-scale", String(mobileSurfaceScale()));
  };
  sync();
  const visual = window.visualViewport;
  window.addEventListener("resize", sync);
  window.addEventListener("orientationchange", sync);
  window.addEventListener("pageshow", sync);
  visual?.addEventListener("resize", sync);
  return () => {
    window.removeEventListener("resize", sync);
    window.removeEventListener("orientationchange", sync);
    window.removeEventListener("pageshow", sync);
    visual?.removeEventListener("resize", sync);
  };
}
