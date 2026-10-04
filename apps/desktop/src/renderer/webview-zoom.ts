import { isRemoteBrowserRenderer } from './remote-ui-projection';

// The application shell stays at 100%, including legacy web profiles.
document.documentElement.style.zoom = '';
document.documentElement.style.removeProperty('zoom');
try {
  window.localStorage.removeItem('mixdog.web-zoom');
} catch {
  /* private storage */
}

window.addEventListener('keydown', (event) => {
  const zoomKey = event.key === '=' || event.key === '+' || event.key === '-' || event.key === '0';
  if (!event.altKey && zoomKey && (event.ctrlKey || event.metaKey)) event.preventDefault();
});

// Chromium represents trackpad pinch as Ctrl+wheel. Safari uses gestures.
window.addEventListener(
  'wheel',
  (event) => {
    if (event.ctrlKey) event.preventDefault();
  },
  { passive: false }
);
const preventGesture = (event: Event): void => event.preventDefault();
document.addEventListener('gesturestart', preventGesture, { passive: false });
document.addEventListener('gesturechange', preventGesture, { passive: false });
document.addEventListener('gestureend', preventGesture, { passive: false });

if (isRemoteBrowserRenderer()) {
  const preventMultiTouch = (event: TouchEvent): void => {
    if (event.touches.length > 1) event.preventDefault();
  };
  document.addEventListener('touchstart', preventMultiTouch, { passive: false });
  document.addEventListener('touchmove', preventMultiTouch, { passive: false });
}
