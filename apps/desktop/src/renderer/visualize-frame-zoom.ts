// Frame-to-parent zoom input bridge for REMOTE Visualize pages.
//
// A page in a remote client runs in an opaque-origin frame (see
// page-fetch-bridge.ts), which takes Ctrl+wheel and Ctrl/Cmd + = / − / 0 for
// itself - the parent document never sees them, and nothing like the desktop's
// main-process forwarding exists in a browser. A script injected into the
// page therefore relays exactly those gestures, and a phone's two-finger
// pinch, to the parent, which zooms the panel through the same target
// registry as every other zoom input.
//
// Scope: only the live (script-running) remote page frame gets the script and
// only this module's listener accepts its messages - from that frame's own
// window, with the three zoom inputs and finite numbers, nothing else. A page
// that handles the gesture itself (preventDefault) is left alone.
import { withHeadScript } from '../shared/sandbox-storage-shim';
import { framePointInWindow, pinchGeometry } from './visualize-zoom';
import { dispatchZoomAt, dispatchZoomKey, type ZoomKey } from './zoom-target';

export const FRAME_ZOOM_REQUEST = 'mixdog-page-zoom';

/** The in-page half (plain ES5, no `</script`). */
export function frameZoomBridgeScript(): string {
  return `(function () {
  var parentWindow = window.parent;
  if (!parentWindow || parentWindow === window) return;
  function send(message) {
    message.type = ${JSON.stringify(FRAME_ZOOM_REQUEST)};
    parentWindow.postMessage(message, '*');
  }
  window.addEventListener('wheel', function (event) {
    if (event.defaultPrevented || !event.ctrlKey) return;
    event.preventDefault();
    send({ zoom: event.deltaY > 0 ? 'out' : 'in', x: event.clientX, y: event.clientY, deltaY: event.deltaY, deltaMode: event.deltaMode });
  }, { passive: false });
  window.addEventListener('keydown', function (event) {
    if (event.defaultPrevented || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    var key = event.key;
    var zoom = key === '=' || key === '+' ? 'in' : key === '-' || key === '_' ? 'out' : key === '0' ? 'reset' : '';
    if (!zoom) return;
    event.preventDefault();
    send({ zoom: zoom });
  });
  // A two-finger pinch zooms the panel (the app's viewport never pinch-zooms);
  // one finger keeps scrolling the page.
  // The fingers go out as they are (frame px); the parent measures the spread
  // in its own px, since the panel draws this frame scaled by its zoom.
  function fingers(phase, touches) {
    var a = touches[0], b = touches[1];
    send({ zoom: 'in', pinch: phase, x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2, x1: a.clientX, y1: a.clientY, x2: b.clientX, y2: b.clientY });
  }
  // A page that turned off pinch-zoom where the fingers are (touch-action, as
  // a 3D canvas's orbit controls do) handles the pinch itself.
  function pagePinches(node) {
    for (; node && node.nodeType === 1; node = node.parentNode) {
      var action = getComputedStyle(node).getPropertyValue('touch-action');
      if (action && action !== 'auto' && action !== 'manipulation' && action.indexOf('pinch-zoom') < 0) return true;
    }
    return false;
  }
  var owned = false;
  // Two fingers down (or one lifted of three) starts a pinch from where they are.
  function reset(event) {
    if (event.touches.length !== 2) return;
    owned = pagePinches(event.touches[0].target) || pagePinches(event.touches[1].target);
    if (!owned) fingers('start', event.touches);
  }
  window.addEventListener('touchstart', reset, { passive: true });
  window.addEventListener('touchend', reset, { passive: true });
  window.addEventListener('touchcancel', reset, { passive: true });
  window.addEventListener('touchmove', function (event) {
    if (owned || event.defaultPrevented || event.touches.length !== 2) return;
    event.preventDefault();
    fingers('move', event.touches);
  }, { passive: false });
})();`;
}

/** `html` with the bridge in its head. */
export function withFrameZoomBridge(html: string): string {
  return withHeadScript(html, frameZoomBridgeScript());
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isZoomKey = (value: unknown): value is ZoomKey => value === 'in' || value === 'out' || value === 'reset';

/** Applies `frame`'s relayed zoom gestures. A wheel's place is in the frame's
 *  own pixels; the panel may draw the frame scaled (its zoom), so the place is
 *  mapped through the frame's drawn size. Returns the cleanup. */
export function serveFrameZoom(frame: HTMLIFrameElement): () => void {
  // The pinch in progress: the fingers' last spread, in window px.
  let spread = 0;
  const onPinch = (data: Record<string, unknown>): void => {
    const { x1, y1, x2, y2 } = data;
    if (!finite(x1) || !finite(y1) || !finite(x2) || !finite(y2)) return;
    const next = pinchGeometry(
      (point) => framePointInWindow(frame, point),
      { clientX: x1, clientY: y1 },
      { clientX: x2, clientY: y2 }
    );
    const ratio = data.pinch === 'move' && spread > 0 && next.spread > 0 ? next.spread / spread : 1;
    spread = next.spread;
    // A step is a bounded factor: a page cannot zoom by more per message.
    if (Math.abs(ratio - 1) > 0.002 && ratio > 0.5 && ratio < 2) {
      dispatchZoomAt(ratio > 1 ? 'in' : 'out', next.at, undefined, ratio);
    }
  };
  const onMessage = (event: MessageEvent): void => {
    const target = frame.contentWindow;
    if (!target || event.source !== target) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || data.type !== FRAME_ZOOM_REQUEST || !isZoomKey(data.zoom)) return;
    if (data.pinch === 'start' || data.pinch === 'move') {
      onPinch(data);
      return;
    }
    if (!finite(data.x) || !finite(data.y)) {
      dispatchZoomKey(data.zoom);
      return;
    }
    const wheel =
      finite(data.deltaY) && finite(data.deltaMode) ? { deltaY: data.deltaY, deltaMode: data.deltaMode } : undefined;
    dispatchZoomAt(data.zoom, framePointInWindow(frame, { x: data.x, y: data.y }), wheel);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
