import { isRemoteBrowserRenderer } from "./remote-ui-projection";

const MAX_ZOOM = 10;
const MIN_ZOOM = 0.2;
const STEP = 0.2;
const remoteWebSurface = isRemoteBrowserRenderer();

const clampZoom = (value: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));

let requestedZoom = 1;

function clearRemoteWebZoom(): void {
  requestedZoom = 1;
  document.documentElement.style.zoom = '';
  document.documentElement.style.removeProperty('zoom');
  try { window.localStorage.removeItem('mixdog.web-zoom'); } catch { /* private storage */ }
}

async function applyZoom(value: number) {
  if (remoteWebSurface) {
    clearRemoteWebZoom();
    return;
  }
  const api = window.mixdogDesktop;
  const next = clampZoom(value);
  requestedZoom = next;
  if (typeof api?.setZoomFactor !== 'function') {
    if (next === 1) document.documentElement.style.removeProperty('zoom');
    else document.documentElement.style.zoom = String(next);
    try { window.localStorage.setItem('mixdog.web-zoom', String(next)); } catch { /* session only */ }
    return;
  }
  try {
    requestedZoom = clampZoom(await api.setZoomFactor(next));
  } catch {
    // Keep the current renderer scale when persistence is unavailable.
  }
}

export const resetZoom = () => applyZoom(1);
export const zoomIn = () => applyZoom(requestedZoom + STEP);
export const zoomOut = () => applyZoom(requestedZoom - STEP);

const api = window.mixdogDesktop;
if (remoteWebSurface) {
  clearRemoteWebZoom();
} else {
  if (typeof api?.onZoomFactorChanged === 'function') {
    api.onZoomFactorChanged((factor) => { requestedZoom = clampZoom(factor); });
  }
  if (typeof api?.getZoomFactor === 'function') {
    void api.getZoomFactor()
      .then((factor) => { requestedZoom = clampZoom(factor); })
      .catch(() => {});
  } else {
    try {
      const stored = Number(window.localStorage.getItem('mixdog.web-zoom') || '');
      if (stored) void applyZoom(stored);
    } catch { /* default 1 */ }
  }
}

window.addEventListener('keydown', (event) => {
  const zoomKey = event.key === '=' || event.key === '+'
    || event.key === '-' || event.key === '0';
  if (remoteWebSurface) {
    if (!event.altKey && zoomKey && (event.ctrlKey || event.metaKey)) event.preventDefault();
    return;
  }
  const command = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey;
  if (!command || event.altKey || !zoomKey) return;
  event.preventDefault();
  if (event.key === '=' || event.key === '+') {
    void zoomIn();
  } else if (event.key === '-') {
    void zoomOut();
  } else if (event.key === '0') {
    void resetZoom();
  }
});

if (remoteWebSurface) {
  // Trackpad pinch is exposed as a Ctrl/Cmd wheel in Chromium. Safari's
  // gesture events and multi-touch fallback cover installed iOS PWAs where
  // user-scalable=no alone is intentionally not authoritative.
  window.addEventListener('wheel', (event) => {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  }, { passive: false });
  const preventGesture = (event: Event): void => event.preventDefault();
  document.addEventListener('gesturestart', preventGesture, { passive: false });
  document.addEventListener('gesturechange', preventGesture, { passive: false });
  document.addEventListener('gestureend', preventGesture, { passive: false });
  const preventMultiTouch = (event: TouchEvent): void => {
    if (event.touches.length > 1) event.preventDefault();
  };
  document.addEventListener('touchstart', preventMultiTouch, { passive: false });
  document.addEventListener('touchmove', preventMultiTouch, { passive: false });
}
