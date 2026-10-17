// Phone surface detection + pre-paint root marker. The Chrome-toolbar,
// drawer, and popup CSS all key on `html[data-mixdog-mobile-tabs]`; every
// browser lays out at device-width, so phone CSS is written in native CSS
// pixels. Installing the marker in a mount effect meant the FIRST paint used the desktop grammar
// and the phone visibly re-arranged itself a frame later (user: 처음
// 들어가면 레이아웃 시프트가 심하다). bootstrap.tsx installs the marker
// synchronously BEFORE React renders, so the phone lays out correctly
// exactly once.
import { useSyncExternalStore } from 'react';
import { nativeAppInfo } from '../shared/native-app';
import { remoteWindowInfo } from '../shared/remote-window';
import { isIosDevice, isTouchDevice, readSurfaceProbe, usesPhoneLayout } from '../shared/surface-class';
import { isRemoteBrowserRenderer } from './remote-ui-projection';

export function isIOSWebSurface(): boolean {
  if (!isRemoteBrowserRenderer()) return false;
  try {
    return isIosDevice(readSurfaceProbe(navigator, window));
  } catch {
    return false;
  }
}

/** Current layout viewport width (device-width on every browser). */
function surfaceViewportWidth(): number {
  return Number(window.innerWidth) || Number(document.documentElement.clientWidth) || 0;
}

/** True when the pre-paint phone marker is on the root. Desktop keyboard hints
 *  (also hidden by one CSS rule for static markup) key on this. */
export function isPhoneSurfaceMarked(): boolean {
  return document.documentElement.hasAttribute('data-mixdog-mobile-tabs');
}

/** Phone layout predicate (layout only; see `isRemoteHostRenderer` for the host role). */
export function isMobileRemoteSurface(): boolean {
  if (!isRemoteBrowserRenderer()) return false;
  try {
    return usesPhoneLayout(readSurfaceProbe(navigator, window), surfaceViewportWidth());
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
    return isTouchDevice(readSurfaceProbe(navigator, window));
  } catch {
    return false;
  }
}

/** Subscribe to anything that can flip the phone/tablet layout at runtime. */
function subscribeMobileSurface(listener: () => void): () => void {
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
  if (isDirectBrowserSurface()) return true;
  return isMobileDeviceSurface() && isInstalledWebAppSurface();
}

// Pairing v2: a browser tab (phone or PC) may hold a credential and run the
// app itself, with no install, once its host said it supports that. The mark
// lives in this origin's storage next to the credential it enables, so an old
// host (which never gets the mark) keeps the install-gated behaviour.
const DIRECT_BROWSER_KEY = 'mixdog.directBrowser';

export function markDirectBrowserSurface(): void {
  try {
    localStorage.setItem(DIRECT_BROWSER_KEY, '1');
  } catch {
    /* private storage: the tab cannot hold a credential anyway */
  }
}

function isDirectBrowserSurface(): boolean {
  if (!isRemoteBrowserRenderer()) return false;
  try {
    return localStorage.getItem(DIRECT_BROWSER_KEY) === '1';
  } catch {
    return false;
  }
}

/** Keeps the phone markers current across rotation/PWA restore. */
export function installMobileSurfaceMarker(): () => void {
  // The phone marker feeds nearly every phone rule, so toggling it makes the
  // engine recalculate the WHOLE document. Android fires visualViewport
  // resize continuously while the URL bar collapses and the keyboard animates
  // (user: 버튼 반응성이 너무 안 좋다), so the sync is coalesced into one frame
  // and only touches the DOM when a value actually changed.
  let frame = 0;
  let appliedMobile: boolean | null = null;
  let appliedIOS: boolean | null = null;
  const apply = (): void => {
    const root = document.documentElement;
    if (!isMobileRemoteSurface()) {
      if (appliedMobile === false) return;
      appliedMobile = false;
      appliedIOS = null;
      root.removeAttribute('data-mixdog-mobile-tabs');
      root.removeAttribute('data-mixdog-ios-web');
      return;
    }
    const ios = isIOSWebSurface();
    if (appliedMobile !== true) root.setAttribute('data-mixdog-mobile-tabs', '');
    if (appliedIOS !== ios) {
      if (ios) root.setAttribute('data-mixdog-ios-web', '');
      else root.removeAttribute('data-mixdog-ios-web');
    }
    appliedMobile = true;
    appliedIOS = ios;
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
