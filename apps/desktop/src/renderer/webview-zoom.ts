const MAX_ZOOM = 10;
const MIN_ZOOM = 0.2;
const STEP = 0.2;

const clampZoom = (value: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));

let requestedZoom = 1;

async function applyZoom(value: number) {
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

window.addEventListener('keydown', (event) => {
  const command = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey;
  if (!command || event.altKey) return;
  if (event.key === '=' || event.key === '+') {
    event.preventDefault();
    void zoomIn();
  } else if (event.key === '-') {
    event.preventDefault();
    void zoomOut();
  } else if (event.key === '0') {
    event.preventDefault();
    void resetZoom();
  }
});
