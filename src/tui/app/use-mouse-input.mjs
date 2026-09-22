/**
 * use-mouse-input.mjs — SGR mouse handling hook for the App shell.
 *
 * Covers the ctrl+wheel zoom passthrough and the SGR input effect (wheel
 * scroll routing, prompt/transcript/status text selection with word/line
 * multi-click, drag auto-scroll). Shared App state is injected via
 * refs/callbacks; gesture timers and wheel acceleration stay local to the hook.
 */
import { useCallback, useEffect, useRef } from 'react';
import { createEdgeAutoscroll } from './mouse-input/edge-autoscroll.mjs';
import { createMouseGeometry, linearSelection } from './mouse-input/geometry.mjs';
import { MOUSE_CTRL_MASK, MOUSE_SHIFT_MASK } from './mouse-input/sgr-buttons.mjs';
import { createWheelRouter } from './mouse-input/wheel-router.mjs';
import { TRANSCRIPT_MEASURED_ROWS, WHEEL_STEP_ROWS, selectionRectIsDegenerate } from './transcript-window.mjs';

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
  scrollTranscriptRows,
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
    const {
      transcriptViewport,
      isInTranscriptViewport,
      clampToTranscriptViewport,
      isInStatusBand,
      clampToStatusBand,
      selectionPointInRegion,
      isInPromptBox,
      promptOffsetAt,
    } = createMouseGeometry({
      transcriptViewportRef,
      frameRowsRef,
      statuslineBandRows,
      frameColumns,
      stdout,
      promptBoxRectRef,
      promptMouseSelectionRef,
    });
    // Clear whichever selection is active (ink-grid rect AND/OR prompt engine).
    const clearAllSelections = () => {
      promptMouseSelectionRef.current?.clear?.();
      applySelectionRect(null);
    };
    // Windows Terminal's native selection overlay survives incremental frames.
    // Clear it only when an app-owned gesture completes, never on drag motion.
    const finishWindowsMouseGesture = () => {
      if (IS_WINDOWS_TERMINAL) store.forceRenderRepaint?.();
    };
    // Edge auto-scroll TIMER (mouse-input/edge-autoscroll.mjs, ref:
    // ScrollKeybindingHandler useDragToScroll). SGR mode 1002 reports
    // drag-motion only when the pointer changes CELL, so a pointer held
    // stationary at the top/bottom edge stops emitting events and the
    // motion-driven scroll below stalls. The interval keeps scrolling —
    // scrollTranscriptRows' active-drag branch re-extends the selection to the
    // still-held `last` cell each step — until the pointer leaves the edge, the
    // drag ends, or a scroll boundary is reached (delta clamps to 0).
    const { start: startEdgeAutoscroll, stop: stopEdgeAutoscroll } = createEdgeAutoscroll({
      stateRef: edgeAutoscrollRef,
      dragRef,
      scrollTargetRef,
      queueScrollCoalesced,
    });
    // Finalize an in-flight drag exactly like the button-release path: push the
    // final rect from the given point, and reconcile measured row heights. Used
    // by the real release below AND by the ctrl+wheel zoom passthrough, whose
    // mouse-tracking disable can swallow the release event entirely.
    const finalizeActiveDrag = (fx, fy) => {
      const drag = dragRef.current;
      if (!drag.active) return;
      stopEdgeAutoscroll();
      const region = drag.region;
      if (region === 'prompt') {
        const offset = promptOffsetAt(fx, fy);
        drag.active = false;
        promptMouseSelectionRef.current?.extendTo?.(offset, true);
        return;
      }
      const span = drag.anchorSpan;
      // Release can land outside the region (or outside the window entirely) —
      // snap it the same way drag motion does, so the finalized rect matches
      // the highlight the user was looking at.
      const finalPoint = selectionPointInRegion(fx, fy, region);
      const finalX = finalPoint.x;
      const finalY = finalPoint.y;
      drag.active = false;
      if (span) {
        const rect = buildSpanRect(span, finalX, finalY, region, drag.anchorScroll);
        applySelectionRect(rect);
      } else {
        const anchor =
          region === 'status' ? drag.anchor : selectionPointAtCurrentScroll(drag.anchor, drag.anchorScroll);
        const rect = linearSelection(anchor, { x: finalX, y: finalY });
        const empty = rect.x1 === rect.x2 && rect.y1 === rect.y2;
        if (empty) applySelectionRect(null);
        else applySelectionRect(rect);
      }
      if (TRANSCRIPT_MEASURED_ROWS) setMeasuredRowsVersion((v) => (v + 1) % 1000000);
    };
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
      if (event.kind !== 'mouse') return;
      {
        const button = Number(event.button);
        const x = Number(event.col) - 1; // SGR is 1-based; grid is 0-based
        const y = Number(event.row) - 1;
        const press = event.action === 'press';
        // Low 2 bits = button id; bit 5 (32) = motion-while-pressed flag.
        const baseButton = button & 3;
        const isMotion = (button & 32) !== 0;
        // Read Shift separately: baseButton retains only the button id.
        const shiftHeld = (button & MOUSE_SHIFT_MASK) !== 0;
        const ctrlHeld = (button & MOUSE_CTRL_MASK) !== 0;
        // Keep Shift+mouse native in WT even when it forwards the event, so
        // app and terminal selections cannot double-paint.
        if (IS_WINDOWS_TERMINAL && shiftHeld) return;
        // Do not force a full clear/rewrite on app-owned presses. Selection
        // changes below repaint through Ink's normal maxFps render throttle.
        // Ctrl+left-click is the app-side extend trigger (baseButton =
        // button & 3 already maps ctrl+left press to button 0); right-button
        // press is the second trigger (its own block below). This is
        // unrelated to the ctrl+WHEEL zoom passthrough, which is handled in
        // the wheel path and never reaches this button-press code.
        const extendHeld = shiftHeld || ctrlHeld;
        const isRightPress = baseButton === 2 && press && !isMotion;
        if (isRightPress) {
          // Right-button press = extend-click. Extends the existing selection in
          // the pressed region using the SAME logic as the shift/ctrl paths, but
          // ONLY when there is something extendable there; with nothing to extend
          // it is ignored entirely (no selection clear, no drag start).
          if (isInPromptBox(x, y)) {
            const ctl = promptMouseSelectionRef.current;
            if (ctl?.hasSelection?.()) {
              applySelectionRect(null);
              const offset = promptOffsetAt(x, y);
              stopSmoothScroll();
              // Right-click extend is a one-shot: apply immediately and leave the
              // drag INACTIVE so the right-button release can't finalize (the
              // generic !press branch is left-button-only anyway).
              dragRef.current = {
                anchor: { x, y },
                anchorScroll: 0,
                last: { x, y },
                active: false,
                rect: null,
                region: 'prompt',
                anchorSpan: null,
              };
              if (offset != null) ctl.extendTo?.(offset, true);
              lastClickRef.current = { x: -1, y: -1, t: 0 };
              finishWindowsMouseGesture();
            }
            return;
          }
          const inTranscriptR = isInTranscriptViewport(y);
          const inStatusR = !inTranscriptR && isInStatusBand(y);
          if (!inTranscriptR && !inStatusR) return;
          const regionR = inTranscriptR ? 'transcript' : 'status';
          const nowR = Date.now();
          if (dragRef.current.region === regionR && dragRef.current.anchorSpan) {
            promptMouseSelectionRef.current?.clear?.();
            const selectionY = regionR === 'status' ? clampToStatusBand(y) : clampToTranscriptViewport(y);
            const span = dragRef.current.anchorSpan;
            const rect = buildSpanRect(span, x, selectionY, regionR, dragRef.current.anchorScroll);
            stopSmoothScroll();
            dragRef.current = { ...dragRef.current, last: { x, y: selectionY }, active: false, region: regionR };
            applySelectionRect(rect);
            lastClickRef.current = { x, y, t: nowR, count: 1 };
            finishWindowsMouseGesture();
            return;
          }
          if (
            dragRef.current.region === regionR &&
            !dragRef.current.anchorSpan &&
            dragRef.current.anchor &&
            dragRef.current.rect &&
            !selectionRectIsDegenerate(dragRef.current.rect)
          ) {
            promptMouseSelectionRef.current?.clear?.();
            const selectionY = regionR === 'status' ? clampToStatusBand(y) : clampToTranscriptViewport(y);
            const anchor =
              regionR === 'status'
                ? dragRef.current.anchor
                : selectionPointAtCurrentScroll(dragRef.current.anchor, dragRef.current.anchorScroll);
            const rect = linearSelection(anchor, { x, y: selectionY });
            stopSmoothScroll();
            dragRef.current = { ...dragRef.current, last: { x, y: selectionY }, active: false, region: regionR };
            applySelectionRect(rect);
            lastClickRef.current = { x, y, t: nowR, count: 1 };
            finishWindowsMouseGesture();
            return;
          }
          return;
        }
        if (baseButton === 0 && press && !isMotion) {
          // A fresh press ends any prior drag's held-at-edge auto-scroll.
          stopEdgeAutoscroll();
          // Region router: a press decides which surface owns this selection.
          // Prompt box takes priority (it overlaps no transcript rows), then the
          // transcript viewport, then the bottom statusline band. A press
          // anywhere else clears any prior selection (plain click).
          if (isInPromptBox(x, y)) {
            // Clear any ink-grid selection so only one highlight is ever visible.
            applySelectionRect(null);
            const offset = promptOffsetAt(x, y);
            stopSmoothScroll();
            dragRef.current = {
              anchor: { x, y },
              anchorScroll: 0,
              last: { x, y },
              active: true,
              rect: null,
              region: 'prompt',
              anchorSpan: null,
            };
            const ctl = promptMouseSelectionRef.current;
            // Shift+click extends the EXISTING prompt selection (anchor stays
            // put, cursor jumps to the click) instead of starting a fresh
            // zero-width anchor at the click point.
            if (extendHeld && ctl?.hasSelection?.()) {
              if (offset != null) ctl.extendTo?.(offset, true);
              lastClickRef.current = { x: -1, y: -1, t: 0 };
              return;
            }
            // Multi-click word/line select (double = word, triple = line),
            // same "qualifying press" window/drift tolerance used by the
            // transcript/status path below. Reuses lastClickRef so a rapid
            // double/triple click on the prompt box behaves the same as one on
            // the transcript. A qualifying press advances the count; anything
            // else (moved too far, too slow, or count already at 3) resets to
            // a fresh single-click anchor.
            const nowPrompt = Date.now();
            const lcPrompt = lastClickRef.current;
            const qualifiesPrompt =
              nowPrompt - lcPrompt.t < 500 && Math.abs(lcPrompt.y - y) <= 1 && Math.abs(lcPrompt.x - x) <= 2;
            let promptClickCount = qualifiesPrompt ? (lcPrompt.count || 1) + 1 : 1;
            if (promptClickCount > 3) promptClickCount = 1;
            if ((promptClickCount === 2 || promptClickCount === 3) && offset != null) {
              if (promptClickCount === 2) ctl?.selectWordAt?.(offset);
              else ctl?.selectLineAt?.(offset);
              // Click-select is already final (selectWordAt/selectLineAt set the
              // full word/line range). Mark the drag inactive so a subsequent
              // release does NOT fall into the generic prompt release handler
              // below, which calls extendTo(releaseOffset) and would collapse
              // this selection back down to anchor→releaseOffset (or empty on a
              // no-motion release, since anchor was never re-anchored here).
              dragRef.current.active = false;
              lastClickRef.current = { x, y, t: nowPrompt, count: promptClickCount };
              return;
            } else if (offset != null) {
              ctl?.anchorAt?.(offset);
            }
            lastClickRef.current = { x, y, t: nowPrompt, count: 1 };
            return;
          }
          const inTranscript = isInTranscriptViewport(y);
          const inStatus = !inTranscript && isInStatusBand(y);
          if (!inTranscript && !inStatus) {
            lastClickRef.current = { x: -1, y: -1, t: 0 };
            dragRef.current.active = false;
            dragRef.current.region = null;
            dragRef.current.anchorSpan = null;
            clearAllSelections();
            finishWindowsMouseGesture();
            return;
          }
          const region = inTranscript ? 'transcript' : 'status';
          // A press always clears the prompt-box selection (single active region).
          promptMouseSelectionRef.current?.clear?.();
          const now = Date.now();
          // Shift+click on an existing word/line (anchorSpan) selection extends
          // that selection by whole words/lines to the click point, preserving
          // the original anchor span.
          if (extendHeld && dragRef.current.region === region && dragRef.current.anchorSpan) {
            const selectionY = region === 'status' ? clampToStatusBand(y) : clampToTranscriptViewport(y);
            const span = dragRef.current.anchorSpan;
            const rect = buildSpanRect(span, x, selectionY, region, dragRef.current.anchorScroll);
            stopSmoothScroll();
            dragRef.current = {
              ...dragRef.current,
              last: { x, y: selectionY },
              active: true,
              region,
            };
            applySelectionRect(rect);
            lastClickRef.current = { x, y, t: now, count: 1 };
            return;
          }
          // Shift+click extends the existing ink-grid selection in this SAME
          // region from its original anchor to the new click point, instead of
          // starting a fresh anchor here. Only applies to a plain char-drag
          // selection (no anchorSpan) with a live non-empty rect; a word/line
          // anchorSpan or an empty/absent selection falls through to a normal
          // fresh press below.
          if (
            extendHeld &&
            dragRef.current.region === region &&
            !dragRef.current.anchorSpan &&
            dragRef.current.anchor &&
            dragRef.current.rect &&
            !selectionRectIsDegenerate(dragRef.current.rect)
          ) {
            const selectionY = region === 'status' ? clampToStatusBand(y) : clampToTranscriptViewport(y);
            const anchor =
              region === 'status'
                ? dragRef.current.anchor
                : selectionPointAtCurrentScroll(dragRef.current.anchor, dragRef.current.anchorScroll);
            const rect = linearSelection(anchor, { x, y: selectionY });
            stopSmoothScroll();
            dragRef.current = {
              ...dragRef.current,
              last: { x, y: selectionY },
              active: true,
              region,
            };
            applySelectionRect(rect);
            lastClickRef.current = { x, y, t: now, count: 1 };
            return;
          }
          // Multi-click sequence: 2nd consecutive press = word (double-click),
          // 3rd = whole line (triple-click). Each press must land near the prior
          // one within 500ms — up to 2 columns and 1 row of drift (terminals
          // often report a shifted cell on repeat clicks); tighter matching made
          // word selection unreliable. A 4th qualifying press restarts the
          // sequence at 1 (simplest: reset). Works for
          // transcript AND status rows since getWordRectAt/getLineRectAt are
          // grid-based. Copy still happens on Ctrl+C, never here.
          const lc = lastClickRef.current;
          const qualifies = now - lc.t < 500 && Math.abs(lc.y - y) <= 1 && Math.abs(lc.x - x) <= 2;
          let clickCount = qualifies ? (lc.count || 1) + 1 : 1;
          if (clickCount > 3) clickCount = 1;
          if (clickCount === 2 || clickCount === 3) {
            // Word (2) or line (3) select. Snap to the word/line under the cell
            // and record the span on dragRef so a following drag extends by whole
            // words/lines from this span (see buildSpanRect). Leave the drag
            // ARMED (active:true): a release without motion keeps this highlight
            // (buildSpanRect returns the span for an in-span target), while
            // any motion extends it. The word/line select sets
            // isDragging=true + anchorSpan; the mouse-up finalizes.
            const kind = clickCount === 2 ? 'word' : 'line';
            const wr = kind === 'word' ? store.getWordRectAt?.(x, y) : store.getLineRectAt?.(y);
            if (wr) {
              const lo = { x: wr.x1, y: wr.y1 };
              const hi = { x: wr.x2, y: wr.y2 };
              const rect = linearSelection(lo, hi);
              stopSmoothScroll();
              // Fresh word/line anchor: reset the stitch buffer (see char-drag).
              clearStitchBuffer?.();
              dragRef.current = {
                anchor: { x, y },
                anchorScroll: region === 'transcript' ? scrollTargetRef.current : 0,
                last: { x, y },
                active: true,
                rect: null,
                region,
                anchorSpan: { lo, hi, kind },
              };
              applySelectionRect(rect);
              lastClickRef.current = { x, y, t: now, count: clickCount };
              return;
            }
          }
          lastClickRef.current = { x, y, t: now, count: 1 };
          // Left-button press: begin a new selection anchored here.
          // Anchor the drag but do NOT paint a zero-width selection yet; a plain
          // single click should not flash a one-cell highlight. The selection is
          // only rendered once a drag actually extends past the anchor.
          // Status-band selections do NOT scroll, so anchorScroll is irrelevant
          // there; keep the transcript scroll anchor only for the transcript.
          // Plain single press clears any word/line anchorSpan (char-drag mode).
          stopSmoothScroll();
          // Fresh char-drag anchor: drop any rows stitched from a prior
          // selection so the new drag reconstructs only its own content.
          clearStitchBuffer?.();
          dragRef.current = {
            anchor: { x, y },
            anchorScroll: region === 'transcript' ? scrollTargetRef.current : 0,
            last: { x, y },
            active: true,
            rect: null,
            region,
            anchorSpan: null,
          };
        } else if (baseButton === 0 && isMotion && dragRef.current.active) {
          const region = dragRef.current.region;
          if (region === 'prompt') {
            // Prompt drag: extend the PromptInput selection to the mapped offset.
            // The cell is clamped to the box rows so a drag outside still tracks
            // the nearest edge of the editable content.
            const offset = promptOffsetAt(x, y);
            dragRef.current.last = { x, y };
            if (offset != null) promptMouseSelectionRef.current?.extendTo?.(offset);
            return;
          }
          // Drag motion (transcript or status): extend the selection to the
          // current cell, snapped into the owning region's band — rows clamp,
          // and a pointer outside the band takes that row's start/end column.
          const motionPoint = selectionPointInRegion(x, y, region);
          const selectionX = motionPoint.x;
          const selectionY = motionPoint.y;
          const prevDragY = dragRef.current.last ? Number(dragRef.current.last.y) : y;
          dragRef.current.last = { x: selectionX, y: selectionY };
          const span = dragRef.current.anchorSpan;
          if (span) {
            // Word/line multi-click drag: extend by whole words/lines from the
            // anchor span to the word/line under the cursor (see buildSpanRect).
            const rect = buildSpanRect(span, selectionX, selectionY, region, dragRef.current.anchorScroll);
            applySelectionRectThrottled(rect);
          } else {
            const anchor =
              region === 'status'
                ? dragRef.current.anchor
                : selectionPointAtCurrentScroll(dragRef.current.anchor, dragRef.current.anchorScroll);
            const rect = linearSelection(anchor, { x: selectionX, y: selectionY });
            applySelectionRectThrottled(rect);
          }
          // Auto-scroll-while-dragging is transcript-only (the status band does
          // not scroll).
          if (region === 'transcript') {
            const { top, bottom } = transcriptViewport();
            // Edge auto-scroll only when the pointer pushes TOWARD the edge:
            // either this motion moved vertically toward it, or the pointer
            // sits beyond the transcript viewport rows entirely. A horizontal
            // drag along the top/bottom rows must NOT scroll — it used to
            // scroll away the very rows being selected. The edge is the
            // VIEWPORT's own first/last row: the previous screen-absolute
            // guesses (row <= 1 / rows - 5) drifted away from the real
            // transcript bounds whenever the prompt box grew, leaving rows that
            // clamped the selection without ever scrolling.
            if (y <= top && (y < prevDragY || y < top)) {
              queueScrollCoalesced(3);
              startEdgeAutoscroll(1);
            } else if (y >= bottom && (y > prevDragY || y > bottom)) {
              queueScrollCoalesced(-3);
              startEdgeAutoscroll(-1);
            } else {
              // Pointer moved back inside the viewport (or along an edge row
              // without pushing toward it): halt any held-at-edge auto-scroll.
              stopEdgeAutoscroll();
            }
          }
        } else if (!press && baseButton === 0 && dragRef.current.active) {
          // Button release while dragging: finalize with the release coordinate
          // (the SGR release event carries col/row) and keep the selection
          // visible. Copy is NOT automatic — the user presses Ctrl+C to copy.
          // The highlight stays until ESC or a plain click. finalizeActiveDrag
          // handles region routing (prompt/word-line/char), the empty→clear
          // case, edge-autoscroll stop, and the measured-rows reconcile — same
          // path the ctrl+wheel zoom passthrough uses. Guarded to baseButton 0
          // so a stray right-button release never finalizes.
          finalizeActiveDrag(x, y);
          // WT keeps its native shift-selection overlay across incremental
          // frames. Dismiss it once per completed gesture, after publishing the
          // final app selection, rather than forcing a full rewrite on press.
          finishWindowsMouseGesture();
        }
      }
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
