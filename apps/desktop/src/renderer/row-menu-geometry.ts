// Read the same metrics CSS uses, on the input event that captures the anchor.
// Rendering the portal remains free of synchronous layout reads.
export function captureRowMenuAnchor(element: HTMLElement) {
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  return {
    bounds: element.getBoundingClientRect(),
    rowHeight: Number.parseFloat(style.getPropertyValue("--mx-menu-row-height")) || 32,
    inset: Number.parseFloat(style.getPropertyValue("--mx-menu-inset")) || 6,
  };
}

/* Same ceiling as .mx-menu so every popup menu shares one width grammar. */
export const ROW_MENU_MAX_WIDTH = 368;

// The panel sizes itself to its labels (user: ⋯ 팝업 너비가 제각각), so the
// caller never knows the width. Anchoring the RIGHT edge to the trigger keeps
// the menu under the ⋯ glyph whatever the content measures; maxWidth stops it
// from running off the left edge of the viewport.
export function positionRowMenu(
  anchor: ReturnType<typeof captureRowMenuAnchor> | null,
  rowCount: number,
  separatorCount: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const height = Math.min(
    (anchor?.rowHeight || 32) * rowCount + 2 * (anchor?.inset || 6) + 2 + separatorCount * 4,
    Math.max(0, viewportHeight - 16),
  );
  const right = Math.max(8, viewportWidth - (anchor?.bounds.right ?? viewportWidth - 8));
  const maxWidth = Math.max(0, Math.min(ROW_MENU_MAX_WIDTH, viewportWidth - right - 8));
  const below = (anchor?.bounds.bottom || 8) + 4;
  const top = below + height <= viewportHeight - 8
    ? below
    : Math.max(8, (anchor?.bounds.top || height + 12) - height - 4);
  return { right, top, maxWidth };
}
