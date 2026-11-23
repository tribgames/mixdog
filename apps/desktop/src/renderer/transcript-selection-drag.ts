import {
  caretFromPoint,
  clampTranscriptSelectionPoint,
  nearestTranscriptSelectionRow,
  transcriptSelectionPointerRegion,
} from './transcript-selection-caret';

export {
  clampTranscriptSelectionPoint,
  nearestTranscriptSelectionRow,
  transcriptSelectionPointerRegion,
} from './transcript-selection-caret';

export type TranscriptSelectionEndpoint = { key: unknown; index: number };
export type TranscriptSelectionPin = {
  anchor: TranscriptSelectionEndpoint;
  focus: TranscriptSelectionEndpoint;
};

const ROW_SELECTOR = '.transcript-virtual-row';

/** How far each inward attempt steps along the line and how many are made:
 *  enough to clear a row's horizontal padding and the floating jump pill. */
const INWARD_STEP_PX = 16;
const INWARD_ATTEMPTS = 8;

/** Only the primary button's release ends a selection gesture; a move that
 *  arrives without it means the release happened outside the renderer. */
export function transcriptSelectionPrimaryButtonDown(buttons: number): boolean {
  return Number.isInteger(buttons) && (buttons & 1) === 1;
}

/** Touch and pen presses scroll; only a mouse press can start a drag. */
function touchLikePointer(event: PointerEvent): boolean {
  return event.pointerType === 'touch' || event.pointerType === 'pen';
}

function isTextFieldElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return element.tagName === 'TEXTAREA' || element.tagName === 'INPUT' || element.isContentEditable;
}

interface TranscriptSelectionDragOptions {
  /** The scrolling viewport that contains the virtual rows. */
  root: HTMLElement;
  /** Row key at a live index; undefined when the index is out of range. */
  rowKeyAt(index: number): unknown;
  /** Rows the virtualizer must keep mounted while the range spans them. */
  setPin(pin: TranscriptSelectionPin | null): void;
  /** Native autoscroll delta while the pointer is outside the viewport. */
  onAutoScroll(delta: number): void;
  /** A selection covers transcript text, wherever its ends lie, or is being dragged out (true); none does (false). */
  onHold?(held: boolean): void;
}

/** Attach the observer to a mounted viewport; the return value detaches it. */
export function attachTranscriptSelectionDrag(options: TranscriptSelectionDragOptions): () => void {
  const { root, rowKeyAt, setPin, onAutoScroll, onHold = () => {} } = options;

  let selecting = false;
  let finishing = false;
  let seed: TranscriptSelectionEndpoint | null = null;
  /** A mouse press on a row that has not moved yet. A click never becomes a
   *  gesture, so it never marks, pins or reads the Selection on release. */
  let pressed: TranscriptSelectionEndpoint | null = null;
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
      document.documentElement.dataset.transcriptSelecting = 'true';
      root.dataset.transcriptSelectionRoot = 'true';
    } else {
      delete document.documentElement.dataset.transcriptSelecting;
      delete root.dataset.transcriptSelectionRoot;
    }
  };
  /** The scroller's content box: its bounding rect includes the scrollbar
   *  gutter, where a caret read resolves to the scroller itself, not a row. */
  const contentBox = (): DOMRect => {
    const rect = root.getBoundingClientRect();
    return new DOMRect(rect.left + root.clientLeft, rect.top + root.clientTop, root.clientWidth, root.clientHeight);
  };
  const pointerRegion = (view: DOMRect) =>
    transcriptSelectionPointerRegion(lastPointer.x, lastPointer.y, view.left, view.top, view.right, view.bottom);
  const pointerOutsideVertically = (): boolean => {
    const region = pointerRegion(contentBox());
    return region === 'above' || region === 'below';
  };

  // Outside-viewport correction (see the header). One rAF loop per gesture
  // segment spent outside; it ends itself the moment the pointer is back
  // inside or the gesture finishes.
  let outsideFrame = 0;
  /** Mounted rows that carry text, as boxes; turn gaps never take a caret. */
  const textRowBoxes = (): DOMRect[] =>
    Array.from(root.querySelectorAll<HTMLElement>(ROW_SELECTOR))
      .filter((row) => (row.textContent ?? '').trim().length > 0)
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
      lastPointer.x,
      lastPointer.y,
      view.left,
      view.top,
      view.right,
      view.bottom
    );
    const row = nearestTranscriptSelectionRow(textRowBoxes(), point.y);
    if (!row) return;
    // Keep the column, land inside the row's box, then walk in from its
    // horizontal padding (or the pill floating over it) until the caret
    // resolves to a row.
    const target = clampTranscriptSelectionPoint(point.x, point.y, row.left, row.top, row.right, row.bottom);
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
    const needsCorrection = pointerRegion(view) !== 'inside' || !rowUnderPointer();
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

  /** Does the selection cover transcript text? A select-all anchored outside the rows covers them too. */
  const coversTranscript = (selection: Selection | null): boolean => {
    if (!selection || selection.isCollapsed) return false;
    for (let index = 0; index < selection.rangeCount; index += 1) {
      if (selection.getRangeAt(index).intersectsNode(root)) return true;
    }
    return false;
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
      onHold(false);
      return;
    }
    const selection = window.getSelection();
    onHold(selecting || coversTranscript(selection));
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
    if (event.button === 0) pressed = null;
    if (!selecting || finishing || event.button !== 0) return;
    lastPointer = { x: event.clientX, y: event.clientY };
    requestFinish();
  };
  const cancelGesture = () => {
    pressed = null;
    requestFinish();
  };
  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || touchLikePointer(event)) return;
    // A fresh press supersedes any deferred finish without rewriting its range.
    finishSelection();
    pressed = null;
    const target = event.target as Node | null;
    if (isTextFieldElement(target instanceof Element ? target : null)) return;
    pressed = endpointForNode(target);
    lastPointer = { x: event.clientX, y: event.clientY };
  };
  const startSelection = (endpoint: TranscriptSelectionEndpoint) => {
    selecting = true;
    seed = endpoint;
    lastScrollTop = root.scrollTop;
    markSelecting(true);
    onHold(true);
    // Pin the press row now, before native autoscroll can move it out of the
    // virtual range on the first frame of the drag.
    setPin({ anchor: endpoint, focus: endpoint });
  };
  const handlePointerMove = (event: PointerEvent) => {
    if (pressed) {
      const endpoint = pressed;
      pressed = null;
      // Without the button the release happened outside: it was a click.
      if (!transcriptSelectionPrimaryButtonDown(event.buttons)) return;
      startSelection(endpoint);
    }
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
    // Every other scroll (touch flings included) leaves layout unread.
    if (!selecting || finishing) return;
    const top = root.scrollTop;
    const delta = top - lastScrollTop;
    lastScrollTop = top;
    if (!delta || !pointerOutsideVertically()) return;
    onAutoScroll(delta);
  };

  root.addEventListener('pointerdown', handlePointerDown, true);
  root.addEventListener('scroll', handleScroll, { passive: true });
  document.addEventListener('pointermove', handlePointerMove, true);
  document.addEventListener('pointerup', handlePointerUp, true);
  document.addEventListener('pointercancel', cancelGesture, true);
  document.addEventListener('selectionchange', syncPin);
  window.addEventListener('blur', cancelGesture);
  // A transcript coming back on screen may find its text still selected.
  if (coversTranscript(window.getSelection())) syncPin();
  return () => {
    root.removeEventListener('pointerdown', handlePointerDown, true);
    root.removeEventListener('scroll', handleScroll);
    document.removeEventListener('pointermove', handlePointerMove, true);
    document.removeEventListener('pointerup', handlePointerUp, true);
    document.removeEventListener('pointercancel', cancelGesture, true);
    document.removeEventListener('selectionchange', syncPin);
    window.removeEventListener('blur', cancelGesture);
    selecting = false;
    finishing = false;
    seed = null;
    pressed = null;
    cancelOutsideSync();
    markSelecting(false);
    setPin(null);
    onHold(false);
  };
}
