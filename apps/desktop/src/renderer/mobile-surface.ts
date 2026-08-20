// Phone surface detection + pre-paint root marker. The Chrome-toolbar,
// drawer, and popup CSS all key on `html[data-mixdog-mobile-tabs]` and
// `--mx-device-scale` (native CSS pixels = 1 on every phone). Installing
// them in a mount effect meant the FIRST paint used the desktop grammar
// and the phone visibly re-arranged itself a frame later (user: 처음
// 들어가면 레이아웃 시프트가 심하다). main.tsx installs the marker
// synchronously BEFORE React renders, so the phone lays out correctly
// exactly once.
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
    if (/Android/i.test(navigator.userAgent) && /Mobile/i.test(navigator.userAgent)) {
      return true;
    }
    return (navigator.maxTouchPoints || 0) > 0
      && Math.min(window.screen.width, window.screen.height) < 768;
  } catch {
    return false;
  }
}

/** Device width in the CURRENT orientation; the projected layout viewport is
 *  a fixed 1040px in both, so the short edge alone would misread landscape. */
function orientedDeviceWidth(): number {
  const screen = window.screen;
  const width = Number(screen?.width) || 0;
  const height = Number(screen?.height) || 0;
  if (!width || !height) return 0;
  const orientation = String(screen?.orientation?.type ?? "");
  const landscape = orientation ? orientation.startsWith("landscape") : width > height;
  return landscape ? Math.max(width, height) : Math.min(width, height);
}

/** Layout px per device dp. `boot.js` is unhashed, so a phone can still be
 *  running a CACHED older copy that pins the layout viewport at the desktop
 *  1040px projection while the freshly hashed bundle assumes device-width.
 *  Returning a hardcoded 1 there drew dp-sized phone metrics into a 1040px
 *  canvas that the browser then shrank onto a ~412px screen, so the whole PWA
 *  came up in miniature (user: PWA 해상도가 아주 조그맣게 나온다). The boot
 *  script records which viewport it chose, so the factor is derived from that
 *  record instead of assumed, and either boot copy renders at native size. */
export function mobileSurfaceScale(): number {
  if (!isMobileRemoteSurface()) return 1;
  try {
    // device-width boot: layout px ARE device dp.
    if (document.documentElement.dataset.mixdogProjection !== "desktop") return 1;
    const layout = Number(document.documentElement.clientWidth) || 0;
    const device = orientedDeviceWidth();
    if (!layout || !device) return 1;
    return Math.max(1, Math.round((layout / device) * 100) / 100);
  } catch {
    return 1;
  }
}

/** Keeps phone markers and projection metrics current across rotation/PWA restore. */
export function installMobileSurfaceMarker(): () => void {
  // `--mx-device-scale` feeds nearly every phone rule, so rewriting it makes
  // the engine recalculate the WHOLE document. Android fires visualViewport
  // resize continuously while the URL bar collapses and the keyboard animates
  // (user: 버튼 반응성이 너무 안 좋다), so the sync is coalesced into one frame
  // and only touches the DOM when a value actually changed.
  let frame = 0;
  let appliedMobile: boolean | null = null;
  let appliedIOS: boolean | null = null;
  let appliedScale = "";
  const apply = (): void => {
    const root = document.documentElement;
    if (!isMobileRemoteSurface()) {
      if (appliedMobile === false) return;
      appliedMobile = false;
      appliedIOS = null;
      appliedScale = "";
      root.removeAttribute("data-mixdog-mobile-tabs");
      root.removeAttribute("data-mixdog-ios-web");
      root.style.removeProperty("--mx-device-scale");
      return;
    }
    const ios = isIOSWebSurface();
    const scale = String(mobileSurfaceScale());
    if (appliedMobile !== true) root.setAttribute("data-mixdog-mobile-tabs", "");
    if (appliedIOS !== ios) {
      if (ios) root.setAttribute("data-mixdog-ios-web", "");
      else root.removeAttribute("data-mixdog-ios-web");
    }
    if (appliedScale !== scale) root.style.setProperty("--mx-device-scale", scale);
    appliedMobile = true;
    appliedIOS = ios;
    appliedScale = scale;
  };
  const sync = (): void => {
    if (frame !== 0) return;
    if (typeof window.requestAnimationFrame !== "function") {
      apply();
      return;
    }
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      apply();
    });
  };
  apply();
  const visual = window.visualViewport;
  window.addEventListener("resize", sync);
  window.addEventListener("orientationchange", sync);
  window.addEventListener("pageshow", sync);
  visual?.addEventListener("resize", sync);
  return () => {
    if (frame !== 0) window.cancelAnimationFrame?.(frame);
    frame = 0;
    window.removeEventListener("resize", sync);
    window.removeEventListener("orientationchange", sync);
    window.removeEventListener("pageshow", sync);
    visual?.removeEventListener("resize", sync);
  };
}
