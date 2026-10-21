import { type Dispatch, type RefObject, type SetStateAction, useCallback, useLayoutEffect, useRef } from 'react';
import {
  ROUTE_PANEL_WIDTH,
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
 *  so the menu never breaks into two detached panels. The flyout is placed
 *  at its cap here; useRouteFlyoutFit re-places it for its content before
 *  it paints. */
export function routePaneLayout(
  nextSheet: RoutePanelBox,
  viewport: RouteViewportBox,
  size: { maxHeight: number; width?: number },
  rowTop: number | undefined
): { box: RoutePanelBox; drilled: boolean } {
  if (routeFlyoutFitsBeside(nextSheet, viewport, size.width)) {
    return {
      box: routeFlyoutBox(nextSheet, size.maxHeight, viewport, rowTop, size.width, 'right'),
      drilled: false,
    };
  }
  return {
    box: routeDrillBox(nextSheet, routeDrillHeight(size.maxHeight, viewport), viewport),
    drilled: true,
  };
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
}: {
  /** RouteEditor `dropdown`: the sheet and every pane share one box under
   *  (or above) the trigger at its width; no side flyout. */
  dropdown?: boolean;
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
  // A dropdown spans the trigger's lane (its `.route-editor` box: the field's
  // row width) and hangs from the trigger itself.
  const dropdownAnchor = useCallback(
    (triggerRect: { left: number; right: number; top: number; bottom: number }) => {
      const lane = trigger.current?.parentElement?.getBoundingClientRect();
      return lane && lane.width > 0
        ? { left: lane.left, right: lane.right, top: triggerRect.top, bottom: triggerRect.bottom }
        : triggerRect;
    },
    [trigger]
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
      if (dropdown && triggerRect) {
        const bounds = dropdownViewport(viewport);
        const height = routeDrillHeight(preferredFlyoutHeight(next, effortCount), bounds);
        return { box: routeDropdownBox(dropdownAnchor(triggerRect), height, bounds), drilled: true };
      }
      const row = rowButtons.current[next];
      return routePaneLayout(
        nextSheet,
        viewport,
        { maxHeight: preferredFlyoutHeight(next, effortCount), width: preferredFlyoutWidth(next) },
        row ? settledTop(row) : undefined
      );
    },
    [dropdown, dropdownAnchor, dropdownViewport, effortCount, rowButtons, trigger]
  );

  // The sheet's left edge sits on the pill's: the pill expands rightwards to
  // the sheet width, so both share the same left edge and width. That width
  // is the panel's, or the label's natural width when a long model name
  // needs more — measured once per opening (user: 모델명 긴 거 잘림).
  const measureSheet = useCallback(
    (
      triggerRect: { left: number; right: number; top: number; bottom: number },
      viewport: RouteViewportBox,
      remeasure = false
    ): RoutePanelBox => {
      if (dropdown) return routeDropdownBox(dropdownAnchor(triggerRect), sheetHeight, dropdownViewport(viewport));
      if (remeasure || labelWidth.current === null) {
        labelWidth.current = trigger.current ? naturalTriggerWidth(trigger.current) : ROUTE_PANEL_WIDTH;
      }
      return routeSheetBox(triggerRect, sheetHeight, viewport, labelWidth.current, placement, align);
    },
    [dropdown, dropdownAnchor, dropdownViewport, sheetHeight, labelWidth, trigger, placement, align]
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
