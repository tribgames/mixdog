import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { watchBrowserForegroundReturns } from './browser-foreground-lifecycle';
import type { BrowserPageElement } from './browser-page-client';
import { browserViewportZoom, type BrowserViewportPreset } from './browser-viewport-mode';
import { readBrowserZoom, writeBrowserZoom } from './browser-zoom-level';

/** Keeps the guest's zoom factor in step with the surface: the preset
 *  baseline, the user's zoom, pane resizes and foreground returns. Returns
 *  its own teardown. */
function startBrowserZoomSync({
  view,
  desiredZoom,
  fixedViewport,
  viewportPreset,
  zoomLevel,
  configureViewportPreset,
}: {
  view: BrowserPageElement;
  desiredZoom: { current: number };
  fixedViewport: boolean;
  viewportPreset: BrowserViewportPreset;
  zoomLevel: number;
  configureViewportPreset(preset: BrowserViewportPreset, reload: boolean): Promise<boolean>;
}) {
  let disposed = false;
  let restoreFrame = 0;
  const applyZoom = () => {
    try {
      view.setZoomFactor(desiredZoom.current);
    } catch {
      /* guest not attached yet; dom-ready reapplies */
    }
  };
  const syncZoom = (force = false) => {
    const zoom = fixedViewport ? zoomLevel : browserViewportZoom(viewportPreset, view.clientWidth, zoomLevel);
    const changed = Math.abs(zoom - desiredZoom.current) >= 0.01;
    if (changed) desiredZoom.current = zoom;
    if (changed || force) applyZoom();
  };
  const configureGuest = async () => {
    const configured = await configureViewportPreset(viewportPreset, false);
    if (!disposed && configured) syncZoom(true);
  };
  const restoreVisibleGuest = () => {
    window.cancelAnimationFrame(restoreFrame);
    restoreFrame = window.requestAnimationFrame(() => syncZoom(true));
  };
  const observer = new ResizeObserver(() => syncZoom());
  observer.observe(view);
  const stopForegroundReturnReporting = watchBrowserForegroundReturns(window, document, restoreVisibleGuest);
  const onGuestReady = () => void configureGuest();
  view.addEventListener('did-attach', onGuestReady);
  view.addEventListener('dom-ready', onGuestReady);
  view.addEventListener('did-navigate', applyZoom);
  void configureGuest();
  return () => {
    disposed = true;
    window.cancelAnimationFrame(restoreFrame);
    stopForegroundReturnReporting();
    observer.disconnect();
    view.removeEventListener('did-attach', onGuestReady);
    view.removeEventListener('dom-ready', onGuestReady);
    view.removeEventListener('did-navigate', applyZoom);
  };
}

/** Normal browsing preserves the user's zoom as the pane resizes. Fit is an
 *  explicit mode; device presets retain their actual UA/touch/device metrics. */
export function useBrowserZoomSync({
  webviewRef,
  active,
  fixedViewport,
  viewportPreset,
  zoomLevel,
  configureViewportPreset,
}: {
  webviewRef: RefObject<BrowserPageElement | null>;
  active: boolean;
  fixedViewport: boolean;
  viewportPreset: BrowserViewportPreset;
  zoomLevel: number;
  configureViewportPreset(preset: BrowserViewportPreset, reload: boolean): Promise<boolean>;
}) {
  const desiredZoom = useRef(1);
  useEffect(() => {
    if (!active) return undefined;
    const view = webviewRef.current;
    if (!view) return undefined;
    return startBrowserZoomSync({
      view,
      desiredZoom,
      fixedViewport,
      viewportPreset,
      zoomLevel,
      configureViewportPreset,
    });
  }, [webviewRef, active, configureViewportPreset, fixedViewport, viewportPreset, zoomLevel]);
}

/** User zoom on top of the surface baseline (auto-fit factor, or 1 inside a
 *  device frame), remembered per session, and the page's own shortcuts: the
 *  address shortcut focuses the address field, the zoom ones step the zoom. */
export function useBrowserZoom(
  sessionId: string,
  webviewRef: RefObject<BrowserPageElement | null>,
  addressRef: RefObject<HTMLInputElement | null>
) {
  // Page zoom in both modes: inside a frame the page grows and scrolls within
  // it, the way a phone's own browser zooms.
  const [zoomLevel, setZoomLevel] = useState(() => readBrowserZoom(window.localStorage, sessionId));
  const changeZoomLevel = useCallback(
    (level: number) => {
      setZoomLevel(writeBrowserZoom(window.localStorage, sessionId, level));
    },
    [sessionId]
  );
  useEffect(() => {
    const view = webviewRef.current;
    if (!view) return;
    const shortcut = (event: Event) => {
      const action = (event as Event & { shortcut: string }).shortcut;
      if (action === 'address') {
        addressRef.current?.focus();
        addressRef.current?.select();
      } else if (['zoom-in', 'zoom-out', 'zoom-reset'].includes(action)) {
        const zoomFactor = action === 'zoom-in' ? 1.1 : 1 / 1.1;
        setZoomLevel((previous) =>
          writeBrowserZoom(window.localStorage, sessionId, action === 'zoom-reset' ? 1 : previous * zoomFactor)
        );
      }
    };
    view.addEventListener('browser-shortcut', shortcut);
    return () => view.removeEventListener('browser-shortcut', shortcut);
  }, [sessionId, webviewRef, addressRef]);
  return { zoomLevel, changeZoomLevel };
}
