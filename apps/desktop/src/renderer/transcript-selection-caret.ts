/** Geometry shared by native transcript selection and its edge correction. */
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

/** Stay inside the content box rather than its border or scrollbar gutter. */
const CLAMP_EDGE_INSET = 2;

/** Clamp each axis independently, preserving the pointer's column or line. */
export function clampTranscriptSelectionPoint(
  pointerX: number,
  pointerY: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): { x: number; y: number } {
  const clamp = (value: number, min: number, max: number) => (
    max <= min ? min : Math.min(Math.max(value, min), max)
  );
  return {
    x: clamp(pointerX, left + CLAMP_EDGE_INSET, right - CLAMP_EDGE_INSET),
    y: clamp(pointerY, top + CLAMP_EDGE_INSET, bottom - CLAMP_EDGE_INSET),
  };
}

/** Gaps and padding resolve to the nearest text row, not an overscan row. */
export function nearestTranscriptSelectionRow<T extends { top: number; bottom: number }>(
  rows: readonly T[],
  y: number,
): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const row of rows) {
    const distance = y < row.top ? row.top - y : y > row.bottom ? y - row.bottom : 0;
    if (distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }
  return best;
}

type CaretPoint = { node: Node; offset: number };

export function caretFromPoint(x: number, y: number): CaretPoint | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}
