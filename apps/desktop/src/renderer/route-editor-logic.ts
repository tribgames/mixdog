export type RouteSheetPane = 'model' | 'effort' | 'context' | 'speed';

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

export function routeFlyoutBox(
  sheet: RoutePanelBox,
  preferredHeight: number,
  viewport: RouteViewport,
  anchorTop?: number,
  preferredWidth?: number,
  preferredSide: 'left' | 'right' | null = null,
): RoutePanelBox {
  const viewportLeft = viewport.left ?? 0;
  const viewportTop = viewport.top ?? 0;
  const viewportRight = viewportLeft + viewport.width;
  const viewportBottom = viewportTop + viewport.height;
  // Open the submenu beside the sheet, top-aligned with the row that
  // spawned it (clamped into the viewport). Stacking above/below is only the
  // fallback for viewports too narrow to fit a second column.
  const sideWidth = Math.min(
    preferredWidth ?? sheet.width,
    Math.max(1, viewport.width - ROUTE_PANEL_EDGE * 2),
  );
  const spaceLeft = Math.max(0, sheet.left - viewportLeft - ROUTE_PANEL_EDGE - ROUTE_PANEL_GAP);
  const spaceRight = Math.max(
    0,
    viewportRight - (sheet.left + sheet.width) - ROUTE_PANEL_EDGE - ROUTE_PANEL_GAP,
  );
  const canOpenLeft = spaceLeft >= sideWidth;
  const canOpenRight = spaceRight >= sideWidth;
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
}): RouteSheetPane[] {
  const rows: RouteSheetPane[] = ['model'];
  if (input.hasModel && input.effortCount > 0) rows.push('effort');
  if (input.hasModel && input.contextVisible) rows.push('context');
  if (input.hasModel && input.fastVisible) rows.push('speed');
  return rows;
}
