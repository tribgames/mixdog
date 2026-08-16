export type RouteSheetPane = 'model' | 'effort' | 'speed';

export const ROUTE_PANEL_PADDING = 4;
export const ROUTE_SHEET_ROW_HEIGHT = 36;

const ROUTE_PANEL_EDGE = 8;
const ROUTE_PANEL_GAP = 6;
const ROUTE_PANEL_WIDTH = 264;
const ROUTE_MIN_SIDE_PANEL_WIDTH = 180;

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

export function routeFlyoutBox(
  sheet: RoutePanelBox,
  rowIndex: number,
  preferredHeight: number,
  viewport: RouteViewport,
  requestedWidth = ROUTE_PANEL_WIDTH,
): RoutePanelBox {
  const viewportLeft = viewport.left ?? 0;
  const viewportTop = viewport.top ?? 0;
  const viewportRight = viewportLeft + viewport.width;
  const viewportBottom = viewportTop + viewport.height;
  const preferredWidth = Math.min(
    requestedWidth,
    Math.max(1, viewport.width - ROUTE_PANEL_EDGE * 2),
  );
  const sheetRight = sheet.left + sheet.width;
  const sheetBottom = sheet.top + sheet.height;
  const spaceLeft = sheet.left - viewportLeft - ROUTE_PANEL_EDGE - ROUTE_PANEL_GAP;
  const spaceRight = viewportRight - sheetRight - ROUTE_PANEL_EDGE - ROUTE_PANEL_GAP;
  const placeLeft = spaceRight < ROUTE_MIN_SIDE_PANEL_WIDTH
    && spaceLeft >= ROUTE_MIN_SIDE_PANEL_WIDTH;
  const sideSpace = placeLeft ? spaceLeft : spaceRight;

  if (sideSpace < ROUTE_MIN_SIDE_PANEL_WIDTH) {
    const spaceAbove = sheet.top - viewportTop - ROUTE_PANEL_EDGE - ROUTE_PANEL_GAP;
    const spaceBelow = viewportBottom - sheetBottom - ROUTE_PANEL_EDGE - ROUTE_PANEL_GAP;
    const openAbove = spaceAbove >= preferredHeight || spaceAbove > spaceBelow;
    const height = Math.min(preferredHeight, Math.max(1, openAbove ? spaceAbove : spaceBelow));
    const top = openAbove ? sheet.top - ROUTE_PANEL_GAP - height : sheetBottom + ROUTE_PANEL_GAP;
    return {
      left: clamp(
        sheetRight - preferredWidth,
        viewportLeft + ROUTE_PANEL_EDGE,
        viewportRight - preferredWidth - ROUTE_PANEL_EDGE,
      ),
      top: clamp(top, viewportTop + ROUTE_PANEL_EDGE, viewportBottom - height - ROUTE_PANEL_EDGE),
      width: preferredWidth,
      height,
      maxHeight: height,
      placement: openAbove ? 'above' : 'below',
    };
  }

  const width = Math.min(preferredWidth, sideSpace);
  const height = Math.min(preferredHeight, Math.max(1, viewport.height - ROUTE_PANEL_EDGE * 2));
  const left = placeLeft ? sheet.left - ROUTE_PANEL_GAP - width : sheetRight + ROUTE_PANEL_GAP;
  const anchorTop = sheet.top + ROUTE_PANEL_PADDING + rowIndex * ROUTE_SHEET_ROW_HEIGHT;
  const top = clamp(
    anchorTop,
    viewportTop + ROUTE_PANEL_EDGE,
    viewportBottom - ROUTE_PANEL_EDGE - height,
  );
  return {
    left,
    top,
    width,
    height,
    maxHeight: height,
    placement: placeLeft ? 'left' : 'right',
  };
}

export function routeSheetRows(input: {
  hasModel: boolean;
  effortCount: number;
  fastVisible: boolean;
}): RouteSheetPane[] {
  const rows: RouteSheetPane[] = ['model'];
  if (input.hasModel && input.effortCount > 0) rows.push('effort');
  if (input.hasModel && input.fastVisible) rows.push('speed');
  return rows;
}
