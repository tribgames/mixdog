import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { useMobileBack } from './mobile-back';
import { OPEN_MODEL_PICKER_EVENT } from './model-picker-event';
import { useRouteDismissal } from './route-editor-effects';
import { useRouteFlyoutFit, useRouteLayout } from './route-editor-layout';
import type { RoutePanelBox, RouteSheetPane } from './route-editor-logic';
import { currentViewport, ROUTE_CLOSE_DURATION } from './route-editor-panes';

type RouteSheetRefs = {
  trigger: RefObject<HTMLButtonElement | null>;
  sheet: RefObject<HTMLDivElement | null>;
  modelFlyout: RefObject<HTMLDivElement | null>;
  optionFlyout: RefObject<HTMLDivElement | null>;
};

/** The sheet's open/close state machine: which pane is open, the boxes the
 *  sheet and flyout occupy, and the refs the panes share. */
export function useRouteSheet({
  dropdown,
  placement,
  align,
  sheetHeight,
  effortCount,
  surfaceActive,
  onOpenSheet,
}: {
  dropdown: boolean;
  placement: 'above' | 'below';
  align: 'start' | 'end';
  sheetHeight: number;
  effortCount: number;
  surfaceActive: boolean;
  onOpenSheet?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [pane, setPane] = useState<RouteSheetPane | null>(null);
  const [sheetBox, setSheetBox] = useState<RoutePanelBox | null>(null);
  const [flyoutBox, setFlyoutBox] = useState<RoutePanelBox | null>(null);
  // Narrow surface (phone): the pane takes over the sheet's footprint and the
  // sheet steps aside, instead of stacking a detached second panel.
  const [drill, setDrill] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const modelFlyout = useRef<HTMLDivElement>(null);
  const optionFlyout = useRef<HTMLDivElement>(null);
  const rowButtons = useRef<Partial<Record<RouteSheetPane, HTMLButtonElement | null>>>({});
  const hoverLock = useRef<RouteSheetPane | null>(null);
  const closeTimer = useRef<number | null>(null);
  // The sheet scales out of the trigger pill, so the
  // pill's size at open time drives the starting transform.
  const morphFrom = useRef<{ width: number; height: number } | null>(null);
  // The pill's natural (unclipped) label width, measured once per opening:
  // the sheet never comes out narrower than the label it shows, so a long
  // model name stays whole while open.
  const labelWidth = useRef<number | null>(null);

  const finishClose = useCallback(() => {
    hoverLock.current = null;
    setClosing(false);
    setPane(null);
    setSheetBox(null);
    setFlyoutBox(null);
    setDrill(false);
  }, []);

  const closeAll = useCallback(
    (restoreFocus = false, immediate = false) => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      setOpen(false);
      // The sheet shrinks back into the pill as it is now.
      const rect = trigger.current?.getBoundingClientRect();
      if (rect) morphFrom.current = { width: rect.width, height: rect.height };
      if (immediate) {
        finishClose();
      } else {
        setClosing(true);
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = null;
          finishClose();
        }, ROUTE_CLOSE_DURATION);
      }
      if (restoreFocus) {
        window.setTimeout(() => trigger.current?.focus({ preventScroll: true }), 0);
      }
    },
    [finishClose]
  );

  const closePane = useCallback((closedPane: RouteSheetPane, restoreFocus = false) => {
    hoverLock.current = closedPane;
    setPane(null);
    setFlyoutBox(null);
    setDrill(false);
    if (restoreFocus) {
      window.setTimeout(() => rowButtons.current[closedPane]?.focus({ preventScroll: true }), 0);
    }
  }, []);

  const { measureSheet, layoutFor, layout } = useRouteLayout({
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
    dropdown,
  });
  const paneRow = () => (pane ? rowButtons.current[pane] : null);
  useRouteFlyoutFit(modelFlyout, pane === 'model' ? flyoutBox : null, setFlyoutBox, paneRow);
  useRouteFlyoutFit(optionFlyout, pane && pane !== 'model' ? flyoutBox : null, setFlyoutBox, paneRow);
  // A drilled pane is hosted by the sheet itself.
  useRouteFlyoutFit(sheet, drill && pane ? flyoutBox : null, setFlyoutBox);

  const show = (focusRow: 'first' | 'last' | null = null) => {
    onOpenSheet?.();
    const triggerRect = trigger.current?.getBoundingClientRect();
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    hoverLock.current = null;
    setClosing(false);
    morphFrom.current = triggerRect ? { width: triggerRect.width, height: triggerRect.height } : null;
    if (triggerRect) {
      const viewport = currentViewport(trigger.current);
      // Fresh label measure per opening: the model may have changed since.
      setSheetBox(measureSheet(triggerRect, viewport, true));
    }
    setPane(null);
    setOpen(true);
    if (focusRow) {
      window.setTimeout(() => {
        const buttons = sheet.current?.querySelectorAll<HTMLButtonElement>('.route-sheet-row:not(:disabled)');
        buttons?.[focusRow === 'first' ? 0 : Math.max(0, buttons.length - 1)]?.focus({ preventScroll: true });
      }, 0);
    }
  };

  const toggle = () => {
    if (open) closeAll();
    else show();
  };

  const visible = open && surfaceActive;
  const mounted = (open || closing) && surfaceActive;
  useRouteSheetGuards({
    open,
    closing,
    surfaceActive,
    mounted,
    visible,
    pane,
    layout,
    closeAll,
    closePane,
    closeTimer,
    refs: { trigger, sheet, modelFlyout, optionFlyout },
  });

  return {
    open,
    closing,
    visible,
    mounted,
    pane,
    setPane,
    drill,
    sheetBox,
    flyoutBox,
    refs: { trigger, sheet, modelFlyout, optionFlyout, rowButtons, hoverLock, morphFrom },
    layoutFor,
    show,
    toggle,
    closeAll,
    closePane,
  };
}

/** Everything that closes the sheet or keeps it placed: a hidden surface,
 *  the mobile back gesture, outside clicks / Escape, and re-layout on pane
 *  change. */
function useRouteSheetGuards({
  open,
  closing,
  surfaceActive,
  mounted,
  visible,
  pane,
  layout,
  closeAll,
  closePane,
  closeTimer,
  refs,
}: {
  open: boolean;
  closing: boolean;
  surfaceActive: boolean;
  mounted: boolean;
  visible: boolean;
  pane: RouteSheetPane | null;
  layout: () => void;
  closeAll: (restoreFocus?: boolean, immediate?: boolean) => void;
  closePane: (pane: RouteSheetPane, restoreFocus?: boolean) => void;
  closeTimer: { current: number | null };
  refs: RouteSheetRefs;
}) {
  useEffect(() => {
    if (!surfaceActive && (open || closing)) closeAll(false, true);
  }, [closeAll, closing, open, surfaceActive]);

  // ABB: sheet and drilled pane each own ONE back step, in the order they
  // opened — back walks the pane away first, then the sheet, exactly like
  // Escape does above.
  useMobileBack(open, () => closeAll(true));
  useMobileBack(Boolean(pane), () => {
    if (pane) closePane(pane, true);
  });

  useRouteDismissal({ mounted, pane, layout, closeAll, closePane, ...refs });

  useEffect(() => {
    if (!visible || !pane) return;
    layout();
  }, [layout, pane, visible]);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [closeTimer]
  );
}

/** Opening panes: the row hover/click/arrow gestures, the /model picker
 *  request, and moving focus into a freshly opened pane. */
export function useRoutePaneNavigation({
  tuningDisabled,
  respondsToModelPicker,
  onOpenModelPane,
  setPane,
  hoverLock,
  layoutFor,
  show,
  refs,
}: {
  tuningDisabled: boolean;
  respondsToModelPicker: boolean;
  onOpenModelPane?: () => void;
  setPane: (pane: RouteSheetPane) => void;
  hoverLock: { current: RouteSheetPane | null };
  layoutFor: (pane: RouteSheetPane) => void;
  show: () => void;
  refs: Pick<RouteSheetRefs, 'sheet' | 'modelFlyout' | 'optionFlyout'>;
}) {
  // Materialize the full flyout on first use, then reuse its rows across opens.
  const [modelCatalogReady, setModelCatalogReady] = useState(false);
  // Safe hover: while a flyout is open, passing over the other rows on the
  // way to it must NOT switch panes — a switch needs a short dwell.
  const hoverSwitchTimer = useRef<number | null>(null);

  const openPane = (next: RouteSheetPane) => {
    if (next !== 'model' && tuningDisabled) return;
    hoverLock.current = null;
    if (next === 'model') {
      setModelCatalogReady(true);
      onOpenModelPane?.();
    }
    layoutFor(next);
    setPane(next);
  };

  const openModelPicker = useRef(() => {});
  openModelPicker.current = () => {
    show();
    openPane('model');
  };
  useEffect(() => {
    if (!respondsToModelPicker) return undefined;
    const onRequest = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      openModelPicker.current();
    };
    window.addEventListener(OPEN_MODEL_PICKER_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_MODEL_PICKER_EVENT, onRequest);
  }, [respondsToModelPicker]);

  useEffect(
    () => () => {
      if (hoverSwitchTimer.current !== null) window.clearTimeout(hoverSwitchTimer.current);
    },
    []
  );

  const focusPane = (next: RouteSheetPane) => {
    window.setTimeout(() => {
      // Read the DOM rather than `drill`: this runs right after the opening
      // state committed, so the live tree tells which surface hosts the pane.
      const drilledPane = refs.sheet.current?.querySelector<HTMLElement>('.route-sheet-pane');
      if (next === 'model') {
        // A drilled catalog keeps the on-screen keyboard shut: the back row
        // takes focus, never the search field.
        if (drilledPane) {
          drilledPane.querySelector<HTMLButtonElement>('.route-sheet-back')?.focus({ preventScroll: true });
        } else {
          refs.modelFlyout.current
            ?.querySelector<HTMLInputElement>('.model-search input')
            ?.focus({ preventScroll: true });
        }
        return;
      }
      (drilledPane || refs.optionFlyout.current)
        ?.querySelector<HTMLButtonElement>('.route-sheet-option:not(:disabled)')
        ?.focus({ preventScroll: true });
    }, 0);
  };

  return { modelCatalogReady, hoverSwitchTimer, openPane, focusPane };
}
