/** Anchored overlay geometry for the Source Control dropdowns.
 *
 *  GitHub Desktop can hard-code its foldout widths (app/styles/ui/_branches.scss:3-16
 *  pins the branch list at 365px) because its toolbar spans a full window. Our
 *  dock floors at DESKTOP_UTILITY_DOCK_MIN_WIDTH (shared/window-layout.ts) and
 *  sits against the window's right edge, so every panel has to align to its
 *  trigger, then be clamped — shifted or flipped — into the allowed bounds and
 *  capped to the space that is actually there. Same grammar as the shared
 *  select menu (OpenSelect.tsx:73-126), extracted so the SCM overlays and the
 *  DOM tests can share one pure rule set. */

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface AnchoredPanelInput {
  /** Trigger box in viewport coordinates. */
  trigger: AnchorRect;
  /** Allowed area in viewport coordinates (window, or a containing panel). */
  bounds: AnchorRect;
  /** Width the panel wants when there is room for it. */
  preferredWidth: number;
  /** Width below which the panel stops shrinking (unless bounds are smaller). */
  minWidth?: number;
  /** Unclamped panel height, used to decide whether it fits on a side. */
  naturalHeight: number;
  /** Which trigger edge the panel lines up with. */
  align?: "start" | "end";
  /** Side the panel opens toward when it fits there. */
  placement?: "below" | "above";
  /** Space between the trigger and the panel. */
  gap?: number;
  /** Minimum inset kept from every bounds edge. */
  edge?: number;
}

export interface AnchoredPanelGeometry {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: "below" | "above";
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

/** The smallest panel height worth opening on a side before flipping. */
const MIN_USEFUL_HEIGHT = 96;

export function anchoredPanelGeometry({
  trigger,
  bounds,
  preferredWidth,
  minWidth = 0,
  naturalHeight,
  align = "start",
  placement = "below",
  gap = 4,
  edge = 8,
}: AnchoredPanelInput): AnchoredPanelGeometry {
  const available = Math.max(0, bounds.right - bounds.left - edge * 2);
  // Cap to the space that exists instead of the reference's fixed width.
  const width = Math.min(Math.max(preferredWidth === 0 ? 0 : minWidth, Math.min(preferredWidth, available)), available);
  const idealLeft = align === "end" ? trigger.right - width : trigger.left;
  const left = clamp(idealLeft, bounds.left + edge, bounds.right - edge - width);

  const spaceBelow = Math.max(0, bounds.bottom - edge - trigger.bottom - gap);
  const spaceAbove = Math.max(0, trigger.top - gap - (bounds.top + edge));
  const wanted = placement === "above" ? spaceAbove : spaceBelow;
  const other = placement === "above" ? spaceBelow : spaceAbove;
  const threshold = Math.min(naturalHeight, MIN_USEFUL_HEIGHT);
  // Flip only when the preferred side cannot host a useful panel AND the other
  // side is roomier; otherwise stay put and cap the height.
  const flipped = wanted < threshold && other > wanted;
  const above = placement === "above" ? !flipped : flipped;
  const maxHeight = above ? spaceAbove : spaceBelow;
  const height = Math.min(naturalHeight, maxHeight);
  const top = above
    ? clamp(trigger.top - gap - height, bounds.top + edge, Math.max(bounds.top + edge, bounds.bottom - edge - height))
    : clamp(trigger.bottom + gap, bounds.top + edge, Math.max(bounds.top + edge, bounds.bottom - edge - height));

  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    maxHeight: Math.round(maxHeight),
    placement: above ? "above" : "below",
  };
}

export const rectFrom = (element: Element): AnchorRect => {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
};

export const viewportRect = (): AnchorRect => {
  const visual = typeof window !== "undefined" ? window.visualViewport : null;
  const width = visual?.width ?? (typeof window === "undefined" ? 0 : window.innerWidth);
  const height = visual?.height ?? (typeof window === "undefined" ? 0 : window.innerHeight);
  const left = visual?.offsetLeft ?? 0;
  const top = visual?.offsetTop ?? 0;
  return { left, top, right: left + width, bottom: top + height, width, height };
};

/** Bounds = the allowed area intersected with the window. */
export const intersectRects = (first: AnchorRect, second: AnchorRect): AnchorRect => {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  return {
    left,
    top,
    right: Math.max(left, right),
    bottom: Math.max(top, bottom),
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
};
