import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';

import { routePaneLayout, settledTop, useRouteFlyoutFit } from './route-editor-layout';
import {
  ROUTE_PANEL_PADDING,
  ROUTE_PANEL_WIDTH,
  ROUTE_SHEET_ROW_HEIGHT,
  routePanelStyle,
  routeSheetBox,
  type RoutePanelBox,
} from './route-editor-logic';
import { currentViewport } from './route-editor-panes';
import { type StudioOptionRow, studioFlyoutSize } from './studio-route-menu-model';

const CLOSE_DURATION = 110;

type StudioViewport = { left: number; top: number; width: number; height: number };

function measuredSheet(
  trigger: HTMLElement,
  rect: { left: number; right: number; top: number; bottom: number },
  sheetHeight: number,
  field: boolean
) {
  const viewport = currentViewport(trigger);
  return {
    viewport,
    sheet: field
      ? routeSheetBox(rect, sheetHeight, viewport, ROUTE_PANEL_WIDTH, 'below', 'end')
      : routeSheetBox(rect, sheetHeight, viewport, ROUTE_PANEL_WIDTH, 'above', 'end'),
  };
}

/** The sheet's box plus the scale it morphs from: the pill's captured size
 *  over the panel's, clamped to [0.1, 1]. */
export function studioSheetStyle(
  panelBox: RoutePanelBox,
  morphFrom: { width: number; height: number } | null
): CSSProperties {
  return {
    ...routePanelStyle(panelBox),
    '--route-morph-sx': String(Math.min(1, Math.max(0.1, (morphFrom?.width || panelBox.width) / panelBox.width))),
    '--route-morph-sy': String(Math.min(1, Math.max(0.1, (morphFrom?.height || panelBox.height) / panelBox.height))),
  } as CSSProperties;
}

export function useStudioRouteMenuPanels({
  field,
  rowCount,
  rows,
}: {
  field: boolean;
  rowCount: number;
  rows: StudioOptionRow[];
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [pane, setPane] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState('');
  const [sheetBox, setSheetBox] = useState<RoutePanelBox | null>(null);
  const [flyoutBox, setFlyoutBox] = useState<RoutePanelBox | null>(null);
  // Narrow surface (phone): the pane takes over the sheet's footprint and the
  // sheet steps aside, instead of stacking a detached second panel.
  const [drill, setDrill] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const flyout = useRef<HTMLDivElement>(null);
  const rowButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const morphFrom = useRef<{ width: number; height: number } | null>(null);
  const closeTimer = useRef<number | null>(null);

  const sheetHeight = rowCount * ROUTE_SHEET_ROW_HEIGHT + ROUTE_PANEL_PADDING * 2;

  const flyoutSize = useCallback((id: string) => studioFlyoutSize(id, rowsRef.current), []);

  const finishClose = useCallback(() => {
    setClosing(false);
    setPane(null);
    setSheetBox(null);
    setFlyoutBox(null);
    setDrill(false);
  }, []);

  const closeAll = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setOpen(false);
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      finishClose();
    }, CLOSE_DURATION);
  }, [finishClose]);

  // The route editor's pane geometry (route-editor-layout.ts).
  const paneLayout = useCallback(
    (nextSheet: RoutePanelBox, id: string, viewport: StudioViewport): { box: RoutePanelBox; drilled: boolean } => {
      const row = rowButtons.current[id];
      return routePaneLayout(nextSheet, viewport, flyoutSize(id), row ? settledTop(row) : undefined);
    },
    [flyoutSize]
  );
  useRouteFlyoutFit(flyout, flyoutBox, setFlyoutBox, () => (pane ? rowButtons.current[pane] : null));
  // A drilled pane is hosted by the sheet itself.
  useRouteFlyoutFit(sheet, drill ? flyoutBox : null, setFlyoutBox);

  const layout = useCallback(() => {
    const node = trigger.current;
    const rect = node?.getBoundingClientRect();
    if (!node || !rect) return;
    const { viewport, sheet: nextSheet } = measuredSheet(node, rect, sheetHeight, field);
    setSheetBox(nextSheet);
    if (!pane) {
      setFlyoutBox(null);
      setDrill(false);
      return;
    }
    const nextBox = paneLayout(nextSheet, pane, viewport);
    setFlyoutBox(nextBox.box);
    setDrill(nextBox.drilled);
  }, [field, pane, paneLayout, sheetHeight]);

  const show = () => {
    const node = trigger.current;
    const rect = node?.getBoundingClientRect();
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setClosing(false);
    morphFrom.current = rect ? { width: rect.width, height: rect.height } : null;
    if (node && rect) setSheetBox(measuredSheet(node, rect, sheetHeight, field).sheet);
    setPane(null);
    setModelQuery('');
    setOpen(true);
  };

  const openPane = (id: string) => {
    const node = trigger.current;
    const rect = node?.getBoundingClientRect();
    if (node && rect) {
      const { viewport, sheet: nextSheet } = measuredSheet(node, rect, sheetHeight, field);
      setSheetBox(nextSheet);
      const nextBox = paneLayout(nextSheet, id, viewport);
      setFlyoutBox(nextBox.box);
      setDrill(nextBox.drilled);
    }
    setPane(id);
  };

  const closePane = useCallback(() => {
    setPane(null);
    setFlyoutBox(null);
    setDrill(false);
  }, []);

  return {
    open,
    closing,
    mounted: open || closing,
    pane,
    modelQuery,
    setModelQuery,
    sheetBox,
    flyoutBox,
    drill,
    trigger,
    sheet,
    flyout,
    rowButtons,
    morphFrom,
    closeTimer,
    closeAll,
    layout,
    show,
    openPane,
    closePane,
  };
}

/** Re-place the open panels whenever the window or the visual viewport
 *  resizes or scrolls. */
export function useStudioViewportRelayout(mounted: boolean, layout: () => void): void {
  useEffect(() => {
    if (!mounted) return undefined;
    layout();
    const onViewport = () => layout();
    // A phone keyboard resizes and offsets the VISUAL viewport, which fires
    // no window resize on iOS: without these the panel kept its old box while
    // the composer moved and the two drifted apart.
    const visual = window.visualViewport;
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, true);
    visual?.addEventListener('resize', onViewport);
    visual?.addEventListener('scroll', onViewport);
    return () => {
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('scroll', onViewport, true);
      visual?.removeEventListener('resize', onViewport);
      visual?.removeEventListener('scroll', onViewport);
    };
  }, [layout, mounted]);
}
