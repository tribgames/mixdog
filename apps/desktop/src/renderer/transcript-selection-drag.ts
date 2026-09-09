/**
 * Transcript text-selection drag — Chromium owns the range, this module
 * owns what the virtual list needs to know about it.
 *
 * The browser is the ONE writer of the Selection for a mouse drag. Every
 * attempt to co-author it from script fought Chromium's own per-move
 * handling: canceling `mousemove` no longer suppresses native extension
 * (Chromium 122+), so a script write plus the native write made two authors
 * per pixel (the flicker); and a script write landing before Chromium's own
 * drag resolution put the press point inside a live range, which starts a
 * drag-and-drop of the selected text and swallows the gesture (no drag at
 * all). The same boundary VS Code's chat list keeps: never touch the range,
 * only observe it.
 *
 * What script still has to do:
 *  - pin the rows the range spans so virtualization keeps both boundary nodes
 *    mounted while native autoscroll moves the viewport (an unmounted
 *    boundary makes Chromium reconnect the range to an unrelated node);
 *  - mark the gesture on <html> and the pressed viewport so CSS can make the
 *    transcript the only selectable surface for its duration: Chromium then
 *    clamps a pointer that leaves the viewport to the first/last row instead
 *    of jumping to whatever selectable text follows in DOM order;
 *  - report native autoscroll to the follow hook so an upward scroll during
 *    a drag releases tail following like any other reader scroll;
 *  - while the pointer is OUTSIDE the viewport, re-aim the range's moving end
 *    at the caret under the pointer clamped to the viewport edge. Chromium
 *    cannot resolve such a point itself: the rows are out-of-flow (absolute)
 *    children, which its position-for-point walk skips, so it falls back to
 *    the FIRST/LAST mounted row — with the live row always mounted at the
 *    end, a drag past the composer jumped to the end of the session, and a
 *    sideways exit flipped the range to the first overscan row (user:
 *    드래그가 뒤집히거나 엉뚱하게 처리). The write lands in rAF, which runs
 *    after Chromium's per-move write and before paint: one painted author
 *    per frame, so the flicker of the old per-move co-authoring never
 *    returns, and native autoscroll keeps advancing the edge the caret sits
 *    on. Release keeps the fence and pins until one final frame corrects
 *    Chromium's last write, then hands the settled range to virtualization.
 */

import {
  caretFromPoint,
  clampTranscriptSelectionPoint,
  nearestTranscriptSelectionRow,
  transcriptSelectionPointerRegion,
} from "./transcript-selection-caret";

export {
  clampTranscriptSelectionPoint,
  nearestTranscriptSelectionRow,
  transcriptSelectionPointerRegion,
} from "./transcript-selection-caret";

export type TranscriptSelectionEndpoint = { key: unknown; index: number };
export type TranscriptSelectionPin = {
  anchor: TranscriptSelectionEndpoint;
  focus: TranscriptSelectionEndpoint;
};

const ROW_SELECTOR = ".transcript-virtual-row";

/** How far each inward attempt steps along the line and how many are made:
 *  enough to clear a row's horizontal padding and the floating jump pill. */
const INWARD_STEP_PX = 16;
const INWARD_ATTEMPTS = 8;

/** Only the primary button's release ends a selection gesture; a move that
 *  arrives without it means the release happened outside the renderer. */
export function transcriptSelectionPrimaryButtonDown(buttons: number): boolean {
  return Number.isInteger(buttons) && (buttons & 1) === 1;
}

function isTextFieldElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return element.tagName === "TEXTAREA" || element.tagName === "INPUT" || element.isContentEditable;
}

export interface TranscriptSelectionDragOptions {
  /** The scrolling viewport that contains the virtual rows. */
  root: HTMLElement;
  /** Row key at a live index; undefined when the index is out of range. */
  rowKeyAt(index: number): unknown;
  /** Rows the virtualizer must keep mounted while the range spans them. */
  setPin(pin: TranscriptSelectionPin | null): void;
  /** Native autoscroll delta while the pointer is outside the viewport. */
  onAutoScroll(delta: number): void;
}

/** Attach the observer to a mounted viewport; the return value detaches it. */
export function attachTranscriptSelectionDrag(
  options: TranscriptSelectionDragOptions,
): () => void {
  const { root, rowKeyAt, setPin, onAutoScroll } = options;

  let selecting = false;
  let finishing = false;
  let seed: TranscriptSelectionEndpoint | null = null;
  let lastPointer = { x: 0, y: 0 };
  let lastScrollTop = 0;

  const endpointForNode = (node: Node | null): TranscriptSelectionEndpoint | null => {
    const element = node instanceof Element ? node : node?.parentElement;
    const row = element?.closest<HTMLElement>(ROW_SELECTOR) ?? null;
    if (!row || !root.contains(row)) return null;
    const index = Number(row.dataset.index);
    const key = rowKeyAt(index);
    return Number.isInteger(index) && key !== undefined ? { key, index } : null;
  };
  /** <html> carries the gesture; the pressed viewport carries the fence
   *  exception, so CSS can make it the only selectable surface. */
  const markSelecting = (active: boolean) => {
    if (active) {
      document.documentElement.dataset.transcriptSelecting = "true";
      root.dataset.transcriptSelectionRoot = "true";
    } else {
      delete document.documentElement.dataset.transcriptSelecting;
      delete root.dataset.transcriptSelectionRoot;
    }
  };
  /** The scroller's content box. Its bounding rect includes the reserved
   *  scrollbar gutter (.transcript keeps `scrollbar-gutter: stable`), and a
   *  caret read inside the gutter resolves to the scroller itself — no row —
   *  so a drag out of the window's RIGHT edge got no correction at all and
   *  Chromium's first-row fallback showed as the range flipping (user: 앱 창
   *  밖으로 드래그한 커서가 나가면 커서포인트를 잃어 드래그가 뒤집혀). */
  const contentBox = (): DOMRect => {
    const rect = root.getBoundingClientRect();
    return new DOMRect(
      rect.left + root.clientLeft,
      rect.top + root.clientTop,
      root.clientWidth,
      root.clientHeight,
    );
  };
  const pointerRegion = (view: DOMRect) => transcriptSelectionPointerRegion(
    lastPointer.x, lastPointer.y, view.left, view.top, view.right, view.bottom);
  const pointerOutsideVertically = (): boolean => {
    const region = pointerRegion(contentBox());
    return region === "above" || region === "below";
  };

  // Outside-viewport correction (see the header). One rAF loop per gesture
  // segment spent outside; it ends itself the moment the pointer is back
  // inside or the gesture finishes.
  let outsideFrame = 0;
  /** Mounted rows that carry text, as boxes; turn gaps never take a caret. */
  const textRowBoxes = (): DOMRect[] => Array.from(root.querySelectorAll<HTMLElement>(ROW_SELECTOR))
    .filter((row) => (row.textContent ?? "").trim().length > 0)
    .map((row) => row.getBoundingClientRect())
    .filter((rect) => rect.height > 0);
  /** Chromium resolves the range itself only while the pointer is over a
   *  row; anywhere else inside the scroller (gaps, padding, the jump pill)
   *  it falls back to a boundary row. */
  const rowUnderPointer = (): boolean => {
    const element = document.elementFromPoint(lastPointer.x, lastPointer.y);
    const row = element?.closest<HTMLElement>(ROW_SELECTOR) ?? null;
    return row !== null && root.contains(row);
  };
  const extendToNearestRowCaret = (view: DOMRect) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    // A new selection elsewhere before the final frame belongs to that surface.
    if (!endpointForNode(selection.anchorNode)) return;
    const point = clampTranscriptSelectionPoint(
      lastPointer.x, lastPointer.y, view.left, view.top, view.right, view.bottom);
    const row = nearestTranscriptSelectionRow(textRowBoxes(), point.y);
    if (!row) return;
    // Keep the column, land inside the row's box, then walk in from its
    // horizontal padding (or the pill floating over it) until the caret
    // resolves to a row.
    const target = clampTranscriptSelectionPoint(
      point.x, point.y, row.left, row.top, row.right, row.bottom);
    const inward = target.x > (row.left + row.right) / 2 ? -1 : 1;
    for (let attempt = 0; attempt < INWARD_ATTEMPTS; attempt += 1) {
      const caret = caretFromPoint(target.x + inward * attempt * INWARD_STEP_PX, target.y);
      if (!caret || !endpointForNode(caret.node)) continue;
      if (selection.focusNode === caret.node && selection.focusOffset === caret.offset) return;
      selection.extend(caret.node, caret.offset);
      return;
    }
  };
  const syncOutside = () => {
    outsideFrame = 0;
    if (!selecting) return;
    const view = contentBox();
    const needsCorrection = pointerRegion(view) !== "inside" || !rowUnderPointer();
    if (needsCorrection) extendToNearestRowCaret(view);
    if (finishing) finishSelection();
    else if (needsCorrection) outsideFrame = window.requestAnimationFrame(syncOutside);
  };
  const scheduleOutsideSync = () => {
    if (!outsideFrame) outsideFrame = window.requestAnimationFrame(syncOutside);
  };
  const cancelOutsideSync = () => {
    if (outsideFrame) window.cancelAnimationFrame(outsideFrame);
    outsideFrame = 0;
  };

  /** Pin from the range the document holds right now. */
  const syncPin = () => {
    // Do not publish Chromium's transient release fallback to virtualization.
    if (finishing) return;
    // Every composer keystroke moves the caret and fires selectionchange.
    // Reading the Selection forces style + layout over the whole document,
    // and a caret in a text field is never a transcript range.
    if (!selecting && isTextFieldElement(document.activeElement)) {
      setPin(null);
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      if (!selecting) setPin(null);
      return;
    }
    const anchor = endpointForNode(selection.anchorNode);
    const focus = endpointForNode(selection.focusNode);
    if (anchor && focus) {
      setPin({ anchor, focus });
      return;
    }
    // Native autoscroll can place one boundary just outside the mounted range
    // for a frame. Keep the press row and the surviving boundary pinned.
    const inside = anchor ?? focus;
    if (selecting && seed && inside) setPin({ anchor: seed, focus: inside });
    else if (!selecting && !anchor && !focus) setPin(null);
  };

  const finishSelection = () => {
    if (!selecting) return;
    selecting = false;
    finishing = false;
    seed = null;
    cancelOutsideSync();
    markSelecting(false);
    syncPin();
  };
  const requestFinish = () => {
    if (!selecting || finishing) return;
    // pointerup is captured before Chromium finishes its native range write.
    // Reuse the edge frame instead of cancelling the last correction.
    finishing = true;
    scheduleOutsideSync();
  };
  const handlePointerUp = (event: PointerEvent) => {
    if (!selecting || finishing || event.button !== 0) return;
    lastPointer = { x: event.clientX, y: event.clientY };
    requestFinish();
  };
  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    // A fresh press supersedes any deferred finish without rewriting its range.
    finishSelection();
    const target = event.target as Node | null;
    if (isTextFieldElement(target instanceof Element ? target : null)) return;
    const endpoint = endpointForNode(target);
    if (!endpoint) return;
    selecting = true;
    seed = endpoint;
    lastPointer = { x: event.clientX, y: event.clientY };
    lastScrollTop = root.scrollTop;
    markSelecting(true);
    // Pin the press row now, before native autoscroll can move it out of the
    // virtual range on the first frame of the drag.
    setPin({ anchor: endpoint, focus: endpoint });
  };
  const handlePointerMove = (event: PointerEvent) => {
    if (!selecting || finishing) return;
    if (!transcriptSelectionPrimaryButtonDown(event.buttons)) {
      // The release was outside; a returning hover is not its final coordinate.
      requestFinish();
      return;
    }
    lastPointer = { x: event.clientX, y: event.clientY };
    scheduleOutsideSync();
  };
  const handleScroll = () => {
    const top = root.scrollTop;
    const delta = top - lastScrollTop;
    lastScrollTop = top;
    if (!selecting || finishing || !delta || !pointerOutsideVertically()) return;
    onAutoScroll(delta);
  };

  root.addEventListener("pointerdown", handlePointerDown, true);
  root.addEventListener("scroll", handleScroll, { passive: true });
  document.addEventListener("pointermove", handlePointerMove, true);
  document.addEventListener("pointerup", handlePointerUp, true);
  document.addEventListener("pointercancel", requestFinish, true);
  document.addEventListener("selectionchange", syncPin);
  window.addEventListener("blur", requestFinish);
  return () => {
    root.removeEventListener("pointerdown", handlePointerDown, true);
    root.removeEventListener("scroll", handleScroll);
    document.removeEventListener("pointermove", handlePointerMove, true);
    document.removeEventListener("pointerup", handlePointerUp, true);
    document.removeEventListener("pointercancel", requestFinish, true);
    document.removeEventListener("selectionchange", syncPin);
    window.removeEventListener("blur", requestFinish);
    selecting = false;
    finishing = false;
    seed = null;
    cancelOutsideSync();
    markSelecting(false);
    setPin(null);
  };
}
