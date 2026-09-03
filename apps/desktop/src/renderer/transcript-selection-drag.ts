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
 *    a drag releases tail following like any other reader scroll.
 */

export type TranscriptSelectionEndpoint = { key: unknown; index: number };
export type TranscriptSelectionPin = {
  anchor: TranscriptSelectionEndpoint;
  focus: TranscriptSelectionEndpoint;
};

const ROW_SELECTOR = ".transcript-virtual-row";

export function transcriptSelectionPointerRegion(
  pointerX: number,
  pointerY: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): "inside" | "above" | "below" | "side" {
  if (pointerY < top) return "above";
  if (pointerY > bottom) return "below";
  if (pointerX < left || pointerX > right) return "side";
  return "inside";
}

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
  const pointerOutsideVertically = (): boolean => {
    const view = root.getBoundingClientRect();
    const region = transcriptSelectionPointerRegion(
      lastPointer.x, lastPointer.y, view.left, view.top, view.right, view.bottom);
    return region === "above" || region === "below";
  };

  /** Pin from the range the document holds right now. */
  const syncPin = () => {
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
    seed = null;
    markSelecting(false);
    syncPin();
  };
  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
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
    if (!selecting) return;
    if (!transcriptSelectionPrimaryButtonDown(event.buttons)) {
      finishSelection();
      return;
    }
    lastPointer = { x: event.clientX, y: event.clientY };
  };
  const handleScroll = () => {
    const top = root.scrollTop;
    const delta = top - lastScrollTop;
    lastScrollTop = top;
    if (!selecting || !delta || !pointerOutsideVertically()) return;
    onAutoScroll(delta);
  };

  root.addEventListener("pointerdown", handlePointerDown, true);
  root.addEventListener("scroll", handleScroll, { passive: true });
  document.addEventListener("pointermove", handlePointerMove, true);
  document.addEventListener("pointerup", finishSelection, true);
  document.addEventListener("pointercancel", finishSelection, true);
  document.addEventListener("selectionchange", syncPin);
  window.addEventListener("blur", finishSelection);
  return () => {
    root.removeEventListener("pointerdown", handlePointerDown, true);
    root.removeEventListener("scroll", handleScroll);
    document.removeEventListener("pointermove", handlePointerMove, true);
    document.removeEventListener("pointerup", finishSelection, true);
    document.removeEventListener("pointercancel", finishSelection, true);
    document.removeEventListener("selectionchange", syncPin);
    window.removeEventListener("blur", finishSelection);
    selecting = false;
    seed = null;
    markSelecting(false);
    setPin(null);
  };
}
