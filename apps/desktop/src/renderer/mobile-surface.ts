// Phone surface detection + pre-paint root marker. The Chrome-toolbar,
// drawer, and popup CSS all key on `html[data-mixdog-mobile-tabs]` and
// `--mx-device-scale` (native CSS pixels = 1 on every phone). Installing
// them in a mount effect meant the FIRST paint used the desktop grammar
// and the phone visibly re-arranged itself a frame later (user: 처음
// 들어가면 레이아웃 시프트가 심하다). bootstrap.tsx installs the marker
// synchronously BEFORE React renders, so the phone lays out correctly
// exactly once.
import { useSyncExternalStore } from 'react';
import { nativeAppInfo } from '../shared/native-app';
import { remoteWindowInfo } from '../shared/remote-window';
import { isRemoteBrowserRenderer } from './remote-ui-projection';

export function isIOSWebSurface(): boolean {
  if (!isRemoteBrowserRenderer()) return false;
  try {
    return (
      /iPad|iPhone|iPod/iu.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1)
    );
  } catch {
    return false;
  }
}

/** Tablets (iPad, Android tablets) and split-view/slide-over windows below this
 *  layout width use the phone layout; wider ones get the desktop layout. */
const TABLET_PHONE_LAYOUT_MAX_WIDTH = 640;
/** Unidentified coarse-pointer touch devices follow the usual tablet cut-off. */
const COARSE_TOUCH_PHONE_LAYOUT_MAX_WIDTH = 768;

/** Current viewport width in device dp. A stale projected boot pins the layout
 *  viewport at 1040px, so the oriented device width stands in for it there. */
function surfaceViewportWidth(): number {
  if (document.documentElement.dataset.mixdogProjection === 'desktop') {
    const device = orientedDeviceWidth();
    if (device) return device;
  }
  return Number(window.innerWidth) || Number(document.documentElement.clientWidth) || 0;
}

/** Phone layout predicate (layout only; see `isRemoteHostRenderer` for the host role). */
export function isMobileRemoteSurface(): boolean {
  if (!isRemoteBrowserRenderer()) return false;
  try {
    const ua = navigator.userAgent;
    // Phones keep the phone layout in both orientations.
    if (/iPhone|iPod/iu.test(ua) || (/Android/iu.test(ua) && /Mobile/iu.test(ua))) return true;
    const touch = (navigator.maxTouchPoints || 0) > 0;
    if (!touch) return false;
    const width = surfaceViewportWidth();
    if (!width) return false;
    // Tablets: iPad (incl. desktop-class MacIntel UA) and non-"Mobile" Android.
    if (isIOSWebSurface() || /Android/iu.test(ua)) return width < TABLET_PHONE_LAYOUT_MAX_WIDTH;
    // Touch laptops report a fine primary pointer; only coarse-pointer devices qualify.
    if (window.matchMedia?.('(pointer: coarse)').matches !== true) return false;
    return width < COARSE_TOUCH_PHONE_LAYOUT_MAX_WIDTH;
  } catch {
    return false;
  }
}

/** Device class, independent of layout width: phones, tablets and other
 *  coarse-touch devices. Install/entry gates and the service worker key on
 *  this; the phone LAYOUT keys on `isMobileRemoteSurface` (width-based), so a
 *  landscape iPad gets the desktop layout yet is still an installable device. */
export function isMobileDeviceSurface(): boolean {
  if (!isRemoteBrowserRenderer()) return false;
  try {
    if (/iPhone|iPod|Android/iu.test(navigator.userAgent) || isIOSWebSurface()) return true;
    return (navigator.maxTouchPoints || 0) > 0 && window.matchMedia?.('(pointer: coarse)').matches === true;
  } catch {
    return false;
  }
}

/** Subscribe to anything that can flip the phone/tablet layout at runtime. */
export function subscribeMobileSurface(listener: () => void): () => void {
  const visual = window.visualViewport;
  window.addEventListener('resize', listener);
  window.addEventListener('orientationchange', listener);
  visual?.addEventListener('resize', listener);
  return () => {
    window.removeEventListener('resize', listener);
    window.removeEventListener('orientationchange', listener);
    visual?.removeEventListener('resize', listener);
  };
}

/** Reactive `isMobileRemoteSurface()`: re-renders on rotation / window resize. */
export function useMobileRemoteSurface(): boolean {
  return useSyncExternalStore(subscribeMobileSurface, isMobileRemoteSurface, () => false);
}

export function isInstalledWebAppSurface(): boolean {
  if (!isRemoteBrowserRenderer()) return false;
  try {
    return (
      window.matchMedia?.('(display-mode: standalone)').matches === true ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

/** The relay UI is a phone/tablet installed app or a second PC's dedicated
 * Mixdog remote window (its own persistent container, opened on purpose) —
 * never a browser tab or a desktop-installed PWA. Every entry gate shares this
 * single predicate. */
export function isInstalledMobileWebAppSurface(): boolean {
  if (remoteWindowInfo() || nativeAppInfo()) return true;
  return isMobileDeviceSurface() && isInstalledWebAppSurface();
}

/** Device width in the CURRENT orientation; the projected layout viewport is
 *  a fixed 1040px in both, so the short edge alone would misread landscape. */
function orientedDeviceWidth(): number {
  const screen = window.screen;
  const width = Number(screen?.width) || 0;
  const height = Number(screen?.height) || 0;
  if (!width || !height) return 0;
  const orientation = String(screen?.orientation?.type ?? '');
  const landscape = orientation ? orientation.startsWith('landscape') : width > height;
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
    if (document.documentElement.dataset.mixdogProjection !== 'desktop') return 1;
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
  let appliedScale = '';
  const apply = (): void => {
    const root = document.documentElement;
    if (!isMobileRemoteSurface()) {
      if (appliedMobile === false) return;
      appliedMobile = false;
      appliedIOS = null;
      appliedScale = '';
      root.removeAttribute('data-mixdog-mobile-tabs');
      root.removeAttribute('data-mixdog-ios-web');
      root.style.removeProperty('--mx-device-scale');
      return;
    }
    const ios = isIOSWebSurface();
    const scale = String(mobileSurfaceScale());
    if (appliedMobile !== true) root.setAttribute('data-mixdog-mobile-tabs', '');
    if (appliedIOS !== ios) {
      if (ios) root.setAttribute('data-mixdog-ios-web', '');
      else root.removeAttribute('data-mixdog-ios-web');
    }
    if (appliedScale !== scale) root.style.setProperty('--mx-device-scale', scale);
    appliedMobile = true;
    appliedIOS = ios;
    appliedScale = scale;
  };
  const sync = (): void => {
    if (frame !== 0) return;
    if (typeof window.requestAnimationFrame !== 'function') {
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
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
  window.addEventListener('pageshow', sync);
  visual?.addEventListener('resize', sync);
  return () => {
    if (frame !== 0) window.cancelAnimationFrame?.(frame);
    frame = 0;
    window.removeEventListener('resize', sync);
    window.removeEventListener('orientationchange', sync);
    window.removeEventListener('pageshow', sync);
    visual?.removeEventListener('resize', sync);
  };
}
