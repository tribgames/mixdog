/**
 * use-mouse-input.mjs — SGR mouse handling hook for the App shell.
 *
 * Extracted verbatim from App.jsx: the ctrl+wheel zoom passthrough and the
 * big SGR input effect (wheel scroll routing, prompt/transcript/status text
 * selection with word/line multi-click, drag auto-scroll). All shared state
 * stays owned by App and is injected via refs/callbacks so behavior is
 * unchanged; only the zoom-passthrough timer is owned here.
 */
import { useCallback, useEffect, useRef } from 'react';
import { overlayBlocksGlobalTranscriptScroll } from './slash-commands.mjs';
import { TRANSCRIPT_MEASURED_ROWS } from './transcript-window.mjs';

const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_TRACKING_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';
// Alternate-scroll mode (DECSET 1007). In the alt-screen, Windows Terminal
// converts wheel input into arrow keys while this mode is on — and that
// conversion WINS over WT's native ctrl+wheel font zoom. During the zoom
// passthrough window we must turn BOTH mouse tracking and alternate scroll
// off, or ctrl+wheel lands as Up/Down (prompt history) instead of zooming.
const ALT_SCROLL_OFF = '\x1b[?1007l';
const ALT_SCROLL_ON = '\x1b[?1007h';
const MOUSE_MODIFIER_MASK = 4 | 8 | 16;
const MOUSE_CTRL_MASK = 16;
// Bit 2 (4) of the SGR button byte = shift held during the click. Wheel/ctrl
// masking above intentionally strips it for scroll routing; button-press
// handling below reads it separately (before baseButton = button & 3 drops
// every modifier bit) so a shift-held left-click can extend an existing
// selection instead of starting a fresh one.
const MOUSE_SHIFT_MASK = 4;
// Windows Terminal (1.25+) forwards shift+click/drag to the app during VT
// mouse mode while ALSO painting its own native selection — honoring the
// events would draw two overlapping highlights (app blue + WT white). In WT,
// drop every shift-modified button event so shift stays purely native
// (native highlight + native Ctrl+C copy); plain drag / ctrl+click /
// right-click remain the app-owned selection paths. Other terminals keep
// the shift-extend behavior (with XTSHIFTESCAPE opted in from index.jsx).
const IS_WINDOWS_TERMINAL = Boolean(process.env.WT_SESSION);

export function useMouseInput({
  inkInput,
  isRawModeSupported,
  store,
  stdout,
  rows,
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
  const zoomTimerRef = useRef(null);
  // Edge auto-scroll timer state (see the effect below). Owned at hook scope so
  // it survives re-subscribes; the drag itself lives on the App-owned dragRef.
  const edgeAutoscrollRef = useRef({ dir: 0, timer: null, noMove: 0 });

  const passthroughCtrlWheelZoom = useCallback(() => {
    if (!stdout?.write) return;
    try {
      stdout.write(MOUSE_TRACKING_OFF + ALT_SCROLL_OFF);
    } catch {
      return;
    }
    if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = setTimeout(() => {
      zoomTimerRef.current = null;
      try {
        stdout.write(ALT_SCROLL_ON + MOUSE_TRACKING_ON);
      } catch {
        // The terminal may already be closing.
      }
    }, 700);
    zoomTimerRef.current.unref?.();
  }, [stdout, zoomTimerRef]);

  useEffect(() => () => {
    if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
  }, [zoomTimerRef]);

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
    // Wheel modifier: wheel now arrives as a ParsedKey {name:'wheelup'|
    // 'wheeldown', sequence}. It has NO button field, so read the ctrl bit
    // (16) from the SGR button in the raw sequence `\x1b[<b;col;row…`. This is
    // the one place the raw sequence is still parsed; ParsedMouse (click/drag)
    // carries button/col/row/action pre-parsed and needs no regex.
    const WHEEL_SGR = /\x1b\[<(\d+);/;
    const linearSelection = (a, b) => {
      return {
        mode: 'linear',
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
      };
    };
    // Word/line multi-click drag-extension uses the hoisted buildSpanRect (same
    // logic reachable from the auto-scroll path in scrollTranscriptRows).
    const transcriptViewport = () => {
      const top = Math.max(0, Number(transcriptViewportRef.current?.top) || 0);
      const bottom = Math.max(top, Number(transcriptViewportRef.current?.bottom) || top);
      return { top, bottom };
    };
    const isInTranscriptViewport = (row) => {
      const { top, bottom } = transcriptViewport();
      return row >= top && row <= bottom;
    };
    const clampToTranscriptViewport = (row) => {
      const { top, bottom } = transcriptViewport();
      return Math.max(top, Math.min(bottom, row));
    };
    // [mixdog] Status-bar band = the bottom statuslineBandRows rows. The
    // prompt box occupies the rows reported by PromptInput's measured rect.
    const statusBand = () => {
      const rows = Math.max(1, Number(frameRowsRef.current) || 24);
      const top = Math.max(0, rows - statuslineBandRows);
      return { top, bottom: Math.max(top, rows - 1) };
    };
    const isInStatusBand = (row) => {
      const { top, bottom } = statusBand();
      return row >= top && row <= bottom;
    };
    const clampToStatusBand = (row) => {
      const { top, bottom } = statusBand();
      return Math.max(top, Math.min(bottom, row));
    };
    const promptRect = () => promptBoxRectRef.current;
    const isInPromptBox = (x, y) => {
      const r = promptRect();
      if (!r) return false;
      const top = Math.max(0, Number(r.top) || 0);
      const bottom = top + Math.max(1, Number(r.height) || 1) - 1;
      const left = Math.max(0, Number(r.left) || 0);
      const width = Math.max(1, Number(r.contentWidth) || 1);
      return y >= top && y <= bottom && x >= left && x < left + width;
    };
    // Map an absolute grid cell to a prompt-draft edit offset via PromptInput's
    // measured box rect + its caret math (offsetAtCell handles wrapping).
    const promptOffsetAt = (x, y) => {
      const r = promptRect();
      const ctl = promptMouseSelectionRef.current;
      if (!r || !ctl) return null;
      const top = Math.max(0, Number(r.top) || 0);
      const left = Math.max(0, Number(r.left) || 0);
      const height = Math.max(1, Number(r.height) || 1);
      const width = Math.max(1, Number(r.contentWidth) || 1);
      // Clamp the mapped row/col to the box's own bounds so a drag that runs
      // outside the prompt (above/below/left/right, e.g. onto the transcript
      // or off-screen) still tracks the nearest edge cell instead of jumping
      // to whatever offset a raw negative/overflowing row would resolve to.
      const row = Math.max(0, Math.min(height - 1, y - top));
      const col = Math.max(0, Math.min(width, x - left));
      return ctl.offsetAtCell(row, col);
    };
    // Clear whichever selection is active (ink-grid rect AND/OR prompt engine).
    const clearAllSelections = () => {
      promptMouseSelectionRef.current?.clear?.();
      applySelectionRect(null);
    };
    // Edge auto-scroll TIMER (ref: ScrollKeybindingHandler useDragToScroll).
    // SGR mode 1002 reports drag-motion only when the pointer changes CELL, so
    // a pointer held stationary at the top/bottom edge stops emitting events
    // and the motion-driven scroll below stalls. This interval keeps scrolling
    // — scrollTranscriptRows' active-drag branch re-extends the selection to
    // the still-held `last` cell each step — until the pointer leaves the edge,
    // the drag ends, or a scroll boundary is reached (delta clamps to 0).
    const EDGE_AUTOSCROLL_INTERVAL_MS = 50;
    const stopEdgeAutoscroll = () => {
      const st = edgeAutoscrollRef.current;
      if (st.timer) { clearInterval(st.timer); st.timer = null; }
      st.dir = 0;
      st.noMove = 0;
    };
    const startEdgeAutoscroll = (dir) => {
      const st = edgeAutoscrollRef.current;
      if (st.dir === dir && st.timer) return; // already scrolling this way
      stopEdgeAutoscroll();
      st.dir = dir;
      st.noMove = 0;
      st.timer = setInterval(() => {
        const drag = dragRef.current;
        const st2 = edgeAutoscrollRef.current;
        if (!drag.active || drag.region !== 'transcript' || st2.dir === 0) {
          stopEdgeAutoscroll();
          return;
        }
        const before = Number(scrollTargetRef.current) || 0;
        queueScrollCoalesced(st2.dir * 3);
        // A SINGLE unchanged tick is ambiguous: the coalescer may not have
        // flushed this delta yet (queued behind its 16ms leading-edge timer),
        // so scrollTarget legitimately reads the same value mid-flight. Only a
        // real top/bottom clamp keeps it pinned across several ticks. Require
        // CONSECUTIVE no-move ticks (>=3 ⇒ >150ms ≫ the 16ms coalescer window,
        // so any pending scroll has certainly flushed) before stopping — any
        // movement resets the counter (ref useDragToScroll's getScrollTop<=0 /
        // >=max boundary stop).
        if ((Number(scrollTargetRef.current) || 0) !== before) {
          st2.noMove = 0;
        } else if (++st2.noMove >= 3) {
          stopEdgeAutoscroll();
        }
      }, EDGE_AUTOSCROLL_INTERVAL_MS);
      st.timer.unref?.();
    };
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
      const finalY = region === 'status' ? clampToStatusBand(fy) : clampToTranscriptViewport(fy);
      drag.active = false;
      if (span) {
        const rect = buildSpanRect(span, fx, finalY, region, drag.anchorScroll);
        applySelectionRect(rect);
      } else {
        const anchor = region === 'status'
          ? drag.anchor
          : selectionPointAtCurrentScroll(drag.anchor, drag.anchorScroll);
        const rect = linearSelection(anchor, { x: fx, y: finalY });
        const empty = rect.x1 === rect.x2 && rect.y1 === rect.y2;
        if (empty) applySelectionRect(null);
        else applySelectionRect(rect);
      }
      if (TRANSCRIPT_MEASURED_ROWS) setMeasuredRowsVersion((v) => (v + 1) % 1000000);
    };
    // Typed 'mouse' channel handler. Receives one event per emit:
    //   • ParsedMouse {kind:'mouse',button,action,col,row,sequence} — click/drag
    //   • ParsedKey   {kind:'key',name:'wheelup'|'wheeldown',sequence} — wheel
    // (ink's App.js dispatchParsedEvent routes both here; it re-emits the raw
    //  sequence on 'input' only when nothing listens on 'mouse', so once this
    //  handler is registered it is the SOLE consumer of these events.)
    const onMouse = (event) => {
      if (!event || typeof event !== 'object') return;
      let up = 0;
      let down = 0;
      // Wheel arrives as a ParsedKey; no button/col/row fields.
      if (event.kind === 'key') {
        const name = event.name;
        if (name !== 'wheelup' && name !== 'wheeldown') return;
        const seq = typeof event.sequence === 'string' ? event.sequence : '';
        const wm = WHEEL_SGR.exec(seq);
        const ctrl = wm ? ((Number(wm[1]) & MOUSE_CTRL_MASK) !== 0) : false;
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
          } else {
            stopEdgeAutoscroll();
          }
          passthroughCtrlWheelZoom();
          return;
        }
        if (name === 'wheelup') up += 1;
        else down += 1;
        // Fall through to the wheel-scroll dispatch below (shared with the
        // previous SGR path) so slash-palette/overlay/scroll routing is identical.
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
          const STEP = 3; // rows per wheel notch; immediate updates feel steadier in Windows Terminal
          // Wheel while a selection is live (mid-drag OR after release) scrolls
          // the transcript instead of being dropped: scrollTranscriptRows'
          // active-drag branch rebuilds the rect (anchor→last), the released
          // branch shifts it — both keep the highlight and stitch-harvest the
          // rows that scroll off (ref ScrollKeybindingHandler wheel path).
          queueScrollCoalesced((up - down) * STEP);
        }
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
        // Shift bit must be read BEFORE baseButton drops every modifier bit
        // (button & 3); MOUSE_MODIFIER_MASK above is scroll-routing-only and
        // deliberately treats shift as noise there.
        const shiftHeld = (button & MOUSE_SHIFT_MASK) !== 0;
        const ctrlHeld = (button & MOUSE_CTRL_MASK) !== 0;
        // WT reserves shift+mouse for its NATIVE selection and (per its docs)
        // never forwards those events; keep this guard as a belt-and-braces so
        // a future WT that starts forwarding them can never double-paint.
        if (IS_WINDOWS_TERMINAL && shiftHeld) return;
        // WT's native (shift+drag) selection overlay is NOT cleared by our
        // incremental repaints — it would sit on top of the app selection as a
        // second highlight. Any app-owned button press means the user is done
        // with that native selection: force one full clear+rewrite frame
        // (BSU/ESU-wrapped, no flash) which dismisses it before we paint ours.
        if (IS_WINDOWS_TERMINAL && press && !isMotion) {
          store.forceRenderRepaint?.();
        }
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
              dragRef.current = { anchor: { x, y }, anchorScroll: 0, last: { x, y }, active: false, rect: null, region: 'prompt', anchorSpan: null };
              if (offset != null) ctl.extendTo?.(offset, true);
              lastClickRef.current = { x: -1, y: -1, t: 0 };
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
            return;
          }
          if (
            dragRef.current.region === regionR
            && !dragRef.current.anchorSpan
            && dragRef.current.anchor
            && dragRef.current.rect
            && !(dragRef.current.rect.x1 === dragRef.current.rect.x2 && dragRef.current.rect.y1 === dragRef.current.rect.y2)
          ) {
            promptMouseSelectionRef.current?.clear?.();
            const selectionY = regionR === 'status' ? clampToStatusBand(y) : clampToTranscriptViewport(y);
            const anchor = regionR === 'status'
              ? dragRef.current.anchor
              : selectionPointAtCurrentScroll(dragRef.current.anchor, dragRef.current.anchorScroll);
            const rect = linearSelection(anchor, { x, y: selectionY });
            stopSmoothScroll();
            dragRef.current = { ...dragRef.current, last: { x, y: selectionY }, active: false, region: regionR };
            applySelectionRect(rect);
            lastClickRef.current = { x, y, t: nowR, count: 1 };
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
            dragRef.current = { anchor: { x, y }, anchorScroll: 0, last: { x, y }, active: true, rect: null, region: 'prompt', anchorSpan: null };
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
            const qualifiesPrompt = (nowPrompt - lcPrompt.t) < 500
              && Math.abs(lcPrompt.y - y) <= 1
              && Math.abs(lcPrompt.x - x) <= 2;
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
            return;
          }
          const region = inTranscript ? 'transcript' : 'status';
          // A press always clears the prompt-box selection (single active region).
          promptMouseSelectionRef.current?.clear?.();
          const now = Date.now();
          // Shift+click on an existing word/line (anchorSpan) selection extends
          // that selection by whole words/lines to the click point, preserving
          // the original anchor span (mirrors selection.ts extendSelection).
          if (
            extendHeld
            && dragRef.current.region === region
            && dragRef.current.anchorSpan
          ) {
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
            extendHeld
            && dragRef.current.region === region
            && !dragRef.current.anchorSpan
            && dragRef.current.anchor
            && dragRef.current.rect
            && !(dragRef.current.rect.x1 === dragRef.current.rect.x2 && dragRef.current.rect.y1 === dragRef.current.rect.y2)
          ) {
            const selectionY = region === 'status' ? clampToStatusBand(y) : clampToTranscriptViewport(y);
            const anchor = region === 'status'
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
          const qualifies = (now - lc.t) < 500
            && Math.abs(lc.y - y) <= 1
            && Math.abs(lc.x - x) <= 2;
          let clickCount = qualifies ? (lc.count || 1) + 1 : 1;
          if (clickCount > 3) clickCount = 1;
          if (clickCount === 2 || clickCount === 3) {
            // Word (2) or line (3) select. Snap to the word/line under the cell
            // and record the span on dragRef so a following drag extends by whole
            // words/lines from this span (see buildSpanRect). Leave the drag
            // ARMED (active:true): a release without motion keeps this highlight
            // (buildSpanRect returns the span for an in-span target), while
            // any motion extends it. Mirrors selectWordAt/selectLineAt setting
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
          // current cell, clamped to the owning region's band.
          const selectionY = region === 'status' ? clampToStatusBand(y) : clampToTranscriptViewport(y);
          const prevDragY = dragRef.current.last ? Number(dragRef.current.last.y) : y;
          dragRef.current.last = { x, y: selectionY };
          const span = dragRef.current.anchorSpan;
          if (span) {
            // Word/line multi-click drag: extend by whole words/lines from the
            // anchor span to the word/line under the cursor (see buildSpanRect).
            const rect = buildSpanRect(span, x, selectionY, region, dragRef.current.anchorScroll);
            applySelectionRectThrottled(rect);
          } else {
            const anchor = region === 'status'
              ? dragRef.current.anchor
              : selectionPointAtCurrentScroll(dragRef.current.anchor, dragRef.current.anchorScroll);
            const rect = linearSelection(anchor, { x, y: selectionY });
            applySelectionRectThrottled(rect);
          }
          // Auto-scroll-while-dragging is transcript-only (the status band does
          // not scroll).
          if (region === 'transcript') {
            const frameRows = Math.max(1, Number(rows) || 24);
            const { top, bottom } = transcriptViewport();
            // Edge auto-scroll only when the pointer pushes TOWARD the edge:
            // either this motion moved vertically toward it, or the pointer
            // sits beyond the transcript viewport rows entirely. A horizontal
            // drag along the top/bottom rows must NOT scroll — it used to
            // scroll away the very rows being selected.
            if (y <= 1 && (y < prevDragY || y < top)) {
              queueScrollCoalesced(3);
              startEdgeAutoscroll(1);
            } else if (y >= frameRows - 5 && (y > prevDragY || y > bottom)) {
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
        }
      }
    };
    inkInput.on('mouse', onMouse);
    return () => {
      inkInput.off('mouse', onMouse);
      stopEdgeAutoscroll();
    };
  }, [inkInput, isRawModeSupported, store, passthroughCtrlWheelZoom, rows, scrollTranscriptRows, queueScrollCoalesced, applySelectionRect, applySelectionRectThrottled, selectionPointAtCurrentScroll, buildSpanRect]);
}
