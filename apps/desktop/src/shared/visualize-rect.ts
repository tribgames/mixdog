// Rectangles of the visualize feedback layer (one set, for the panel and the
// gates). Kept apart from visualize-feedback.ts so the composer's feedback
// store can validate stored pins without pulling the page-script sources
// into the first screen.

export interface VisualizeFeedbackRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const sameRect = (a: VisualizeFeedbackRect, b: VisualizeFeedbackRect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** The overlap of two rectangles, or null under 1px either way. */
export function intersectRect(a: VisualizeFeedbackRect, b: VisualizeFeedbackRect): VisualizeFeedbackRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right - x >= 1 && bottom - y >= 1 ? { x, y, width: right - x, height: bottom - y } : null;
}

/** A DOMRect-like box as a rectangle. */
export const rectOfBox = (box: {
  left: number;
  top: number;
  width: number;
  height: number;
}): VisualizeFeedbackRect => ({
  x: box.left,
  y: box.top,
  width: box.width,
  height: box.height,
});

/** The rectangle two points span. */
export const spanRect = (a: { x: number; y: number }, b: { x: number; y: number }): VisualizeFeedbackRect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});

const unit = (value: number): number => Math.min(1, Math.max(0, value));

/** `rect` as fractions (0-1, clamped) of `frame`; both in one space. */
export function rectToFractions(rect: VisualizeFeedbackRect, frame: VisualizeFeedbackRect): VisualizeFeedbackRect {
  if (!frame.width || !frame.height) return { x: 0, y: 0, width: 0, height: 0 };
  const x = unit((rect.x - frame.x) / frame.width);
  const y = unit((rect.y - frame.y) / frame.height);
  return {
    x,
    y,
    width: Math.max(0, unit((rect.x + rect.width - frame.x) / frame.width) - x),
    height: Math.max(0, unit((rect.y + rect.height - frame.y) / frame.height) - y),
  };
}

/** Fractions of `frame` back in `frame`'s space. */
export const rectFromFractions = (
  rect: VisualizeFeedbackRect,
  frame: VisualizeFeedbackRect
): VisualizeFeedbackRect => ({
  x: frame.x + rect.x * frame.width,
  y: frame.y + rect.y * frame.height,
  width: rect.width * frame.width,
  height: rect.height * frame.height,
});

export const roundRect = (rect: VisualizeFeedbackRect, digits = 4): VisualizeFeedbackRect => {
  const round = (value: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
};

const UNIT_FRAME: VisualizeFeedbackRect = { x: 0, y: 0, width: 1, height: 1 };

/** A rectangle of fractions (0-1) clamped inside the unit square and
 *  rounded, or null when nothing of it is left. */
export function visualizeUnitRect(rect: VisualizeFeedbackRect): VisualizeFeedbackRect | null {
  const unitRect = roundRect(rectToFractions(rect, UNIT_FRAME));
  return unitRect.width > 0 && unitRect.height > 0 ? unitRect : null;
}
