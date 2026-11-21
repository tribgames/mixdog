import { useSyncExternalStore } from 'react';
import { nativeAppInfo } from '../shared/native-app';
import { remoteWindowInfo } from '../shared/remote-window';
import { isIosDevice, isPhoneDevice, isTouchDevice, readSurfaceProbe, usesPhoneLayout } from '../shared/surface-class';
import { isRemoteBrowserRenderer } from './remote-ui-projection';

/** A remote-browser-only check: false elsewhere, and false when probing the
 *  host environment throws. */
function inRemoteBrowser(read: () => boolean): boolean {
  if (!isRemoteBrowserRenderer()) return false;
  try {
    return read();
  } catch {
    return false;
  }
}

export function isIOSWebSurface(): boolean {
  return inRemoteBrowser(() => isIosDevice(readSurfaceProbe(navigator, window)));
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

function subscribePhoneMarker(listener: () => void): () => void {
  // The document's own realm: the observer must come from the window that owns the root.
  const Observer = (document.defaultView as Window & typeof globalThis).MutationObserver;
  const observer = new Observer(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mixdog-mobile-tabs'] });
  return () => observer.disconnect();
}

/** Reactive `isPhoneSurfaceMarked()`: follows the marker as the layout flips. */
export function usePhoneSurfaceMarked(): boolean {
  return useSyncExternalStore(subscribePhoneMarker, isPhoneSurfaceMarked, () => false);
}

/** Phone layout predicate (layout only; see `isRemoteHostRenderer` for the host role). */
export function isMobileRemoteSurface(): boolean {
  return inRemoteBrowser(() => {
    const probe = readSurfaceProbe(navigator, window);
    return isPhoneDevice(probe) || usesPhoneLayout(probe, surfaceViewportWidth());
  });
}

/** Device class, independent of layout width: phones, tablets and other
 *  coarse-touch devices. Install/entry gates and the service worker key on
 *  this; the phone LAYOUT keys on `isMobileRemoteSurface` (width-based), so a
 *  landscape iPad gets the desktop layout yet is still an installable device. */
export function isMobileDeviceSurface(): boolean {
  return inRemoteBrowser(() => isTouchDevice(readSurfaceProbe(navigator, window)));
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
  return inRemoteBrowser(
    () =>
      window.matchMedia?.('(display-mode: standalone)').matches === true ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
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
  return inRemoteBrowser(() => localStorage.getItem(DIRECT_BROWSER_KEY) === '1');
}

/** Keeps the phone markers current across rotation/PWA restore. */
export function installMobileSurfaceMarker(): () => void {
  // Android fires visualViewport resize continuously while the URL bar collapses and the keyboard animates; toggling the marker recalculates the whole document, so sync is coalesced into one frame and writes the DOM only on change.
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
