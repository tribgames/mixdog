import { type CSSProperties, type RefObject, useLayoutEffect } from 'react';
import { anchoredPanelGeometry, anchoredPanelStyle, clampOverlayIntoView, paneBounds } from './anchored-panel';

/** After every render of an open ⋯ menu: pull a panel wider than the room
 *  right of its trigger back inside the window (its width is its labels'). */
export function useRowMenuClamp(open: boolean, panel: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    if (open) clampOverlayIntoView(panel.current);
  });
}

// Read the same metrics CSS uses, on the input event that captures the anchor.
// Rendering the portal remains free of synchronous layout reads.
export function captureRowMenuAnchor(element: HTMLElement) {
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  return {
    bounds: element.getBoundingClientRect(),
    /** The trigger's pane, clipped to the visible viewport. */
    area: paneBounds(element),
    rowHeight: Number.parseFloat(style.getPropertyValue('--mx-menu-row-height')) || 32,
    inset: Number.parseFloat(style.getPropertyValue('--mx-menu-inset')) || 6,
    /** Opened by a right-click: the bounds are the pointer, not the ⋯ glyph. */
    atPointer: false,
  };
}

/* .row-overflow-menu min-width: a pointer menu opens rightward only when it fits. */
const ROW_MENU_MIN_WIDTH = 160;

/* Same ceiling as .mx-menu so every popup menu shares one width grammar. */
const ROW_MENU_MAX_WIDTH = 368;

// The panel sizes itself to its labels (user: ⋯ 팝업 너비가 제각각), so the
// caller never knows the width. The ⋯ glyph sits at the trailing edge of its
// row, so the menu opens like every trailing trigger (anchored-panel.ts:
// below, right edge pinned to the trigger's right edge, flipping above only
// when below cannot hold it and above is roomier); the owner pulls a menu
// that still runs past the window back in with clampOverlayIntoView.
export function positionRowMenu(
  anchor: ReturnType<typeof captureRowMenuAnchor> | null,
  rowCount: number,
  separatorCount: number,
  viewportWidth: number,
  viewportHeight: number
): CSSProperties {
  const height = Math.min(
    (anchor?.rowHeight || 32) * rowCount + 2 * (anchor?.inset || 6) + 2 + separatorCount * 4,
    Math.max(0, viewportHeight - 16)
  );
  // A right-click menu starts AT the pointer, like every native context menu.
  if (anchor?.atPointer && viewportWidth - anchor.bounds.left - 8 >= ROW_MENU_MIN_WIDTH) {
    const below = anchor.bounds.bottom + 4;
    const top = below + height <= viewportHeight - 8 ? below : Math.max(8, anchor.bounds.top - height - 4);
    const left = Math.max(8, anchor.bounds.left);
    return { left, top, maxWidth: Math.min(ROW_MENU_MAX_WIDTH, viewportWidth - left - 8) };
  }
  const trigger = anchor?.bounds ?? {
    left: viewportWidth - 8,
    right: viewportWidth - 8,
    top: 8,
    bottom: 8,
    width: 0,
    height: 0,
  };
  const bounds = anchor?.area ?? {
    left: 0,
    top: 0,
    right: viewportWidth,
    bottom: viewportHeight,
    width: viewportWidth,
    height: viewportHeight,
  };
  const geometry = anchoredPanelGeometry({
    trigger,
    bounds,
    preferredWidth: 0,
    naturalHeight: height,
    align: 'end',
  });
  // Right-pinned, the panel grows leftward: its width may use only the room
  // between its right edge and the pane's left inset (useRowMenuClamp lets a
  // CSS min-width yield to it once measured).
  const room = geometry.left + geometry.width - bounds.left - 8;
  return {
    ...anchoredPanelStyle(geometry, trigger),
    maxWidth: Math.max(0, Math.min(ROW_MENU_MAX_WIDTH, room)),
  };
}
