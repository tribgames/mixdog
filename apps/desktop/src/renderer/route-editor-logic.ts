export type RouteSheetPane = 'model' | 'effort' | 'context' | 'speed' | `parameter:${string}`;

export const ROUTE_PANEL_PADDING = 4;
export const ROUTE_SHEET_ROW_HEIGHT = 36;

const ROUTE_PANEL_EDGE = 8;
const ROUTE_PANEL_GAP = 6;
// Codex-scale panel: the pill expands to this same width, so it stays modest.
export const ROUTE_PANEL_WIDTH = 224;

export interface RoutePanelBox {
  left: number;
  top: number;
  width: number;
  height: number;
  maxHeight: number;
  placement?: 'above' | 'below' | 'left' | 'right';
}

interface RouteAnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface RouteViewport {
  left?: number;
  top?: number;
  width: number;
  height: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

export function routeSheetBox(
  trigger: RouteAnchorRect,
  preferredHeight: number,
  viewport: RouteViewport,
): RoutePanelBox {
  const viewportLeft = viewport.left ?? 0;
  const viewportTop = viewport.top ?? 0;
  const viewportRight = viewportLeft + viewport.width;
  const viewportBottom = viewportTop + viewport.height;
  const width = Math.min(ROUTE_PANEL_WIDTH, Math.max(1, viewport.width - ROUTE_PANEL_EDGE * 2));
  const left = clamp(
    trigger.right - width,
    viewportLeft + ROUTE_PANEL_EDGE,
    viewportRight - width - ROUTE_PANEL_EDGE,
  );
  const spaceAbove = Math.max(1, trigger.top - viewportTop - ROUTE_PANEL_EDGE - ROUTE_PANEL_GAP);
  const spaceBelow = Math.max(1, viewportBottom - trigger.bottom - ROUTE_PANEL_EDGE - ROUTE_PANEL_GAP);
  const openAbove = spaceAbove >= preferredHeight || spaceAbove > spaceBelow;
  const height = Math.min(preferredHeight, openAbove ? spaceAbove : spaceBelow);
  const top = openAbove ? trigger.top - ROUTE_PANEL_GAP - height : trigger.bottom + ROUTE_PANEL_GAP;
  return {
    left,
    top: clamp(top, viewportTop + ROUTE_PANEL_EDGE, viewportBottom - height - ROUTE_PANEL_EDGE),
    width,
    height,
    maxHeight: height,
    placement: openAbove ? 'above' : 'below',
  };
}

function flyoutSides(
  sheet: { left: number; width: number },
  viewport: RouteViewport,
  preferredWidth?: number,
): { sideWidth: number; canOpenLeft: boolean; canOpenRight: boolean } {
  const viewportLeft = viewport.left ?? 0;
  const viewportRight = viewportLeft + viewport.width;
  const sideWidth = Math.min(
    preferredWidth ?? sheet.width,
    Math.max(1, viewport.width - ROUTE_PANEL_EDGE * 2),
  );
  const spaceLeft = Math.max(0, sheet.left - viewportLeft - ROUTE_PANEL_EDGE - ROUTE_PANEL_GAP);
  const spaceRight = Math.max(
    0,
    viewportRight - (sheet.left + sheet.width) - ROUTE_PANEL_EDGE - ROUTE_PANEL_GAP,
  );
  return { sideWidth, canOpenLeft: spaceLeft >= sideWidth, canOpenRight: spaceRight >= sideWidth };
}

/** True while a submenu still fits as a second column beside the sheet. A
 *  phone never does, and stacking the two panels left the submenu glued to
 *  the viewport top, detached from the pill (user: 서브 창이 공간이 부족해서
 *  위에 붙어 뜬다), so narrow surfaces drill down inside the sheet instead. */
export function routeFlyoutFitsBeside(
  sheet: { left: number; width: number },
  viewport: RouteViewport,
  preferredWidth?: number,
): boolean {
  const sides = flyoutSides(sheet, viewport, preferredWidth);
  return sides.canOpenLeft || sides.canOpenRight;
}

/** Back header of a drilled pane. */
export const ROUTE_DRILL_HEADER_HEIGHT = 34;

/** Drilled height: the back header plus the pane, capped to a comfortable
 *  share of the surface so one long list never swallows the whole screen. */
export function routeDrillHeight(preferredHeight: number, viewport: RouteViewport): number {
  const comfortable = clamp(Math.round(viewport.height * 0.55), 260, 460);
  return ROUTE_DRILL_HEADER_HEIGHT + Math.min(preferredHeight, comfortable);
}

/** Drill-down box: the pane REPLACES the sheet inside its own footprint and
 *  keeps the edge that faces the trigger pinned, so the menu grows and
 *  shrinks in place like a phone settings screen instead of stacking. */
export function routeDrillBox(
  sheet: RoutePanelBox,
  preferredHeight: number,
  viewport: RouteViewport,
): RoutePanelBox {
  const viewportTop = viewport.top ?? 0;
  const viewportBottom = viewportTop + viewport.height;
  const above = sheet.placement !== 'below';
  const pinned = above ? sheet.top + sheet.height : sheet.top;
  const room = above
    ? pinned - viewportTop - ROUTE_PANEL_EDGE
    : viewportBottom - pinned - ROUTE_PANEL_EDGE;
  const height = Math.max(ROUTE_SHEET_ROW_HEIGHT, Math.min(preferredHeight, room));
  return {
    left: sheet.left,
    top: above ? pinned - height : pinned,
    width: sheet.width,
    height,
    maxHeight: height,
    placement: above ? 'above' : 'below',
  };
}

export function routeFlyoutBox(
  sheet: RoutePanelBox,
  preferredHeight: number,
  viewport: RouteViewport,
  anchorTop?: number,
  preferredWidth?: number,
  preferredSide: 'left' | 'right' | null = null,
): RoutePanelBox {
  const viewportTop = viewport.top ?? 0;
  const viewportBottom = viewportTop + viewport.height;
  // Open the submenu beside the sheet, top-aligned with the row that
  // spawned it (clamped into the viewport). Stacking above/below is only the
  // fallback for viewports too narrow to fit a second column.
  const { sideWidth, canOpenLeft, canOpenRight } = flyoutSides(sheet, viewport, preferredWidth);
  if (canOpenLeft || canOpenRight) {
    const openLeft = preferredSide === 'right'
      ? !canOpenRight && canOpenLeft
      : canOpenLeft;
    const height = Math.min(preferredHeight, Math.max(1, viewport.height - ROUTE_PANEL_EDGE * 2));
    return {
      left: openLeft
        ? sheet.left - ROUTE_PANEL_GAP - sideWidth
        : sheet.left + sheet.width + ROUTE_PANEL_GAP,
      top: clamp(
        anchorTop ?? sheet.top,
        viewportTop + ROUTE_PANEL_EDGE,
        viewportBottom - height - ROUTE_PANEL_EDGE,
      ),
      width: sideWidth,
      height,
      maxHeight: height,
      placement: openLeft ? 'left' : 'right',
    };
  }
  const sheetBottom = sheet.top + sheet.height;
  const spaceAbove = Math.max(1, sheet.top - viewportTop - ROUTE_PANEL_EDGE - ROUTE_PANEL_GAP);
  const spaceBelow = Math.max(1, viewportBottom - sheetBottom - ROUTE_PANEL_EDGE - ROUTE_PANEL_GAP);
  const openAbove = spaceAbove >= preferredHeight || spaceAbove > spaceBelow;
  const height = Math.min(preferredHeight, openAbove ? spaceAbove : spaceBelow);
  const top = openAbove ? sheet.top - ROUTE_PANEL_GAP - height : sheetBottom + ROUTE_PANEL_GAP;
  return {
    left: sheet.left,
    top: clamp(top, viewportTop + ROUTE_PANEL_EDGE, viewportBottom - height - ROUTE_PANEL_EDGE),
    width: sheet.width,
    height,
    maxHeight: height,
    placement: openAbove ? 'above' : 'below',
  };
}

export function routeSheetRows(input: {
  hasModel: boolean;
  effortCount: number;
  contextVisible: boolean;
  fastVisible: boolean;
  parameterIds?: string[];
}): RouteSheetPane[] {
  const rows: RouteSheetPane[] = ['model'];
  if (input.hasModel && input.effortCount > 0) rows.push('effort');
  if (input.hasModel && input.contextVisible) rows.push('context');
  if (input.hasModel) rows.push(...(input.parameterIds || []).map((id) => `parameter:${id}` as const));
  if (input.hasModel && input.fastVisible) rows.push('speed');
  return rows;
}
