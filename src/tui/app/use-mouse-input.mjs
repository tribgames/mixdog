/**
 * use-mouse-input.mjs — SGR mouse handling hook for the App shell.
 *
 * Covers the ctrl+wheel zoom passthrough and the SGR input effect (wheel
 * scroll routing, prompt/transcript/status text selection with word/line
 * multi-click, drag auto-scroll). Shared App state is injected via
 * refs/callbacks; gesture timers and wheel acceleration stay local to the hook.
 */
import { useCallback, useEffect, useRef } from 'react';
import { createButtonGestures } from './mouse-input/button-gestures.mjs';
import { createEdgeAutoscroll } from './mouse-input/edge-autoscroll.mjs';
import { createMouseGeometry } from './mouse-input/geometry.mjs';
import { createWheelRouter } from './mouse-input/wheel-router.mjs';
import { WHEEL_STEP_ROWS } from './transcript-window.mjs';

const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_TRACKING_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';
// Alternate-scroll mode (DECSET 1007). In the alt-screen, Windows Terminal
// converts wheel input into arrow keys while this mode is on — and that
// conversion WINS over WT's native ctrl+wheel font zoom. During the zoom
// passthrough window we must turn BOTH mouse tracking and alternate scroll
// off, or ctrl+wheel lands as Up/Down (prompt history) instead of zooming.
// 1007 is kept OFF for the entire session (index.jsx boots with ?1007l and
// the restore below re-asserts it): if mouse tracking ever drops while 1007
// is on, every wheel notch turns into prompt-history Up/Down. Off means a
// degraded wheel is a no-op, never history navigation.
const ALT_SCROLL_OFF = '\x1b[?1007l';
// Wheel step / acceleration knobs live in transcript-window.mjs next to the
// other MIXDOG_TUI_* scroll tunables (see the block around WHEEL_STEP_ROWS);
// the SGR button-byte masks live in mouse-input/sgr-buttons.mjs.
// Windows Terminal (1.25+) forwards shift+click/drag to the app during VT
// mouse mode while ALSO painting its own native selection — honoring the
// events would draw two overlapping highlights (app blue + WT white). In WT,
// drop every shift-modified button event so shift stays purely native
// (native highlight + native Ctrl+C copy); plain drag / ctrl+click /
// right-click remain the app-owned selection paths. Other terminals keep
// the shift-extend behavior (with XTSHIFTESCAPE opted in from index.jsx).
const IS_WINDOWS_TERMINAL = Boolean(process.env.WT_SESSION);

// Console-stream writes can fail asynchronously (notably transient EAGAIN on
// Windows): try/catch only sees a synchronous throw, so restoration also
// handles errors reported to the write callback.
function writeMouseTrackingRestore(stdout, onError) {
  try {
    stdout.write(MOUSE_TRACKING_ON + ALT_SCROLL_OFF, (error) => {
      if (error) onError(error);
    });
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

const activeMouseTrackingRestoreSchedulers = new Set();

// Called by index.jsx before restoring the host terminal. Disabling (rather
// than merely clearing the current timer) also makes already-queued callbacks
// and any late buffered ctrl+wheel event harmless while React is still mounted.
export function cancelPendingMouseTrackingRestores() {
  for (const scheduler of [...activeMouseTrackingRestoreSchedulers]) {
    scheduler.disable();
  }
}

function createMouseTrackingRestoreScheduler(
  stdout,
  { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}
) {
  let timer = null;
  let generation = 0;
  let disabled = false;

  const cancel = () => {
    generation += 1;
    if (timer) clearTimeoutFn(timer);
    timer = null;
  };
  const disable = () => {
    disabled = true;
    cancel();
    activeMouseTrackingRestoreSchedulers.delete(scheduler);
  };
  const scheduler = {
    attach() {
      if (!disabled) activeMouseTrackingRestoreSchedulers.add(scheduler);
    },
    detach() {
      activeMouseTrackingRestoreSchedulers.delete(scheduler);
      cancel();
    },
    disable,
    passthrough() {
      // This check shares the scheduler's terminal-restored latch. Keeping the
      // OFF write here (rather than in the hook) prevents a late buffered wheel
      // event from changing terminal modes after index.jsx has restored them.
      if (disabled || !stdout?.write) return false;
      try {
        stdout.write(MOUSE_TRACKING_OFF + ALT_SCROLL_OFF);
      } catch {
        return false;
      }
      return scheduler.schedule();
    },
    schedule() {
      if (disabled) return false;
      cancel();
      const scheduledGeneration = generation;
      const restore = (attempt) => {
        if (disabled || scheduledGeneration !== generation) return;
        timer = null;
        writeMouseTrackingRestore(stdout, () => {
          if (disabled || scheduledGeneration !== generation || attempt >= 5) return;
          timer = setTimeoutFn(() => restore(attempt + 1), 200);
          timer?.unref?.();
        });
      };
      timer = setTimeoutFn(() => restore(0), 700);
      timer?.unref?.();
      return true;
    },
  };
  return scheduler;
}

export function useMouseInput({
  inkInput,
  isRawModeSupported,
  store,
  stdout,
  frameColumns,
  statuslineBandRows,
  dragRef,
  lastClickRef,
  slashPaletteRef,
  scrollFocusRef,
  promptMouseSelectionRef,
  frameRowsRef,
  promptBoxRectRef,
  transcriptViewportRef,
  scrollTargetRef,
  stopSmoothScroll,
  applySelectionRect,
  applySelectionRectThrottled,
  selectionPointAtCurrentScroll,
  buildSpanRect,
  queueScrollCoalesced,
  setSlashIndex,
  setMeasuredRowsVersion,
  clearStitchBuffer,
}) {
  const zoomRestoreSchedulerRef = useRef(null);
  if (!zoomRestoreSchedulerRef.current) {
    zoomRestoreSchedulerRef.current = createMouseTrackingRestoreScheduler(stdout);
  }
  // Edge auto-scroll timer state (see the effect below). Owned at hook scope so
  // it survives re-subscribes; the drag itself lives on the App-owned dragRef.
  const edgeAutoscrollRef = useRef({ dir: 0, timer: null, noMove: 0 });
  // Wheel acceleration state (see WHEEL_STEP_ROWS). Hook-scoped so it survives
  // the input effect's re-subscribes.
  const wheelAccelRef = useRef({ dir: 0, t: 0, step: WHEEL_STEP_ROWS });
  // Set by the input effect to its own finalizeActiveDrag (+ the WT gesture
  // finish). Held in a ref so settleStuckDrag below can reuse the EXACT
  // button-release path without hoisting the whole handler out of the effect.
  const finalizeDragRef = useRef(null);

  // Recovery for a drag whose release never arrived: the button was let go
  // OUTSIDE the terminal window, or the release was swallowed while mouse
  // tracking was off. drag.active then stays true indefinitely — Ctrl+C copy is
  // gated on !active, and every later scroll rebuilds the rect from
  // anchor→last, so the highlight keeps moving with no pointer behind it. App
  // calls this from the global key handler: any keystroke ends the gesture.
  const settleStuckDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag?.active) return false;
    const finalize = finalizeDragRef.current;
    if (!finalize) {
      drag.active = false;
      return true;
    }
    const last = drag.last || {};
    finalize(Number(last.x) || 0, Number(last.y) || 0);
    return true;
  }, [dragRef]);

  const passthroughCtrlWheelZoom = useCallback(() => {
    // Re-enable with retries. Console stream failures are normally reported to
    // the write callback, not thrown by write(), so try/catch alone silently
    // treated an EAGAIN restore as success and left tracking off indefinitely.
    zoomRestoreSchedulerRef.current.passthrough();
  }, []);

  useEffect(() => {
    const scheduler = zoomRestoreSchedulerRef.current;
    scheduler.attach();
    return () => scheduler.detach();
  }, []);

  // Optional mouse handling. When index.jsx enables SGR mouse tracking
  // (?1000h button + ?1002h drag-motion + ?1006h SGR coords).
  // Every event arrives as `\x1b[<b;col;rowM`
  // (press/motion) or `\x1b[<b;col;rowm` (release), 1-based col/row. We watch raw
  // stdin and split it two ways, both additive to ink's keyboard handling:
  //   • wheel (button 64 up / 65 down) → scroll the transcript
  //   • left-button (0) press → drag → release → in-app text selection; dragging
  //     against the top/bottom edge scrolls the transcript while selecting.
  //     The highlight stays visible after release so the user can confirm the
  //     selected region; ESC or a plain click clears it.
  // Because we run a true fullscreen alt-screen, the reported (row,col) maps 1:1
  // to ink's absolute output grid. We keep anchor/focus points instead of a
  // rectangular min/max box so multi-line drags behave like normal text
  // selection, not terminal block selection.
  useEffect(() => {
    if (!inkInput || !isRawModeSupported) return undefined;
    // Word/line multi-click drag-extension uses the hoisted buildSpanRect (same
    // logic reachable from the auto-scroll path in scrollTranscriptRows).
    // Region geometry (viewport / status band / prompt box mapping and
    // drag-point snapping) lives in mouse-input/geometry.mjs; every helper
    // resolves the CURRENT rects from the refs at call time.
    const geometry = createMouseGeometry({
      transcriptViewportRef,
      frameRowsRef,
      statuslineBandRows,
      frameColumns,
      stdout,
      promptBoxRectRef,
      promptMouseSelectionRef,
    });
    // Windows Terminal's native selection overlay survives incremental frames.
    // Clear it only when an app-owned gesture completes, never on drag motion.
    const finishWindowsMouseGesture = () => {
      if (IS_WINDOWS_TERMINAL) store.forceRenderRepaint?.();
    };
    // Edge auto-scroll TIMER (mouse-input/edge-autoscroll.mjs, ref:
    // ScrollKeybindingHandler useDragToScroll). SGR mode 1002 reports
    // drag-motion only when the pointer changes CELL, so a pointer held
    // stationary at the top/bottom edge stops emitting events and the
    // motion-driven scroll in button-gestures.mjs stalls. The interval keeps scrolling —
    // scrollTranscriptRows' active-drag branch re-extends the selection to the
    // still-held `last` cell each step — until the pointer leaves the edge, the
    // drag ends, or a scroll boundary is reached (delta clamps to 0).
    const { start: startEdgeAutoscroll, stop: stopEdgeAutoscroll } = createEdgeAutoscroll({
      stateRef: edgeAutoscrollRef,
      dragRef,
      scrollTargetRef,
      queueScrollCoalesced,
    });
    // Button gestures (press / drag / release text selection in the prompt,
    // transcript and status regions) live in mouse-input/button-gestures.mjs.
    // finalizeActiveDrag is the release path, shared with the ctrl+wheel zoom
    // passthrough, whose mouse-tracking disable can swallow the release event.
    const { finalizeActiveDrag, routeButtonEvent } = createButtonGestures({
      ...geometry,
      store,
      dragRef,
      lastClickRef,
      promptMouseSelectionRef,
      scrollTargetRef,
      stopSmoothScroll,
      applySelectionRect,
      applySelectionRectThrottled,
      selectionPointAtCurrentScroll,
      buildSpanRect,
      queueScrollCoalesced,
      setMeasuredRowsVersion,
      clearStitchBuffer,
      startEdgeAutoscroll,
      stopEdgeAutoscroll,
      finishWindowsMouseGesture,
      ignoreShiftEvents: IS_WINDOWS_TERMINAL,
    });
    // Wheel routing (ctrl+wheel zoom passthrough, slash-palette navigation,
    // overlay gating, wheel acceleration) lives in mouse-input/wheel-router.mjs.
    // Built here so it shares this effect's drag/finalize closures.
    const routeWheelEvent = createWheelRouter({
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
    });
    // Typed 'mouse' channel handler. Receives one event per emit:
    //   • ParsedMouse {kind:'mouse',button,action,col,row,sequence} — click/drag
    //   • ParsedKey   {kind:'key',name:'wheelup'|'wheeldown',sequence} — wheel
    // (ink's App.js dispatchParsedEvent routes both here; it re-emits the raw
    //  sequence on 'input' only when nothing listens on 'mouse', so once this
    //  handler is registered it is the SOLE consumer of these events.)
    const onMouse = (event) => {
      if (!event || typeof event !== 'object') return;
      // Wheel arrives as a ParsedKey; no button/col/row fields.
      if (event.kind === 'key') {
        routeWheelEvent(event);
        return;
      }
      if (event.kind === 'mouse') routeButtonEvent(event);
    };
    // Expose this effect's release path so a keystroke can settle a drag whose
    // release never arrived (see settleStuckDrag).
    finalizeDragRef.current = (fx, fy) => {
      finalizeActiveDrag(fx, fy);
      finishWindowsMouseGesture();
    };
    inkInput.on('mouse', onMouse);
    return () => {
      inkInput.off('mouse', onMouse);
      finalizeDragRef.current = null;
      stopEdgeAutoscroll();
    };
  }, [
    inkInput,
    isRawModeSupported,
    store,
    stdout,
    passthroughCtrlWheelZoom,
    frameColumns,
    statuslineBandRows,
    stopSmoothScroll,
    clearStitchBuffer,
    queueScrollCoalesced,
    applySelectionRect,
    applySelectionRectThrottled,
    selectionPointAtCurrentScroll,
    buildSpanRect,
  ]);

  return { settleStuckDrag };
}
