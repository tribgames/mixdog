/*
 * app/use-interaction-refs.mjs — mouse-selection, click and frame-geometry refs
 * App shares between the mouse handler, scroll engine and layout.
 */
import { useRef } from 'react';

export function useInteractionRefs() {
  // dragRef tracks an in-progress mouse text selection (see the mouse handler):
  // anchor = where the drag began, last = the latest cell, active = button held.
  // region: which surface the in-progress (or last) selection belongs to —
  // 'transcript' | 'status' (both ink-grid) | 'prompt' (PromptInput's own engine)
  // | null. Press decides it; motion/release stay in that region.
  // anchorSpan: for word/line multi-click selections, the initial word/line
  // bounds ({ lo:{x,y}, hi:{x,y}, kind:'word'|'line' }) so a subsequent drag
  // extends the selection whole-word/whole-line from that span. Null ⇔ an
  // ordinary char-drag selection.
  const dragRef = useRef({
    anchor: null,
    anchorScroll: 0,
    last: null,
    active: false,
    rect: null,
    region: null,
    anchorSpan: null,
  });
  const transcriptViewportRef = useRef({ top: 0, bottom: 0 });
  const panelTransitionRef = useRef({ signature: '', reserve: 0, clearRows: 0, guardRows: 0, epoch: 0 });
  const panelCloseInkMaskRowsRef = useRef(0);
  const projectBootInputLatchRef = useRef(false);
  // [mixdog] Latest terminal row count + the statusline band (bottom rows),
  // refreshed each render. The mouse handler uses these to (a) clip a status-bar
  // grid selection to the statusline rows and (b) route a press to the right
  // region. STATUSLINE_BAND_ROWS (App.jsx) mirrors the layout reserve.
  const frameRowsRef = useRef(24);
  const selectionLayoutRef = useRef(null);
  const selectionTextRef = useRef('');
  // lastClickRef tracks the previous left-press cell + time so the mouse handler
  // can detect a double-click (same cell within 500ms) for word selection.
  // count = consecutive qualifying presses on the same cell (1=single,
  // 2=double/word, 3=triple/line). A 4th qualifying press restarts the
  // sequence at 1 (simplest reset: no ratcheting/back-off). Any non-qualifying
  // press resets to a fresh single.
  const lastClickRef = useRef({ x: -1, y: -1, t: 0, count: 0 });
  return {
    dragRef,
    transcriptViewportRef,
    panelTransitionRef,
    panelCloseInkMaskRowsRef,
    projectBootInputLatchRef,
    frameRowsRef,
    selectionLayoutRef,
    selectionTextRef,
    lastClickRef,
  };
}
