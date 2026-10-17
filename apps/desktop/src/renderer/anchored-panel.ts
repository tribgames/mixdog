/** One placement rule for every trigger-anchored popup (user: 팝업 열리는
 *  위치 통일). Default: BELOW the trigger with the left edges aligned
 *  (bottom-start), 6px from the trigger and 8px inside the bounds (the
 *  trigger's pane, clipped to what is visible). A trigger at the trailing
 *  edge of a row aligns right edges (`align: 'end'`); a trigger at the bottom
 *  of the screen (composer controls) asks for `placement: 'above'`. The panel
 *  flips only when the preferred side cannot hold all of it and the other
 *  side is roomier, shifts horizontally into the bounds, and is capped to the
 *  room on the chosen side. Selects, ⋯ menus, the dock menu, the branch chip,
 *  the breadcrumb picker and the route sheets all place through here. */

interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface AnchoredPanelInput {
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
  align?: 'start' | 'end';
  /** Side the panel opens toward when it fits there. */
  placement?: 'below' | 'above';
  /** Space between the trigger and the panel. */
  gap?: number;
  /** Minimum inset kept from every bounds edge. */
  edge?: number;
}

interface AnchoredPanelGeometry {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: 'below' | 'above';
  align: 'start' | 'end';
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** The model picker's gap and bounds inset (ROUTE_PANEL_GAP / ROUTE_PANEL_EDGE). */
export const ANCHORED_PANEL_GAP = 6;
export const ANCHORED_PANEL_EDGE = 8;

export function anchoredPanelGeometry({
  trigger,
  bounds,
  preferredWidth,
  minWidth = 0,
  naturalHeight,
  align = 'start',
  placement = 'below',
  gap = ANCHORED_PANEL_GAP,
  edge = ANCHORED_PANEL_EDGE,
}: AnchoredPanelInput): AnchoredPanelGeometry {
  const available = Math.max(0, bounds.right - bounds.left - edge * 2);
  // Cap to the space that exists instead of the reference's fixed width.
  const width = Math.min(Math.max(preferredWidth === 0 ? 0 : minWidth, Math.min(preferredWidth, available)), available);
  const idealLeft = align === 'end' ? trigger.right - width : trigger.left;
  const left = clamp(idealLeft, bounds.left + edge, bounds.right - edge - width);

  const spaceBelow = Math.max(0, bounds.bottom - edge - trigger.bottom - gap);
  const spaceAbove = Math.max(0, trigger.top - gap - (bounds.top + edge));
  const wanted = placement === 'above' ? spaceAbove : spaceBelow;
  const other = placement === 'above' ? spaceBelow : spaceAbove;
  // Flip only when the preferred side cannot hold the whole panel AND the
  // other side is roomier; otherwise stay and cap the height.
  const stays = wanted >= naturalHeight || wanted >= other;
  const above = placement === 'above' ? stays : !stays;
  const maxHeight = above ? spaceAbove : spaceBelow;
  const height = Math.min(naturalHeight, maxHeight);
  const idealTop = above ? trigger.top - gap - height : trigger.bottom + gap;
  const top = clamp(idealTop, bounds.top + edge, bounds.bottom - edge - height);

  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    maxHeight: Math.round(maxHeight),
    placement: above ? 'above' : 'below',
    align,
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
  const visual = typeof window !== 'undefined' ? window.visualViewport : null;
  const width = visual?.width ?? (typeof window === 'undefined' ? 0 : window.innerWidth);
  const height = visual?.height ?? (typeof window === 'undefined' ? 0 : window.innerHeight);
  const left = visual?.offsetLeft ?? 0;
  const top = visual?.offsetTop ?? 0;
  return { left, top, right: left + width, bottom: top + height, width, height };
};

/** The area a popup may use: the trigger's pane (a split workspace's leaf, the
 *  workspace, or the session sidebar) clipped to what is visible, else the
 *  visible viewport (dialogs). */
export function paneBounds(element: Element | null | undefined): AnchorRect {
  const view = viewportRect();
  const sheet = element?.closest('.pane-leaf, .workspace, .session-sidebar');
  if (!sheet) return view;
  const rect = rectFrom(sheet);
  return rect.width > 0 && rect.height > 0 ? intersectRects(rect, view) : view;
}

/** Fixed-position style for a placed panel. Above the trigger it pins its
 *  BOTTOM edge to the trigger (6px over it), so a panel shorter than its
 *  estimate still hangs off the trigger instead of floating above it; an
 *  end-aligned panel pins its RIGHT edge, so a menu sized by its own labels
 *  still lines up with the trigger's right edge. `bottom`/`right` resolve
 *  against the layout viewport, which a phone keyboard does not shrink. */
export function anchoredPanelStyle(
  geometry: AnchoredPanelGeometry,
  trigger: Pick<AnchorRect, 'top'>,
  gap = ANCHORED_PANEL_GAP
): { left?: number; right?: number; maxHeight: number; top?: number; bottom?: number; transformOrigin: string } {
  const end = geometry.align === 'end';
  const horizontal = end
    ? {
        right: Math.max(
          ANCHORED_PANEL_EDGE,
          Math.round((document.documentElement.clientWidth || window.innerWidth) - geometry.left - geometry.width)
        ),
      }
    : { left: geometry.left };
  const side = end ? 'right' : 'left';
  if (geometry.placement === 'above') {
    const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
    return {
      ...horizontal,
      bottom: Math.max(ANCHORED_PANEL_EDGE, Math.round(layoutHeight - trigger.top + gap)),
      maxHeight: geometry.maxHeight,
      transformOrigin: `bottom ${side}`,
    };
  }
  return { ...horizontal, top: geometry.top, maxHeight: geometry.maxHeight, transformOrigin: `top ${side}` };
}

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

/** Keep a portaled overlay fully inside the window once it can be measured.
 *  Menus anchored to a trigger near an edge (the tab strip "+", folder and
 *  review context menus) would otherwise render half off-screen (user: 팝업이
 *  화면 밖으로 나가 안 보인다). Guessed "menu is ~200px" constants cannot do
 *  this: only the measured box knows. Doubles as a React ref callback.
 *  An overlay pinned by inline right/bottom keeps that axis untouched; a
 *  right-pinned one grows leftward instead, so its measured width is held to
 *  its inline max-width (the room its owner computed from the recorded pane
 *  bounds) and the window, with a CSS min-width yielding to that room. */
export function clampOverlayIntoView(element: HTMLElement | null, edge = 8): void {
  if (!element) return;
  if (element.style.right) element.style.minWidth = '';
  let rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const view = viewportRect();
  if (element.style.right) {
    const roomed = Number.parseFloat(element.style.maxWidth);
    const room = Math.max(
      0,
      Math.min(Number.isFinite(roomed) ? roomed : Number.POSITIVE_INFINITY, rect.right - view.left - edge)
    );
    if (rect.width > room + 0.5) {
      element.style.maxWidth = `${Math.floor(room)}px`;
      element.style.minWidth = `${Math.floor(room)}px`;
      rect = element.getBoundingClientRect();
    }
  } else {
    const left = clamp(rect.left, view.left + edge, view.right - edge - rect.width);
    if (Math.round(left) !== Math.round(rect.left)) element.style.left = `${Math.round(left)}px`;
  }
  if (!element.style.bottom) {
    const top = clamp(rect.top, view.top + edge, view.bottom - edge - rect.height);
    if (Math.round(top) !== Math.round(rect.top)) element.style.top = `${Math.round(top)}px`;
  }
}
