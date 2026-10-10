import { isMobileRemoteSurface } from './mobile-surface';
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
const zoomLocked = (): boolean => !(isRemoteHostRenderer() && !isMobileRemoteSurface());

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

const preventMultiTouch = (event: TouchEvent): void => {
  if (event.touches.length > 1 && isMobileRemoteSurface()) event.preventDefault();
};
document.addEventListener('touchstart', preventMultiTouch, { passive: false });
document.addEventListener('touchmove', preventMultiTouch, { passive: false });
