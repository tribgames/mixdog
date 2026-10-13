import { isIOSWebSurface, isMobileRemoteSurface } from './mobile-surface';
import { isRemoteHostRenderer } from './remote-ui-projection';

// The application shell stays at 100%, including legacy web profiles.
document.documentElement.style.zoom = '';
document.documentElement.style.removeProperty('zoom');
try {
  window.localStorage.removeItem('mixdog.web-zoom');
} catch {
  /* private storage */
}

// Non-phone remote surfaces (desktop browsers, a second PC's Electron app,
// tablets) keep native Ctrl/pinch zoom; the Electron host and phones lock it.
// The layout can flip between phone and tablet at runtime (rotation, split
// view), so every rule is evaluated per event instead of once at load.
const zoomLocked = (): boolean => !isRemoteHostRenderer() || isMobileRemoteSurface();

window.addEventListener('keydown', (event) => {
  if (!zoomLocked()) return;
  const zoomKey = event.key === '=' || event.key === '+' || event.key === '-' || event.key === '0';
  if (!event.altKey && zoomKey && (event.ctrlKey || event.metaKey)) event.preventDefault();
});

// Chromium represents trackpad pinch as Ctrl+wheel. Safari uses gestures.
window.addEventListener(
  'wheel',
  (event) => {
    if (event.ctrlKey && zoomLocked()) event.preventDefault();
  },
  { passive: false }
);
const preventGesture = (event: Event): void => {
  if (zoomLocked()) event.preventDefault();
};
document.addEventListener('gesturestart', preventGesture, { passive: false });
document.addEventListener('gesturechange', preventGesture, { passive: false });
document.addEventListener('gestureend', preventGesture, { passive: false });

// iOS WebKit ignores `user-scalable=no`, so a phone there blocks pinch by
// cancelling multi-touch. Everywhere else the viewport meta and the root's
// `touch-action: pan-x pan-y` already refuse pinch-zoom, and a non-passive
// document touch listener only made every scroll wait for the main thread
// before it could start (the whole page became a blocking touch region).
const preventMultiTouch = (event: TouchEvent): void => {
  if (event.touches.length > 1 && isMobileRemoteSurface()) event.preventDefault();
};
if (isIOSWebSurface()) {
  document.addEventListener('touchstart', preventMultiTouch, { passive: false });
  document.addEventListener('touchmove', preventMultiTouch, { passive: false });
}
