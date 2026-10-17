import { ANCHORED_PANEL_EDGE, ANCHORED_PANEL_GAP, anchoredPanelGeometry } from './anchored-panel';

export type RouteSheetPane = 'model' | 'effort' | 'context' | 'speed' | `parameter:${string}`;

export const ROUTE_PANEL_PADDING = 4;
export const ROUTE_SHEET_ROW_HEIGHT = 36;

const ROUTE_PANEL_EDGE = ANCHORED_PANEL_EDGE;
const ROUTE_PANEL_GAP = ANCHORED_PANEL_GAP;
// Codex-scale panel: the pill expands to this same width, so it stays modest.
export const ROUTE_PANEL_WIDTH = 224;

export interface RoutePanelBox {
  left: number;
  top: number;
  width: number;
  height: number;
  maxHeight: number;
  placement?: 'above' | 'below' | 'left' | 'right';
  /** A side flyout sizes to its content: the row top it hangs from and the
   *  band it must stay inside, so a measured height can re-place it. */
  fit?: { anchorTop: number; minTop: number; maxBottom: number };
}

/** Fixed-position style of a panel box. A side flyout leaves its height to
 *  its content (capped by max-height); every other box is sized. */
export function routePanelStyle(box: RoutePanelBox): {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  height?: number;
} {
  const style = { left: box.left, top: box.top, width: box.width, maxHeight: box.maxHeight };
  return box.fit ? style : { ...style, height: box.height };
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

/** Sheet width: the Codex-scale panel, widened to the pill's natural label
 *  width when a long model name needs more (user: 모델명 긴 거 잘림), and
 *  capped to the viewport either way. */
export function routeSheetWidth(viewport: { width: number }, preferredWidth = ROUTE_PANEL_WIDTH): number {
  return Math.min(
    Math.max(ROUTE_PANEL_WIDTH, Math.ceil(preferredWidth)),
    Math.max(1, viewport.width - ROUTE_PANEL_EDGE * 2)
  );
}

/** Route sheet box: the shared anchored-popup rule (anchored-panel.ts). The
 *  composer's pill sits at the bottom of the screen, so its sheet opens
 *  `above`; a dialog or settings field opens `below` like every other popup.
 *  `align` picks the trigger edge the sheet lines up with. */
export function routeSheetBox(
  trigger: RouteAnchorRect,
  preferredHeight: number,
  viewport: RouteViewport,
  preferredWidth = ROUTE_PANEL_WIDTH,
  placement: 'above' | 'below' = 'above',
  align: 'start' | 'end' = 'end'
): RoutePanelBox {
  const bounds = viewportBounds(viewport);
  const width = routeSheetWidth(viewport, preferredWidth);
  const geometry = anchoredPanelGeometry({
    // Copied field by field: a DOMRect's edges are prototype getters.
    trigger: {
      left: trigger.left,
      right: trigger.right,
      top: trigger.top,
      bottom: trigger.bottom,
      width: trigger.right - trigger.left,
      height: trigger.bottom - trigger.top,
    },
    bounds,
    preferredWidth: width,
    minWidth: width,
    naturalHeight: preferredHeight,
    align,
    placement,
  });
  const height = Math.max(1, Math.min(preferredHeight, geometry.maxHeight));
  return {
    left: geometry.left,
    top: geometry.top,
    width,
    height,
    maxHeight: height,
    placement: geometry.placement,
  };
}

function viewportBounds(viewport: RouteViewport) {
  const left = viewport.left ?? 0;
  const top = viewport.top ?? 0;
  return {
    left,
    top,
    right: left + viewport.width,
    bottom: top + viewport.height,
    width: viewport.width,
    height: viewport.height,
  };
}

function flyoutSides(
  sheet: { left: number; width: number },
  viewport: RouteViewport,
  preferredWidth?: number
): { sideWidth: number; canOpenLeft: boolean; canOpenRight: boolean } {
  const viewportLeft = viewport.left ?? 0;
  const viewportRight = viewportLeft + viewport.width;
  const sideWidth = Math.min(preferredWidth ?? sheet.width, Math.max(1, viewport.width - ROUTE_PANEL_EDGE * 2));
  const spaceLeft = Math.max(0, sheet.left - viewportLeft - ROUTE_PANEL_EDGE - ROUTE_PANEL_GAP);
  const spaceRight = Math.max(0, viewportRight - (sheet.left + sheet.width) - ROUTE_PANEL_EDGE - ROUTE_PANEL_GAP);
  return { sideWidth, canOpenLeft: spaceLeft >= sideWidth, canOpenRight: spaceRight >= sideWidth };
}

/** True while a submenu still fits as a second column beside the sheet. A
 *  phone never does, and stacking the two panels left the submenu glued to
 *  the viewport top, detached from the pill (user: 서브 창이 공간이 부족해서
 *  위에 붙어 뜬다), so narrow surfaces drill down inside the sheet instead. */
export function routeFlyoutFitsBeside(
  sheet: { left: number; width: number },
  viewport: RouteViewport,
  preferredWidth?: number
): boolean {
  const sides = flyoutSides(sheet, viewport, preferredWidth);
  return sides.canOpenLeft || sides.canOpenRight;
}

/** Back header of a drilled pane. */
const ROUTE_DRILL_HEADER_HEIGHT = 34;

/** Drilled height: the back header plus the pane, capped to a comfortable
 *  share of the surface so one long list never swallows the whole screen. */
export function routeDrillHeight(preferredHeight: number, viewport: RouteViewport): number {
  const comfortable = clamp(Math.round(viewport.height * 0.55), 260, 460);
  return ROUTE_DRILL_HEADER_HEIGHT + Math.min(preferredHeight, comfortable);
}

/** Drill-down box: the pane REPLACES the sheet inside its own footprint and
 *  keeps the edge that faces the trigger pinned, so the menu grows and
 *  shrinks in place like a phone settings screen instead of stacking. */
export function routeDrillBox(sheet: RoutePanelBox, preferredHeight: number, viewport: RouteViewport): RoutePanelBox {
  const viewportTop = viewport.top ?? 0;
  const viewportBottom = viewportTop + viewport.height;
  const above = sheet.placement !== 'below';
  const pinned = above ? sheet.top + sheet.height : sheet.top;
  const room = above ? pinned - viewportTop - ROUTE_PANEL_EDGE : viewportBottom - pinned - ROUTE_PANEL_EDGE;
  // One row is the floor only while the surface has room for it.
  const height = Math.max(Math.min(ROUTE_SHEET_ROW_HEIGHT, Math.max(1, room)), Math.min(preferredHeight, room));
  return {
    left: sheet.left,
    top: above ? pinned - height : pinned,
    width: sheet.width,
    height,
    maxHeight: height,
    placement: above ? 'above' : 'below',
  };
}

/** Re-place a side flyout for its measured content height: top on its row,
 *  shifted up only as far as the band requires. */
export function routeFlyoutFit(box: RoutePanelBox, contentHeight: number, anchorTop?: number): RoutePanelBox {
  if (!box.fit) return box;
  const anchor = anchorTop ?? box.fit.anchorTop;
  const height = Math.max(1, Math.min(contentHeight, box.maxHeight));
  const top = clamp(anchor, box.fit.minTop, box.fit.maxBottom - height);
  if (height === box.height && top === box.top && anchor === box.fit.anchorTop) return box;
  return { ...box, top, height, fit: { ...box.fit, anchorTop: anchor } };
}

/** `maxHeight` is the pane's cap; `contentHeight` (default: the cap) is what
 *  its content needs — a short list makes a short flyout. */
export function routeFlyoutBox(
  sheet: RoutePanelBox,
  maxHeight: number,
  viewport: RouteViewport,
  anchorTop?: number,
  preferredWidth?: number,
  preferredSide: 'left' | 'right' | null = null,
  contentHeight = maxHeight
): RoutePanelBox {
  const viewportTop = viewport.top ?? 0;
  const viewportBottom = viewportTop + viewport.height;
  // Open the submenu beside the sheet (right first), top-aligned with the
  // row that spawned it. Stacking above/below is only the fallback for
  // viewports too narrow to fit a second column.
  const { sideWidth, canOpenLeft, canOpenRight } = flyoutSides(sheet, viewport, preferredWidth);
  if (canOpenLeft || canOpenRight) {
    const openLeft = preferredSide === 'right' ? !canOpenRight && canOpenLeft : canOpenLeft;
    // A sheet that opened above its pill ends at the composer: a submenu from
    // a low row grows upward from that edge instead of covering the composer.
    const maxBottom =
      sheet.placement === 'above'
        ? Math.min(viewportBottom - ROUTE_PANEL_EDGE, sheet.top + sheet.height)
        : viewportBottom - ROUTE_PANEL_EDGE;
    const minTop = viewportTop + ROUTE_PANEL_EDGE;
    // The cap is the band the flyout may occupy, not the whole viewport.
    const cap = Math.min(maxHeight, Math.max(1, maxBottom - minTop));
    return routeFlyoutFit(
      {
        left: openLeft ? sheet.left - ROUTE_PANEL_GAP - sideWidth : sheet.left + sheet.width + ROUTE_PANEL_GAP,
        top: anchorTop ?? sheet.top,
        width: sideWidth,
        height: cap,
        maxHeight: cap,
        placement: openLeft ? 'left' : 'right',
        fit: { anchorTop: anchorTop ?? sheet.top, minTop, maxBottom },
      },
      contentHeight
    );
  }
  const preferredHeight = Math.min(maxHeight, contentHeight);
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
