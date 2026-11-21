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

const zoomLocked = (): boolean => !isRemoteHostRenderer() || isMobileRemoteSurface();

window.addEventListener('keydown', (event) => {
  if (!zoomLocked()) return;
  const zoomKey = event.key === '=' || event.key === '+' || event.key === '-' || event.key === '0';
  if (!event.altKey && zoomKey && (event.ctrlKey || event.metaKey)) event.preventDefault();
});

// Chromium reports trackpad pinch as Ctrl+wheel (Safari: gestures). A non-passive window wheel listener holds every scroll for the main thread, so only touch-class devices register it.
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

// iOS Safari ignores `user-scalable=no`, so the gesture listeners above hold it; a non-passive document touch listener would make every scroll wait for the main thread.
