import { type Dispatch, type RefObject, type SetStateAction, useCallback, useLayoutEffect, useRef } from 'react';
import { onAnchorEdges } from './anchored-panel';
import {
  ROUTE_PANEL_WIDTH,
  routeContentFit,
  routeDrillBox,
  routeDrillHeight,
  routeDropdownBox,
  routeFlyoutBox,
  routeFlyoutFit,
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
} from './route-editor-panes';

type RouteViewportBox = { left: number; top: number; width: number; height: number };

/** One geometry for every pane opening: a second column beside the sheet
 *  where it fits — on its row, sized to its content up to `maxHeight` — and a
 *  drilled pane inside the sheet's own footprint where it does not (phones),
 *  so the menu never breaks into two detached panels. Either is placed at
 *  its cap here; useRouteFlyoutFit re-places it for its content before it
 *  paints. A drilled model catalog (`catalog`) keeps its cap, so filtering
 *  the list does not move the search field. */
export function routePaneLayout(
  nextSheet: RoutePanelBox,
  viewport: RouteViewportBox,
  size: { maxHeight: number; width?: number; catalog?: boolean },
  rowTop: number | undefined
): { box: RoutePanelBox; drilled: boolean } {
  if (routeFlyoutFitsBeside(nextSheet, viewport, size.width)) {
    return {
      box: routeFlyoutBox(nextSheet, size.maxHeight, viewport, rowTop, size.width, 'right'),
      drilled: false,
    };
  }
  const box = routeDrillBox(nextSheet, routeDrillHeight(size.maxHeight, viewport), viewport);
  return { box: size.catalog ? box : routeContentFit(box), drilled: true };
}

/** An element's settled viewport top: its layout offsets, ignoring CSS
 *  transforms, so a row inside a sheet that is still running its opening
 *  morph (scaled toward the pill) reads where it will rest, not where the
 *  animation frame happens to draw it. */
export function settledTop(element: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = element;
  while (node) {
    top += node.offsetTop;
    const parent = node.offsetParent as HTMLElement | null;
    for (
      let scroller: HTMLElement | null = node.parentElement;
      scroller && scroller !== parent;
      scroller = scroller.parentElement
    ) {
      top -= scroller.scrollTop;
    }
    if (parent) top += parent.clientTop - parent.scrollTop;
    node = parent;
  }
  return top;
}

/** After every render of a side flyout: re-place it for the height its
 *  content actually takes (a short or empty list is a short flyout), and
 *  again whenever that content grows or shrinks — each time re-reading the
 *  settled top of the row that spawned it, so a short list sits on its row
 *  and only shifts up as far as the bounds require. */
export function useRouteFlyoutFit(
  flyout: RefObject<HTMLElement | null>,
  box: RoutePanelBox | null,
  setBox: Dispatch<SetStateAction<RoutePanelBox | null>>,
  anchorRow?: () => HTMLElement | null | undefined
): void {
  const row = useRef(anchorRow);
  row.current = anchorRow;
  useLayoutEffect(() => {
    const node = flyout.current;
    if (!node || !box?.fit || !node.offsetHeight) return undefined;
    const fit = () => {
      const height = node.offsetHeight;
      if (!height) return;
      const spawn = row.current?.();
      const anchorTop = spawn?.isConnected ? settledTop(spawn) : undefined;
      setBox((current) => (current?.fit ? routeFlyoutFit(current, height, anchorTop) : current));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [flyout, box, setBox]);
}

/** Sheet and flyout geometry: measures the trigger and places the panels. */
export function useRouteLayout({
  trigger,
  rowButtons,
  labelWidth,
  effortCount,
  sheetHeight,
  placement,
  align,
  pane,
  setSheetBox,
  setFlyoutBox,
  setDrill,
  dropdown = false,
  rowWide = false,
}: {
  /** RouteEditor `dropdown`: the sheet hangs under (or above) the trigger at
   *  its width; a pane flies out beside it where its panel has the room and
   *  otherwise takes that same box. */
  dropdown?: boolean;
  /** The trigger is a session panel row: the sheet stands on the row's own edges (onAnchorEdges); its panes still
   *  open beside it, or over it where no side has the room. */
  rowWide?: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  rowButtons: RefObject<Partial<Record<RouteSheetPane, HTMLButtonElement | null>>>;
  labelWidth: RefObject<number | null>;
  effortCount: number;
  sheetHeight: number;
  /** `above` for the composer's pill at the bottom of the screen; `below`
   *  for a dialog or settings field. */
  placement: 'above' | 'below';
  /** The pill edge the sheet shares (RouteEditor `align`). */
  align: 'start' | 'end';
  pane: RouteSheetPane | null;
  setSheetBox: Dispatch<SetStateAction<RoutePanelBox | null>>;
  setFlyoutBox: Dispatch<SetStateAction<RoutePanelBox | null>>;
  setDrill: Dispatch<SetStateAction<boolean>>;
}) {
  // A dropdown hangs from the trigger itself and may use the rest of its lane
  // (its `.route-editor` box: the field's row width) to the right of the chip.
  const dropdownAnchor = useCallback(
    (triggerRect: { left: number; right: number; top: number; bottom: number }) => {
      const lane = trigger.current?.parentElement?.getBoundingClientRect();
      return lane && lane.width > 0
        ? {
            left: triggerRect.left,
            right: Math.max(lane.right, triggerRect.right),
            top: triggerRect.top,
            bottom: triggerRect.bottom,
          }
        : triggerRect;
    },
    [trigger]
  );

  // ...sized to the chip's natural label (never narrower than the chip) or the
  // open pane's own preferred width, whichever is wider.
  const dropdownBox = useCallback(
    (
      triggerRect: { left: number; right: number; top: number; bottom: number },
      height: number,
      bounds: RouteViewportBox,
      paneWidth = 0
    ) => {
      const chip = triggerRect.right - triggerRect.left;
      const natural = trigger.current ? naturalTriggerWidth(trigger.current) : ROUTE_PANEL_WIDTH;
      return routeDropdownBox(dropdownAnchor(triggerRect), height, bounds, Math.max(chip, natural, paneWidth));
    },
    [dropdownAnchor, trigger]
  );

  // ...and stays inside the side panel that holds it, never over the conversation.
  const dropdownViewport = useCallback(
    (viewport: RouteViewportBox): RouteViewportBox => {
      const panel = trigger.current?.closest('.workbench-side-panel')?.getBoundingClientRect();
      if (!panel || panel.width <= 0 || panel.height <= 0) return viewport;
      const left = Math.max(viewport.left, panel.left);
      const top = Math.max(viewport.top, panel.top);
      const right = Math.min(viewport.left + viewport.width, panel.right);
      const bottom = Math.min(viewport.top + viewport.height, panel.bottom);
      return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : viewport;
    },
    [trigger]
  );

  const paneLayout = useCallback(
    (nextSheet: RoutePanelBox, next: RouteSheetPane, viewport: RouteViewportBox) => {
      const triggerRect = trigger.current?.getBoundingClientRect();
      const row = rowButtons.current[next];
      const rowTop = row ? settledTop(row) : undefined;
      const size = {
        maxHeight: preferredFlyoutHeight(next, effortCount),
        width: preferredFlyoutWidth(next),
        catalog: next === 'model',
      };
      if (dropdown && triggerRect) {
        const bounds = dropdownViewport(viewport);
        if (routeFlyoutFitsBeside(nextSheet, bounds, size.width)) {
          return routePaneLayout(nextSheet, bounds, size, rowTop);
        }
        const height = routeDrillHeight(size.maxHeight, bounds);
        const box = dropdownBox(triggerRect, height, bounds, size.width);
        return { box: next === 'model' ? box : routeContentFit(box), drilled: true };
      }
      return routePaneLayout(nextSheet, viewport, size, rowTop);
    },
    [dropdown, dropdownBox, dropdownViewport, effortCount, rowButtons, trigger]
  );

  const measureSheet = useCallback(
    (
      triggerRect: { left: number; right: number; top: number; bottom: number },
      viewport: RouteViewportBox,
      remeasure = false
    ): RoutePanelBox => {
      if (dropdown) return dropdownBox(triggerRect, sheetHeight, dropdownViewport(viewport));
      if (rowWide) {
        const row = { left: triggerRect.left, width: triggerRect.right - triggerRect.left };
        return onAnchorEdges(routeSheetBox(triggerRect, sheetHeight, viewport, row.width, placement, 'start'), row);
      }
      if (remeasure || labelWidth.current === null) {
        labelWidth.current = trigger.current ? naturalTriggerWidth(trigger.current) : ROUTE_PANEL_WIDTH;
      }
      return routeSheetBox(triggerRect, sheetHeight, viewport, labelWidth.current, placement, align);
    },
    [dropdown, dropdownBox, dropdownViewport, rowWide, sheetHeight, labelWidth, trigger, placement, align]
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
  /** True where the pane would take the sheet's place instead of opening beside it. */
  const paneDrills = useCallback(
    (target: RouteSheetPane) => {
      const triggerRect = trigger.current?.getBoundingClientRect();
      if (!triggerRect) return true;
      const viewport = currentViewport(trigger.current);
      return paneLayout(measureSheet(triggerRect, viewport), target, viewport).drilled;
    },
    [measureSheet, paneLayout, trigger]
  );
  return { measureSheet, layoutFor, layout, paneDrills };
}
