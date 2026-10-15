import { isMobileDeviceSurface, isMobileRemoteSurface } from './mobile-surface';
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
// A non-passive window listener makes every wheel scroll wait for the main
// thread, so only touch-class devices (the only ones that can take the phone
// layout) register it. The host's own window pins zoom in the main process
// (zoom factor and visual zoom limits); remote PCs keep native zoom anyway.
if (isMobileDeviceSurface()) {
  window.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey && zoomLocked()) event.preventDefault();
    },
    { passive: false }
  );
}
const preventGesture = (event: Event): void => {
  if (zoomLocked()) event.preventDefault();
};
document.addEventListener('gesturestart', preventGesture, { passive: false });
document.addEventListener('gesturechange', preventGesture, { passive: false });
document.addEventListener('gestureend', preventGesture, { passive: false });

// No document touch listener, iOS included: a non-passive one made every
// scroll wait for the main thread before it could start (the whole page
// became a blocking touch region). Pinch stays refused by the viewport meta
// and the root's `touch-action: pan-x pan-y`; iOS Safari, which ignores
// `user-scalable=no`, is held by the gesture listeners above.
