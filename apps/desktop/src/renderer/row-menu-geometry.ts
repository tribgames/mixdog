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

export function positionRowMenu(
  anchor: ReturnType<typeof captureRowMenuAnchor> | null,
  requestedWidth: number,
  rowCount: number,
  separatorCount: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const width = Math.min(requestedWidth, Math.max(0, viewportWidth - 16));
  const height = Math.min(
    (anchor?.rowHeight || 32) * rowCount + 2 * (anchor?.inset || 6) + 2 + separatorCount * 4,
    Math.max(0, viewportHeight - 16),
  );
  const left = Math.max(8, Math.min(
    (anchor?.bounds.right || width + 8) - width,
    viewportWidth - width - 8,
  ));
  const below = (anchor?.bounds.bottom || 8) + 4;
  const top = below + height <= viewportHeight - 8
    ? below
    : Math.max(8, (anchor?.bounds.top || height + 12) - height - 4);
  return { left, top, width };
}
