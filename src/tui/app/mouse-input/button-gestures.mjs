/**
 * mouse-input/button-gestures.mjs — button half of the SGR mouse channel.
 *
 * One responsibility: turn click / drag / release events into a text
 * selection in the region that owns the press (prompt box, transcript
 * viewport, statusline band) — word/line multi-click, shift/ctrl/right-click
 * extend, drag motion with edge auto-scroll, and the release that finalizes
 * the rect. The wheel half lives in wheel-router.mjs. Every helper takes the
 * gesture context `g` built once per input-effect subscription (see
 * use-mouse-input.mjs), so each reads the CURRENT refs at call time.
 */
import { TRANSCRIPT_MEASURED_ROWS, selectionRectIsDegenerate } from '../transcript-window.mjs';
import { linearSelection } from './geometry.mjs';
import { MOUSE_CTRL_MASK, MOUSE_SHIFT_MASK } from './sgr-buttons.mjs';

// Multi-click sequence: 2nd consecutive press = word (double-click), 3rd =
// whole line (triple-click). Each press must land near the prior one within
// 500ms — up to 2 columns and 1 row of drift (terminals often report a shifted
// cell on repeat clicks); tighter matching made word selection unreliable. A
// 4th qualifying press restarts the sequence at 1 (simplest: reset).
function multiClickCount(lastClick, x, y, now) {
  const qualifies = now - lastClick.t < 500 && Math.abs(lastClick.y - y) <= 1 && Math.abs(lastClick.x - x) <= 2;
  const count = qualifies ? (lastClick.count || 1) + 1 : 1;
  return count > 3 ? 1 : count;
}

// The region a press at row `y` selects in: the transcript viewport, then the
// bottom statusline band; null anywhere else.
function pressRegion(g, y) {
  if (g.isInTranscriptViewport(y)) return 'transcript';
  if (g.isInStatusBand(y)) return 'status';
  return null;
}

function clampToRegion(g, y, region) {
  return region === 'status' ? g.clampToStatusBand(y) : g.clampToTranscriptViewport(y);
}

// Status-band selections never scroll, so their anchor is used as-is; a
// transcript anchor is re-projected to the current scroll position.
function regionAnchor(g, drag, region) {
  return region === 'status' ? drag.anchor : g.selectionPointAtCurrentScroll(drag.anchor, drag.anchorScroll);
}

// Finalize an in-flight drag exactly like the button-release path: push the
// final rect from the given point, and reconcile measured row heights. Used
// by the real release AND by the ctrl+wheel zoom passthrough, whose
// mouse-tracking disable can swallow the release event entirely.
function finalizeActiveDrag(g, fx, fy) {
  const drag = g.dragRef.current;
  if (!drag.active) return;
  g.stopEdgeAutoscroll();
  const region = drag.region;
  if (region === 'prompt') {
    const offset = g.promptOffsetAt(fx, fy);
    drag.active = false;
    g.promptMouseSelectionRef.current?.extendTo?.(offset, true);
    return;
  }
  const span = drag.anchorSpan;
  // Release can land outside the region (or outside the window entirely) —
  // snap it the same way drag motion does, so the finalized rect matches
  // the highlight the user was looking at.
  const finalPoint = g.selectionPointInRegion(fx, fy, region);
  drag.active = false;
  if (span) {
    g.applySelectionRect(g.buildSpanRect(span, finalPoint.x, finalPoint.y, region, drag.anchorScroll));
  } else {
    const rect = linearSelection(regionAnchor(g, drag, region), finalPoint);
    g.applySelectionRect(selectionRectIsDegenerate(rect) ? null : rect);
  }
  if (TRANSCRIPT_MEASURED_ROWS) g.setMeasuredRowsVersion((v) => (v + 1) % 1000000);
}

// Something to extend in this region: a word/line anchorSpan, or a plain
// char-drag selection with its anchor and a live non-empty rect.
function canExtendSelection(g, region) {
  const drag = g.dragRef.current;
  if (drag.region !== region) return false;
  if (drag.anchorSpan) return true;
  return Boolean(drag.anchor && drag.rect && !selectionRectIsDegenerate(drag.rect));
}

// Extend the region's existing selection to the clicked cell, preserving the
// original anchor: by whole words/lines from an anchorSpan, else linearly
// from the anchor. `active` keeps the drag armed (shift/ctrl press) or leaves
// it one-shot (right press).
function extendSelection(g, x, y, region, now, active) {
  const drag = g.dragRef.current;
  const selectionY = clampToRegion(g, y, region);
  const rect = drag.anchorSpan
    ? g.buildSpanRect(drag.anchorSpan, x, selectionY, region, drag.anchorScroll)
    : linearSelection(regionAnchor(g, drag, region), { x, y: selectionY });
  g.stopSmoothScroll();
  g.dragRef.current = { ...drag, last: { x, y: selectionY }, active, region };
  g.applySelectionRect(rect);
  g.lastClickRef.current = { x, y, t: now, count: 1 };
}

// Right-button press = extend-click. Extends the existing selection in the
// pressed region using the SAME logic as the shift/ctrl paths, but ONLY when
// there is something extendable there; with nothing to extend it is ignored
// entirely (no selection clear, no drag start).
function onRightPress(g, x, y) {
  if (g.isInPromptBox(x, y)) {
    const ctl = g.promptMouseSelectionRef.current;
    if (ctl?.hasSelection?.()) {
      g.applySelectionRect(null);
      const offset = g.promptOffsetAt(x, y);
      g.stopSmoothScroll();
      // Right-click extend is a one-shot: apply immediately and leave the
      // drag INACTIVE so the right-button release can't finalize (the
      // generic release branch is left-button-only anyway).
      g.dragRef.current = {
        anchor: { x, y },
        anchorScroll: 0,
        last: { x, y },
        active: false,
        rect: null,
        region: 'prompt',
        anchorSpan: null,
      };
      if (offset != null) ctl.extendTo?.(offset, true);
      g.lastClickRef.current = { x: -1, y: -1, t: 0 };
      g.finishWindowsMouseGesture();
    }
    return;
  }
  const region = pressRegion(g, y);
  if (!region || !canExtendSelection(g, region)) return;
  g.promptMouseSelectionRef.current?.clear?.();
  extendSelection(g, x, y, region, Date.now(), false);
  g.finishWindowsMouseGesture();
}

function onPromptPress(g, x, y, extendHeld) {
  // Clear any ink-grid selection so only one highlight is ever visible.
  g.applySelectionRect(null);
  const offset = g.promptOffsetAt(x, y);
  g.stopSmoothScroll();
  g.dragRef.current = {
    anchor: { x, y },
    anchorScroll: 0,
    last: { x, y },
    active: true,
    rect: null,
    region: 'prompt',
    anchorSpan: null,
  };
  const ctl = g.promptMouseSelectionRef.current;
  // Shift+click extends the EXISTING prompt selection (anchor stays
  // put, cursor jumps to the click) instead of starting a fresh
  // zero-width anchor at the click point.
  if (extendHeld && ctl?.hasSelection?.()) {
    if (offset != null) ctl.extendTo?.(offset, true);
    g.lastClickRef.current = { x: -1, y: -1, t: 0 };
    return;
  }
  // Multi-click word/line select (double = word, triple = line), same
  // qualifying-press window as the transcript/status path. Reuses
  // lastClickRef so a rapid double/triple click on the prompt box behaves the
  // same as one on the transcript.
  const now = Date.now();
  const clickCount = multiClickCount(g.lastClickRef.current, x, y, now);
  if ((clickCount === 2 || clickCount === 3) && offset != null) {
    if (clickCount === 2) ctl?.selectWordAt?.(offset);
    else ctl?.selectLineAt?.(offset);
    // Click-select is already final (selectWordAt/selectLineAt set the
    // full word/line range). Mark the drag inactive so a subsequent
    // release does NOT fall into the generic prompt release handler,
    // which calls extendTo(releaseOffset) and would collapse this
    // selection back down to anchor→releaseOffset (or empty on a
    // no-motion release, since anchor was never re-anchored here).
    g.dragRef.current.active = false;
    g.lastClickRef.current = { x, y, t: now, count: clickCount };
    return;
  }
  if (offset != null) ctl?.anchorAt?.(offset);
  g.lastClickRef.current = { x, y, t: now, count: 1 };
}

// Region router: a press decides which surface owns this selection. Prompt
// box takes priority (it overlaps no transcript rows), then the transcript
// viewport, then the bottom statusline band. A press anywhere else clears any
// prior selection (plain click).
function onLeftPress(g, x, y, extendHeld) {
  // A fresh press ends any prior drag's held-at-edge auto-scroll.
  g.stopEdgeAutoscroll();
  if (g.isInPromptBox(x, y)) {
    onPromptPress(g, x, y, extendHeld);
    return;
  }
  const region = pressRegion(g, y);
  if (!region) {
    g.lastClickRef.current = { x: -1, y: -1, t: 0 };
    g.dragRef.current.active = false;
    g.dragRef.current.region = null;
    g.dragRef.current.anchorSpan = null;
    // Clear whichever selection is active (ink-grid rect AND/OR prompt engine).
    g.promptMouseSelectionRef.current?.clear?.();
    g.applySelectionRect(null);
    g.finishWindowsMouseGesture();
    return;
  }
  // A press always clears the prompt-box selection (single active region).
  g.promptMouseSelectionRef.current?.clear?.();
  const now = Date.now();
  // Shift+click extends the existing selection in this SAME region to the
  // click point: a word/line anchorSpan extends by whole words/lines, a plain
  // char-drag selection with a live non-empty rect extends from its original
  // anchor. An empty/absent selection falls through to a normal fresh press.
  if (extendHeld && canExtendSelection(g, region)) {
    extendSelection(g, x, y, region, now, true);
    return;
  }
  // Works for transcript AND status rows since getWordRectAt/getLineRectAt
  // are grid-based. Copy still happens on Ctrl+C, never here.
  const clickCount = multiClickCount(g.lastClickRef.current, x, y, now);
  if (clickCount === 2 || clickCount === 3) {
    // Word (2) or line (3) select. Snap to the word/line under the cell
    // and record the span on dragRef so a following drag extends by whole
    // words/lines from this span (see buildSpanRect). Leave the drag
    // ARMED (active:true): a release without motion keeps this highlight
    // (buildSpanRect returns the span for an in-span target), while
    // any motion extends it.
    const kind = clickCount === 2 ? 'word' : 'line';
    const wr = kind === 'word' ? g.store.getWordRectAt?.(x, y) : g.store.getLineRectAt?.(y);
    if (wr) {
      const lo = { x: wr.x1, y: wr.y1 };
      const hi = { x: wr.x2, y: wr.y2 };
      const rect = linearSelection(lo, hi);
      g.stopSmoothScroll();
      // Fresh word/line anchor: reset the stitch buffer (see char-drag).
      g.clearStitchBuffer?.();
      g.dragRef.current = {
        anchor: { x, y },
        anchorScroll: region === 'transcript' ? g.scrollTargetRef.current : 0,
        last: { x, y },
        active: true,
        rect: null,
        region,
        anchorSpan: { lo, hi, kind },
      };
      g.applySelectionRect(rect);
      g.lastClickRef.current = { x, y, t: now, count: clickCount };
      return;
    }
  }
  g.lastClickRef.current = { x, y, t: now, count: 1 };
  // Left-button press: begin a new selection anchored here.
  // Anchor the drag but do NOT paint a zero-width selection yet; a plain
  // single click should not flash a one-cell highlight. The selection is
  // only rendered once a drag actually extends past the anchor.
  // Status-band selections do NOT scroll, so anchorScroll is irrelevant
  // there; keep the transcript scroll anchor only for the transcript.
  // Plain single press clears any word/line anchorSpan (char-drag mode).
  g.stopSmoothScroll();
  // Fresh char-drag anchor: drop any rows stitched from a prior
  // selection so the new drag reconstructs only its own content.
  g.clearStitchBuffer?.();
  g.dragRef.current = {
    anchor: { x, y },
    anchorScroll: region === 'transcript' ? g.scrollTargetRef.current : 0,
    last: { x, y },
    active: true,
    rect: null,
    region,
    anchorSpan: null,
  };
}

function onDragMotion(g, x, y) {
  const drag = g.dragRef.current;
  const region = drag.region;
  if (region === 'prompt') {
    // Prompt drag: extend the PromptInput selection to the mapped offset.
    // The cell is clamped to the box rows so a drag outside still tracks
    // the nearest edge of the editable content.
    const offset = g.promptOffsetAt(x, y);
    drag.last = { x, y };
    if (offset != null) g.promptMouseSelectionRef.current?.extendTo?.(offset);
    return;
  }
  // Drag motion (transcript or status): extend the selection to the
  // current cell, snapped into the owning region's band — rows clamp,
  // and a pointer outside the band takes that row's start/end column.
  const motionPoint = g.selectionPointInRegion(x, y, region);
  const prevDragY = drag.last ? Number(drag.last.y) : y;
  drag.last = { x: motionPoint.x, y: motionPoint.y };
  const span = drag.anchorSpan;
  // Word/line multi-click drag: extend by whole words/lines from the
  // anchor span to the word/line under the cursor (see buildSpanRect).
  const rect = span
    ? g.buildSpanRect(span, motionPoint.x, motionPoint.y, region, drag.anchorScroll)
    : linearSelection(regionAnchor(g, drag, region), motionPoint);
  g.applySelectionRectThrottled(rect);
  // Auto-scroll-while-dragging is transcript-only (the status band does
  // not scroll).
  if (region !== 'transcript') return;
  const { top, bottom } = g.transcriptViewport();
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
    g.queueScrollCoalesced(3);
    g.startEdgeAutoscroll(1);
  } else if (y >= bottom && (y > prevDragY || y > bottom)) {
    g.queueScrollCoalesced(-3);
    g.startEdgeAutoscroll(-1);
  } else {
    // Pointer moved back inside the viewport (or along an edge row
    // without pushing toward it): halt any held-at-edge auto-scroll.
    g.stopEdgeAutoscroll();
  }
}

function routeButtonEvent(g, event) {
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
  if (g.ignoreShiftEvents && shiftHeld) return;
  // Do not force a full clear/rewrite on app-owned presses. Selection
  // changes repaint through Ink's normal maxFps render throttle.
  // Ctrl+left-click is the app-side extend trigger (baseButton =
  // button & 3 already maps ctrl+left press to button 0); right-button
  // press is the second trigger. This is unrelated to the ctrl+WHEEL zoom
  // passthrough, which is handled in the wheel path and never reaches this
  // button-press code.
  const extendHeld = shiftHeld || ctrlHeld;
  if (baseButton === 2 && press && !isMotion) {
    onRightPress(g, x, y);
  } else if (baseButton === 0 && press && !isMotion) {
    onLeftPress(g, x, y, extendHeld);
  } else if (baseButton === 0 && isMotion && g.dragRef.current.active) {
    onDragMotion(g, x, y);
  } else if (!press && baseButton === 0 && g.dragRef.current.active) {
    // Button release while dragging: finalize with the release coordinate
    // (the SGR release event carries col/row) and keep the selection
    // visible. Copy is NOT automatic — the user presses Ctrl+C to copy.
    // The highlight stays until ESC or a plain click. finalizeActiveDrag
    // handles region routing (prompt/word-line/char), the empty→clear
    // case, edge-autoscroll stop, and the measured-rows reconcile — same
    // path the ctrl+wheel zoom passthrough uses. Guarded to baseButton 0
    // so a stray right-button release never finalizes.
    finalizeActiveDrag(g, x, y);
    // WT keeps its native shift-selection overlay across incremental
    // frames. Dismiss it once per completed gesture, after publishing the
    // final app selection, rather than forcing a full rewrite on press.
    g.finishWindowsMouseGesture();
  }
}

/**
 * Build the button-gesture handlers over one gesture context: the region
 * geometry from createMouseGeometry plus the App-owned refs and callbacks.
 * `finalizeActiveDrag(x, y)` is the release path (shared with the wheel
 * router's zoom passthrough and the stuck-drag recovery);
 * `routeButtonEvent(event)` handles one ParsedMouse event.
 */
export function createButtonGestures(g) {
  return {
    finalizeActiveDrag: (fx, fy) => finalizeActiveDrag(g, fx, fy),
    routeButtonEvent: (event) => routeButtonEvent(g, event),
  };
}
