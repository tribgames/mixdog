import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { DesktopModelOption } from '../shared/contract';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { BOOT_WARMUP, scheduleBootWarmup } from './boot-warmup';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { ModelCatalog } from './model-catalog';
import { type RouteSpeed, routeSpeed } from './model-route-utils';
import { formatContextWindow, ModelRouteLabel } from './provider-display';
import { useSurfaceActive } from './surface-activity';
import { OPEN_MODEL_PICKER_EVENT } from './model-picker-event';
import { RouteAutoEffortToggle } from './route-editor-auto-effort';
import { useContextDraft } from './route-editor-context';
import { useRouteDismissal, useRouteFontWarmup } from './route-editor-effects';
import { useRouteLayout } from './route-editor-layout';
import {
  ROUTE_PANEL_PADDING,
  ROUTE_SHEET_ROW_HEIGHT,
  routeSheetRows,
  type RoutePanelBox,
  type RouteSheetPane,
} from './route-editor-logic';
import {
  ROUTE_CLOSE_DURATION,
  naturalTriggerWidth,
  modelParameterLabel,
  currentViewport,
  moveRouteFocus,
  routeEffortPane,
  routeSpeedPane,
  routeContextPane,
  routeParameterPane,
  type RouteAutoEffort,
} from './route-editor-panes';

export { routeSheetRows } from './route-editor-logic';

export function RouteEditor({
  models,
  provider,
  model,
  triggerModel,
  effort,
  effortOptions,
  fast,
  fastVisible,
  fastAvailable,
  contextVisible,
  contextPercent,
  contextDefaultPercent,
  contextTokens,
  contextMaxTokens = 0,
  contextDefaultTokens = 0,
  modelParameterOptions = [],
  modelParameters = {},
  catalogLoaded,
  catalogRefreshing,
  catalogError,
  providerSetupError,
  modelDisabled,
  tuningDisabled,
  tooltip = '',
  onSelectModel,
  onChangeEffort,
  onChangeSpeed,
  onChangeContext,
  onChangeModelParameter,
  onOpenProviders,
  onOpenModelPane,
  autoEffort = null,
  onChangeAutoEffort = () => {},
  onOpenSheet,
  answersModelPickerRequests = false,
}: {
  /** Only the focused conversation's composer sets this; it is the single
   *  responder to the open-model-picker event. */
  answersModelPickerRequests?: boolean;
  models: DesktopModelOption[];
  provider: string;
  model: string;
  triggerModel: string;
  effort: string;
  effortOptions: Array<{ value: string; label: string }>;
  fast: boolean;
  fastVisible: boolean;
  fastAvailable: boolean;
  contextVisible: boolean;
  contextPercent: number;
  contextDefaultPercent: number;
  contextTokens: number;
  contextMaxTokens?: number;
  contextDefaultTokens?: number;
  modelParameterOptions?: DesktopModelOption['modelParameterOptions'];
  modelParameters?: Record<string, string>;
  catalogLoaded: boolean;
  catalogRefreshing: boolean;
  catalogError: string;
  providerSetupError: string;
  modelDisabled: boolean;
  tuningDisabled: boolean;
  tooltip?: string;
  onSelectModel(option: DesktopModelOption): unknown;
  onChangeEffort(value: string): void;
  onChangeSpeed(speed: RouteSpeed): void;
  onChangeContext(percent: number): void;
  onChangeModelParameter?(id: string, value: string): void;
  onOpenProviders?: () => void;
  /** Opening the catalog is also the user's retry gesture: the owner may
   *  re-request a catalog whose previous fetch failed. */
  onOpenModelPane?: () => void;
  autoEffort?: RouteAutoEffort;
  onChangeAutoEffort?(enabled: boolean): void;
  /** Opening the sheet lets the owner re-read the Auto effort switch. */
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
  // The model flyout hosts the FULL catalog (every provider row, no
  // virtualization). Mounting it on the first hover of the Model row — and
  // again after every close — made the list land a beat after the sheet
  // (user: 눌렀을 때 반응, 미리 아이템 생성 안 되어 있음). It is mounted once,
  // hidden, in the post-boot warm lane, and stays mounted across closes; the
  // flyout only toggles `hidden`, so the entry animation still plays.
  const [modelCatalogReady, setModelCatalogReady] = useState(false);
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
  // Safe hover: while a flyout is open, passing over the other rows on the
  // way to it must NOT switch panes — a switch needs a short dwell.
  const hoverSwitchTimer = useRef<number | null>(null);
  // The sheet scales out of the trigger pill, so the
  // pill's size at open time drives the starting transform.
  const morphFrom = useRef<{ width: number; height: number } | null>(null);
  // The pill's natural (unclipped) label width, measured once per opening:
  // the sheet — and the pill morphing into it — never comes out narrower
  // than the label it shows, so a long model name stays whole while open.
  const labelWidth = useRef<number | null>(null);
  const clickGuard = useImmediateOverlayClickGuard();
  const surfaceActive = useSurfaceActive();
  const sheetId = useId().replace(/:/g, '');
  useEffect(() => {
    if (modelCatalogReady || models.length === 0) return undefined;
    return scheduleBootWarmup({
      id: `route-model-catalog:${sheetId}`,
      priority: BOOT_WARMUP.modelCatalog,
      run: () => setModelCatalogReady(true),
    });
  }, [modelCatalogReady, models.length, sheetId]);
  const selectedEffort = effortOptions.find((option) => option.value === effort);
  const autoEffortOn = autoEffort?.enabled === true;
  // "Auto" is the effort's name (like "Fast"), shown untranslated on the model
  // chip and the Reasoning effort row.
  const effortLabel = autoEffortOn ? 'Auto' : selectedEffort?.label || '';
  const ultrafastAvailable = modelParameterOptions.some(
    (parameter) => parameter.id === 'serviceTier' && parameter.options.some((option) => option.value === 'ultrafast')
  );
  const speed = routeSpeed(fast, modelParameters);
  const speedLabels = { standard: t('Standard'), fast: t('Fast'), ultrafast: t('Ultrafast') };
  const speedLabel = speedLabels[speed];
  // The slider row IS the context control (TUI parity): a provider's own
  // context-window parameter (Cursor 272K/1M) must never duplicate it.
  // `serviceTier` is the Speed row's Ultrafast tier, never a generic row.
  const parameterRows = modelParameterOptions.filter(
    (parameter) => parameter.id !== 'serviceTier' && !(contextVisible && parameter.id === 'context')
  );
  const rows = routeSheetRows({
    hasModel: Boolean(provider && model),
    effortCount: effortOptions.length,
    contextVisible,
    fastVisible,
    parameterIds: parameterRows.map((parameter) => parameter.id),
  });
  const autoEffortRow = Boolean(autoEffort) && rows.includes('effort');
  const sheetHeight = (rows.length + (autoEffortRow ? 1 : 0)) * ROUTE_SHEET_ROW_HEIGHT + ROUTE_PANEL_PADDING * 2;
  const visible = open && surfaceActive;
  const mounted = (open || closing) && surfaceActive;
  const { setContextDraft, shownContextPercent, shownContextTokens, defaultContextTokens, commitContextDraft } =
    useContextDraft({
      pane,
      contextPercent,
      contextDefaultPercent,
      contextTokens,
      contextMaxTokens,
      contextDefaultTokens,
      onChangeContext,
    });

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
      // Re-measure after a model change: the current label can have a different
      // natural width than the label captured when the sheet opened.
      // The resting pill is capped by its lane (.route-editor shrinks to the
      // footer's leftover width next to the context gauge), so a long label
      // lands back on the clipped width instead of overshooting it.
      const lane = trigger.current?.parentElement?.getBoundingClientRect().width;
      const closeWidth = trigger.current
        ? Math.min(naturalTriggerWidth(trigger.current), lane || Infinity)
        : (morphFrom.current?.width ?? null);
      if (closeWidth !== null) {
        morphFrom.current = {
          width: closeWidth,
          height: morphFrom.current?.height ?? trigger.current?.getBoundingClientRect().height ?? 28,
        };
      }
      setTriggerWidth(closeWidth);
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
    effortCount: effortOptions.length,
    sheetHeight,
    pane,
    setSheetBox,
    setFlyoutBox,
    setDrill,
  });

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
      // the sheet width on the next frame so the transition can run.
      setTriggerWidth(triggerRect.width);
      window.requestAnimationFrame(() => setTriggerWidth(nextSheet.width));
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
  const respondsToModelPicker = answersModelPickerRequests && surfaceActive && !modelDisabled;
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

  useRouteDismissal({ mounted, pane, layout, closeAll, closePane, trigger, sheet, modelFlyout, optionFlyout });

  useEffect(() => {
    if (!visible || !pane) return;
    layout();
  }, [layout, pane, visible]);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      if (hoverSwitchTimer.current !== null) window.clearTimeout(hoverSwitchTimer.current);
    },
    []
  );

  useRouteFontWarmup();

  const focusPane = (next: RouteSheetPane) => {
    window.setTimeout(() => {
      // Read the DOM rather than `drill`: this runs right after the opening
      // state committed, so the live tree tells which surface hosts the pane.
      const drilledPane = sheet.current?.querySelector<HTMLElement>('.route-sheet-pane');
      if (next === 'model') {
        // A drilled catalog keeps the on-screen keyboard shut: the back row
        // takes focus, never the search field.
        if (drilledPane) {
          drilledPane.querySelector<HTMLButtonElement>('.route-sheet-back')?.focus({ preventScroll: true });
        } else {
          modelFlyout.current?.querySelector<HTMLInputElement>('.model-search input')?.focus({ preventScroll: true });
        }
        return;
      }
      (drilledPane || optionFlyout.current)
        ?.querySelector<HTMLButtonElement>('.route-sheet-option:not(:disabled)')
        ?.focus({ preventScroll: true });
    }, 0);
  };

  const cancelHoverSwitch = () => {
    if (hoverSwitchTimer.current === null) return;
    window.clearTimeout(hoverSwitchTimer.current);
    hoverSwitchTimer.current = null;
  };

  const row = (id: RouteSheetPane, label: string, value: string, disabled = false) => (
    <button
      key={id}
      ref={(node) => {
        rowButtons.current[id] = node;
      }}
      type="button"
      className="route-sheet-row"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={pane === id}
      disabled={disabled}
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch' || hoverLock.current === id) return;
        if (pane === id) return;
        if (pane) {
          // Another pane is open: only a dwell switches, so the pointer can
          // travel across intermediate rows into the open flyout.
          if (hoverSwitchTimer.current !== null) window.clearTimeout(hoverSwitchTimer.current);
          hoverSwitchTimer.current = window.setTimeout(() => {
            hoverSwitchTimer.current = null;
            openPane(id);
          }, 140);
          return;
        }
        openPane(id);
      }}
      onPointerLeave={() => {
        cancelHoverSwitch();
        if (hoverLock.current === id) hoverLock.current = null;
      }}
      onClick={() => {
        cancelHoverSwitch();
        // Click always OPENS (hover already opened it — a toggle here would
        // close the flyout under the very click that targeted it). Escape /
        // ArrowLeft / outside-click remain the ways to close.
        if (pane !== id) openPane(id);
      }}
      onKeyDown={(event) => {
        if (moveRouteFocus(event, sheet.current, '.route-sheet-row:not(:disabled)')) return;
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          openPane(id);
          focusPane(id);
        }
      }}
    >
      <span className="route-sheet-label">{label}</span>
      <span className="route-sheet-value">{value}</span>
      <ChevronRight size={14} aria-hidden="true" />
    </button>
  );

  // A drilled pane replaced the sheet, so its first row walks back up one
  // level; a flyout that opened beside the sheet keeps the plain title.
  const paneHeader = (label: string, target: RouteSheetPane) =>
    drill ? (
      <button type="button" className="route-sheet-back" aria-label={t('Back')} onClick={() => closePane(target, true)}>
        <ChevronLeft size={14} aria-hidden="true" />
        <span>{label}</span>
      </button>
    ) : (
      <div className="route-sheet-flyout-title" aria-hidden="true">
        {label}
      </div>
    );

  // Whichever surface currently hosts the open pane: the sheet itself while
  // drilled, the flyout beside it otherwise.
  const paneContainer = () =>
    sheet.current?.querySelector('.route-sheet-pane') ? sheet.current : optionFlyout.current;

  const paneLabel = (target: RouteSheetPane): string => {
    if (target === 'model') return t('Model');
    if (target === 'effort') return t('Reasoning effort');
    if (target === 'context') return t('Context');
    if (target === 'speed') return t('Speed');
    const parameter = parameterRows.find((entry) => `parameter:${entry.id}` === target);
    return parameter ? modelParameterLabel(parameter) : '';
  };

  /** ArrowLeft walks back out of the pane it was pressed in; the other keys
   *  rove between its options. */
  const paneOptionKeyDown = (target: RouteSheetPane) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (moveRouteFocus(event, paneContainer(), '.route-sheet-option:not(:disabled)')) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      closePane(target, true);
    }
  };

  const paneBody = (target: RouteSheetPane): ReactNode => {
    if (target === 'effort') {
      return routeEffortPane({
        effort,
        effortOptions,
        tuningDisabled,
        onChangeEffort,
        onOptionKeyDown: paneOptionKeyDown('effort'),
      });
    }
    if (target === 'speed') {
      return routeSpeedPane({
        speed,
        fastAvailable,
        ultrafastAvailable,
        tuningDisabled,
        onChangeSpeed,
        onOptionKeyDown: paneOptionKeyDown('speed'),
      });
    }
    if (target === 'context') {
      return routeContextPane({
        contextDefaultPercent,
        defaultContextTokens,
        shownContextPercent,
        shownContextTokens,
        tuningDisabled,
        onCommitDraft: commitContextDraft,
        onDraftChange: setContextDraft,
        onResetDefault: () => {
          setContextDraft(null);
          onChangeContext(contextDefaultPercent);
        },
      });
    }
    const parameter = parameterRows.find((entry) => `parameter:${entry.id}` === target);
    if (!parameter) return null;
    return routeParameterPane({
      parameter,
      value: modelParameters[parameter.id],
      tuningDisabled,
      onChangeModelParameter,
      onOptionKeyDown: paneOptionKeyDown(target),
    });
  };

  // Drilled: ONE panel — the sheet itself takes the pane's box and content,
  // so the menu stays a single window growing out of the pill instead of a
  // second card floating over it (user: 한 창이라는 느낌이 덜하다).
  const drilled = drill && Boolean(pane);
  const panelBox = drilled && flyoutBox ? flyoutBox : sheetBox;
  // One catalog, hosted either by the drilled sheet or by its own flyout.
  const renderModelCatalog = (active: boolean) => (
    <ModelCatalog
      models={models}
      provider={provider}
      model={model}
      active={active}
      catalogLoaded={catalogLoaded}
      catalogRefreshing={catalogRefreshing}
      catalogError={catalogError}
      providerSetupError={providerSetupError}
      onSelect={onSelectModel}
      onClose={() => closePane('model', true)}
      onOpenProviders={() => {
        closeAll();
        onOpenProviders?.();
      }}
    />
  );

  return (
    <div className="route-editor">
      <button
        ref={trigger}
        type="button"
        className="model-trigger"
        disabled={modelDisabled}
        style={triggerWidth !== null ? { width: triggerWidth } : undefined}
        data-morph={triggerWidth !== null ? '' : undefined}
        aria-label={tooltip}
        aria-haspopup="menu"
        aria-expanded={visible}
        aria-controls={visible ? `route-sheet-${sheetId}` : undefined}
        data-tooltip={tooltip}
        data-tooltip-side="top"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          show(event.key === 'ArrowDown' ? 'first' : 'last');
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          clickGuard.markPointerActivation();
          commitImmediateOverlay(toggle);
        }}
        onClick={(event) => {
          if (clickGuard.consumePointerClick()) return;
          if (event.detail !== 0) return;
          commitImmediateOverlay(toggle);
        }}
        onPointerCancel={clickGuard.clearPointerActivation}
      >
        <span className="route-trigger-copy">
          <ModelRouteLabel
            model={triggerModel}
            effort={autoEffortOn ? '' : effort}
            fast={fast}
            effortLabel={effortLabel}
          />
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {mounted &&
        panelBox &&
        createPortal(
          <div
            ref={sheet}
            id={`route-sheet-${sheetId}`}
            className="route-sheet"
            role="menu"
            aria-label={drilled && pane ? paneLabel(pane) : t('Choose model')}
            style={
              {
                ...panelBox,
                '--route-morph-sx': String(
                  Math.min(1, Math.max(0.1, (morphFrom.current?.width || panelBox.width) / panelBox.width))
                ),
                '--route-morph-sy': String(
                  Math.min(1, Math.max(0.1, (morphFrom.current?.height || panelBox.height) / panelBox.height))
                ),
              } as CSSProperties
            }
            data-placement={panelBox.placement}
            data-drilled={drilled ? '' : undefined}
            data-state={closing ? 'closing' : 'open'}
          >
            {drilled && pane && (
              <div className="route-sheet-pane" key={`pane:${pane}`}>
                {paneHeader(paneLabel(pane), pane)}
                {pane === 'model' ? renderModelCatalog(true) : paneBody(pane)}
              </div>
            )}
            {!(drilled && pane) && (
              <div className="route-sheet-rows" key="rows">
                {row('model', t('Model'), triggerModel)}
                {rows.includes('effort') &&
                  row('effort', t('Reasoning effort'), effortLabel || t('Reasoning effort'), tuningDisabled)}
                {rows.includes('context') &&
                  row(
                    'context',
                    t('Context'),
                    formatContextWindow(contextTokens).replace(/ Context$/, ''),
                    tuningDisabled
                  )}
                {parameterRows.map((parameter) =>
                  row(
                    `parameter:${parameter.id}`,
                    modelParameterLabel(parameter),
                    parameter.options.find((option) => option.value === modelParameters[parameter.id])?.label ||
                      modelParameters[parameter.id] ||
                      parameter.options[0]?.label ||
                      '',
                    tuningDisabled
                  )
                )}
                {rows.includes('speed') && row('speed', t('Speed'), speedLabel, tuningDisabled)}
                {autoEffortRow && autoEffort && (
                  <RouteAutoEffortToggle
                    enabled={autoEffort.enabled}
                    disabled={tuningDisabled || autoEffort.pending}
                    onChange={onChangeAutoEffort}
                  />
                )}
              </div>
            )}
          </div>,
          document.body
        )}
      {modelCatalogReady &&
        !drill &&
        surfaceActive &&
        createPortal(
          <div
            ref={modelFlyout}
            className="route-sheet-flyout route-sheet-flyout--model"
            hidden={pane !== 'model'}
            data-placement={flyoutBox?.placement}
            data-state={closing ? 'closing' : 'open'}
            style={pane === 'model' && flyoutBox ? flyoutBox : { display: 'none' }}
          >
            {renderModelCatalog(pane === 'model')}
          </div>,
          document.body
        )}
      {mounted &&
        !drill &&
        pane &&
        pane !== 'model' &&
        flyoutBox &&
        createPortal(
          <div
            ref={optionFlyout}
            className="route-sheet-flyout"
            role="menu"
            aria-label={paneLabel(pane)}
            style={flyoutBox}
            data-placement={flyoutBox.placement}
            data-state={closing ? 'closing' : 'open'}
          >
            {paneHeader(paneLabel(pane), pane)}
            {paneBody(pane)}
          </div>,
          document.body
        )}
    </div>
  );
}
