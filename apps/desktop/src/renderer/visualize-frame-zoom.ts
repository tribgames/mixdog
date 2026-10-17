// Frame-to-parent zoom input bridge for REMOTE Visualize pages.
//
// A page in a remote client runs in an opaque-origin frame (see
// page-fetch-bridge.ts), which takes Ctrl+wheel and Ctrl/Cmd + = / − / 0 for
// itself - the parent document never sees them, and nothing like the desktop's
// main-process forwarding exists in a browser. A script injected into the
// page therefore relays exactly those gestures to the parent, which zooms the
// panel through the same target registry as every other zoom input.
//
// Scope: only the live (script-running) remote page frame gets the script and
// only this module's listener accepts its messages - from that frame's own
// window, with the three zoom inputs and finite numbers, nothing else. A page
// that handles the gesture itself (preventDefault) is left alone.
import { withHeadScript } from '../shared/sandbox-storage-shim';
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
  const onMessage = (event: MessageEvent): void => {
    const target = frame.contentWindow;
    if (!target || event.source !== target) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || data.type !== FRAME_ZOOM_REQUEST || !isZoomKey(data.zoom)) return;
    if (!finite(data.x) || !finite(data.y)) {
      dispatchZoomKey(data.zoom);
      return;
    }
    const box = frame.getBoundingClientRect();
    const scaleX = frame.clientWidth > 0 ? box.width / frame.clientWidth : 1;
    const scaleY = frame.clientHeight > 0 ? box.height / frame.clientHeight : 1;
    const wheel =
      finite(data.deltaY) && finite(data.deltaMode) ? { deltaY: data.deltaY, deltaMode: data.deltaMode } : undefined;
    dispatchZoomAt(data.zoom, { x: box.left + data.x * scaleX, y: box.top + data.y * scaleY }, wheel);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
