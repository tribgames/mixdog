/**
 * mouse-input/wheel-router.mjs — wheel half of the SGR mouse channel.
 *
 * One responsibility: route a wheel notch. Ctrl+wheel is handed to the
 * terminal's own font zoom (after settling any in-flight drag), an open slash
 * palette consumes the notch as list navigation, an overlay can block global
 * transcript scroll, and everything else becomes an accelerated transcript
 * scroll. The button-gesture (text selection) half stays in use-mouse-input.mjs.
 */
import { overlayBlocksGlobalTranscriptScroll } from '../slash-commands.mjs';
import {
  WHEEL_ACCEL_ENABLED,
  WHEEL_ACCEL_IDLE_MS,
  WHEEL_STEP_MAX_ROWS,
  WHEEL_STEP_ROWS,
} from '../transcript-window.mjs';
import { MOUSE_CTRL_MASK } from './sgr-buttons.mjs';

// Wheel modifier: wheel arrives as a ParsedKey {name:'wheelup'|'wheeldown',
// sequence}. It has NO button field, so read the ctrl bit (16) from the SGR
// button in the raw sequence `\x1b[<b;col;row…`. This is the one place the raw
// sequence is still parsed; ParsedMouse (click/drag) carries button/col/row/
// action pre-parsed and needs no regex.
const WHEEL_SGR = /\x1b\[<(\d+);/;

export function createWheelRouter({
  dragRef,
  slashPaletteRef,
  scrollFocusRef,
  wheelAccelRef,
  setSlashIndex,
  queueScrollCoalesced,
  passthroughCtrlWheelZoom,
  finalizeActiveDrag,
  finishWindowsMouseGesture,
  stopEdgeAutoscroll,
}) {
  return (event) => {
    let up = 0;
    let down = 0;
    const name = event.name;
    if (name !== 'wheelup' && name !== 'wheeldown') return;
    const seq = typeof event.sequence === 'string' ? event.sequence : '';
    const wm = WHEEL_SGR.exec(seq);
    const ctrl = wm ? (Number(wm[1]) & MOUSE_CTRL_MASK) !== 0 : false;
    if (ctrl) {
      // Zoom passthrough disables mouse tracking for ~700ms, during which
      // the button-release event may never arrive — leaving the drag stuck
      // active and the edge-autoscroll interval firing forever. Finalize
      // the in-flight drag from its last known point (same path as a real
      // release: final applySelectionRect + measured-rows reconcile) so
      // Ctrl+C still copies the full text, then hand the wheel to the
      // terminal's font zoom. stopEdgeAutoscroll is folded into finalize.
      if (dragRef.current.active) {
        const last = dragRef.current.last || {};
        finalizeActiveDrag(Number(last.x) || 0, Number(last.y) || 0);
        finishWindowsMouseGesture();
      } else {
        stopEdgeAutoscroll();
      }
      passthroughCtrlWheelZoom();
      return;
    }
    if (name === 'wheelup') up += 1;
    else down += 1;
    // Shared wheel-scroll dispatch (identical slash-palette/overlay/scroll
    // routing for every wheel source).
    if (up !== 0 || down !== 0) {
      const palette = slashPaletteRef.current;
      if (!dragRef.current.active && palette.open && palette.count > 0) {
        const step = down - up;
        if (step !== 0) {
          setSlashIndex((index) => Math.max(0, Math.min(palette.count - 1, index + step)));
        }
        return;
      }
      if (overlayBlocksGlobalTranscriptScroll(scrollFocusRef.current)) return;
      // Wheel while a selection is live (mid-drag OR after release) scrolls
      // the transcript instead of being dropped: scrollTranscriptRows'
      // active-drag branch rebuilds the rect (anchor→last), the released
      // branch shifts it — both keep the highlight and stitch-harvest the
      // rows that scroll off (ref ScrollKeybindingHandler wheel path).
      const wheelDir = up - down;
      const nowWheel = Date.now();
      const accel = wheelAccelRef.current;
      if (!WHEEL_ACCEL_ENABLED || accel.dir !== wheelDir || nowWheel - accel.t > WHEEL_ACCEL_IDLE_MS) {
        accel.step = WHEEL_STEP_ROWS;
      } else {
        accel.step = Math.min(WHEEL_STEP_MAX_ROWS, accel.step + WHEEL_STEP_ROWS);
      }
      accel.dir = wheelDir;
      accel.t = nowWheel;
      queueScrollCoalesced(wheelDir * accel.step);
    }
  };
}
