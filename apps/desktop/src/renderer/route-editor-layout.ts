import { type Dispatch, type RefObject, type SetStateAction, useCallback } from 'react';
import {
  ROUTE_PANEL_WIDTH,
  routeDrillBox,
  routeDrillHeight,
  routeFlyoutBox,
  routeFlyoutFitsBeside,
  type RoutePanelBox,
  type RouteSheetPane,
  routeSheetBox,
} from './route-editor-logic';
import {
  currentViewport,
  naturalTriggerWidth,
  preferredFlyoutHeight,
  preferredFlyoutWidth,
  sheetAnchor,
} from './route-editor-panes';

/** Sheet and flyout geometry: measures the trigger and places the panels. */
export function useRouteLayout({
  trigger,
  rowButtons,
  labelWidth,
  effortCount,
  sheetHeight,
  pane,
  setSheetBox,
  setFlyoutBox,
  setDrill,
}: {
  trigger: RefObject<HTMLButtonElement | null>;
  rowButtons: RefObject<Partial<Record<RouteSheetPane, HTMLButtonElement | null>>>;
  labelWidth: RefObject<number | null>;
  effortCount: number;
  sheetHeight: number;
  pane: RouteSheetPane | null;
  setSheetBox: Dispatch<SetStateAction<RoutePanelBox | null>>;
  setFlyoutBox: Dispatch<SetStateAction<RoutePanelBox | null>>;
  setDrill: Dispatch<SetStateAction<boolean>>;
}) {
  // One geometry for every opening: a second column beside the sheet where it
  // fits, and a drilled pane inside the sheet's own footprint where it does
  // not (phones), so the menu never breaks into two detached panels.
  const paneLayout = useCallback(
    (
      nextSheet: RoutePanelBox,
      next: RouteSheetPane,
      viewport: { left: number; top: number; width: number; height: number }
    ): { box: RoutePanelBox; drilled: boolean } => {
      const width = preferredFlyoutWidth(next);
      const height = preferredFlyoutHeight(next, effortCount);
      if (routeFlyoutFitsBeside(nextSheet, viewport, width)) {
        return {
          box: routeFlyoutBox(
            nextSheet,
            height,
            viewport,
            rowButtons.current[next]?.getBoundingClientRect().top,
            width,
            'right'
          ),
          drilled: false,
        };
      }
      return {
        box: routeDrillBox(nextSheet, routeDrillHeight(height, viewport), viewport),
        drilled: true,
      };
    },
    [effortCount, rowButtons]
  );

  // The sheet anchors to the pill's LEFT edge: the pill expands rightwards
  // to the sheet width, so both share the same left edge and width. That
  // width is the panel's, or the label's natural width when a long model
  // name needs more — measured once per opening (user: 모델명 긴 거 잘림).
  const measureSheet = useCallback(
    (
      triggerRect: { left: number; top: number; bottom: number },
      viewport: { left: number; top: number; width: number; height: number },
      remeasure = false
    ): RoutePanelBox => {
      if (remeasure || labelWidth.current === null) {
        labelWidth.current = trigger.current ? naturalTriggerWidth(trigger.current) : ROUTE_PANEL_WIDTH;
      }
      return routeSheetBox(
        sheetAnchor(triggerRect, viewport, labelWidth.current),
        sheetHeight,
        viewport,
        labelWidth.current
      );
    },
    [sheetHeight, labelWidth, trigger]
  );

  /** Place the sheet and, when a pane is open, its flyout or drilled box. */
  const layoutFor = useCallback(
    (target: RouteSheetPane | null) => {
      const triggerRect = trigger.current?.getBoundingClientRect();
      if (!triggerRect) return;
      const viewport = currentViewport(trigger.current);
      const nextSheet = measureSheet(triggerRect, viewport);
      setSheetBox(nextSheet);
      if (!target) {
        setFlyoutBox(null);
        setDrill(false);
        return;
      }
      const nextBox = paneLayout(nextSheet, target, viewport);
      setFlyoutBox(nextBox.box);
      setDrill(nextBox.drilled);
    },
    [measureSheet, paneLayout, trigger, setSheetBox, setFlyoutBox, setDrill]
  );
  const layout = useCallback(() => layoutFor(pane), [layoutFor, pane]);
  return { measureSheet, layoutFor, layout };
}
