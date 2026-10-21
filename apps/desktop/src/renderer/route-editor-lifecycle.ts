import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { BOOT_WARMUP, scheduleBootWarmup } from './boot-warmup';
import { useMobileBack } from './mobile-back';
import { OPEN_MODEL_PICKER_EVENT } from './model-picker-event';
import { useRouteDismissal } from './route-editor-effects';
import { useRouteFlyoutFit, useRouteLayout } from './route-editor-layout';
import type { RoutePanelBox, RouteSheetPane } from './route-editor-logic';
import { currentViewport, naturalTriggerWidth, ROUTE_CLOSE_DURATION } from './route-editor-panes';

type RouteSheetRefs = {
  trigger: RefObject<HTMLButtonElement | null>;
  sheet: RefObject<HTMLDivElement | null>;
  modelFlyout: RefObject<HTMLDivElement | null>;
  optionFlyout: RefObject<HTMLDivElement | null>;
};

/** Where the pill rests once the sheet closes. Re-measured after a model
 *  change: the current label can have a different natural width than the
 *  label captured when the sheet opened. The resting pill is capped by its
 *  lane (.route-editor shrinks to the footer's leftover width next to the
 *  context gauge), so a long label lands back on the clipped width instead of
 *  overshooting it. */
function restingTriggerWidth(trigger: HTMLButtonElement | null, fallback: number | null): number | null {
  if (!trigger) return fallback;
  const lane = trigger.parentElement?.getBoundingClientRect().width;
  return Math.min(naturalTriggerWidth(trigger), lane || Infinity);
}

/** The sheet's open/close state machine: which pane is open, the boxes the
 *  sheet and flyout occupy, the trigger pill's morph, and the refs the
 *  panes share. */
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
  // While open, the trigger pill expands to the sheet width.
  // null = natural (auto) width; a number drives the width transition.
  const [triggerWidth, setTriggerWidth] = useState<number | null>(null);
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
  // the sheet — and the pill morphing into it — never comes out narrower
  // than the label it shows, so a long model name stays whole while open.
  const labelWidth = useRef<number | null>(null);

  const finishClose = useCallback(() => {
    hoverLock.current = null;
    setClosing(false);
    setPane(null);
    setSheetBox(null);
    setFlyoutBox(null);
    setDrill(false);
    setTriggerWidth(null);
  }, []);

  const closeAll = useCallback(
    (restoreFocus = false, immediate = false) => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      setOpen(false);
      const closeWidth = restingTriggerWidth(trigger.current, morphFrom.current?.width ?? null);
      if (closeWidth !== null) {
        morphFrom.current = {
          width: closeWidth,
          height: morphFrom.current?.height ?? trigger.current?.getBoundingClientRect().height ?? 28,
        };
      }
      if (!dropdown) setTriggerWidth(closeWidth);
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
    [dropdown, finishClose]
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
      const nextSheet = measureSheet(triggerRect, viewport, true);
      setSheetBox(nextSheet);
      // Two-step width: pin the current numeric width first, then widen to
      // the sheet width on the next frame so the transition can run. A
      // dropdown already has the trigger's width.
      if (!dropdown) {
        setTriggerWidth(triggerRect.width);
        window.requestAnimationFrame(() => setTriggerWidth(nextSheet.width));
      }
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
    triggerWidth,
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
  sheetId,
  modelCount,
  tuningDisabled,
  respondsToModelPicker,
  onOpenModelPane,
  setPane,
  hoverLock,
  layoutFor,
  show,
  refs,
}: {
  sheetId: string;
  modelCount: number;
  tuningDisabled: boolean;
  respondsToModelPicker: boolean;
  onOpenModelPane?: () => void;
  setPane: (pane: RouteSheetPane) => void;
  hoverLock: { current: RouteSheetPane | null };
  layoutFor: (pane: RouteSheetPane) => void;
  show: () => void;
  refs: Pick<RouteSheetRefs, 'sheet' | 'modelFlyout' | 'optionFlyout'>;
}) {
  // The model flyout hosts the FULL catalog (every provider row, no
  // virtualization). Mounting it on the first hover of the Model row — and
  // again after every close — made the list land a beat after the sheet
  // (user: 눌렀을 때 반응, 미리 아이템 생성 안 되어 있음). It is mounted once,
  // hidden, in the post-boot warm lane, and stays mounted across closes; the
  // flyout only toggles `hidden`, so the entry animation still plays.
  const [modelCatalogReady, setModelCatalogReady] = useState(false);
  // Safe hover: while a flyout is open, passing over the other rows on the
  // way to it must NOT switch panes — a switch needs a short dwell.
  const hoverSwitchTimer = useRef<number | null>(null);
  useEffect(() => {
    if (modelCatalogReady || modelCount === 0) return undefined;
    return scheduleBootWarmup({
      id: `route-model-catalog:${sheetId}`,
      priority: BOOT_WARMUP.modelCatalog,
      run: () => setModelCatalogReady(true),
    });
  }, [modelCatalogReady, modelCount, sheetId]);

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
