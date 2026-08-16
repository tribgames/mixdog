import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopModelOption } from '../shared/contract';
import { t } from './i18n';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { ModelPicker } from './ModelPicker';
import { useSurfaceActive } from './surface-activity';
import {
  ROUTE_PANEL_PADDING,
  ROUTE_SHEET_ROW_HEIGHT,
  routeFlyoutBox,
  routeSheetBox,
  routeSheetRows,
  type RoutePanelBox,
  type RouteSheetPane,
} from './route-editor-logic';

export { routeSheetRows } from './route-editor-logic';

const ROUTE_CLOSE_DURATION = 110;

function currentViewport(anchor?: HTMLElement | null) {
  const visualViewport = window.visualViewport;
  const viewport = {
    left: visualViewport?.offsetLeft ?? 0,
    top: visualViewport?.offsetTop ?? 0,
    width: visualViewport?.width ?? window.innerWidth,
    height: visualViewport?.height ?? window.innerHeight,
  };
  const pane = anchor?.closest<HTMLElement>('.pane-leaf')?.getBoundingClientRect();
  if (!pane) return viewport;
  const left = Math.max(viewport.left, pane.left);
  const top = Math.max(viewport.top, pane.top);
  const right = Math.min(viewport.left + viewport.width, pane.right);
  const bottom = Math.min(viewport.top + viewport.height, pane.bottom);
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function preferredFlyoutHeight(pane: RouteSheetPane, effortCount: number): number {
  if (pane === 'model') return 380;
  if (pane === 'effort') return Math.min(260, Math.max(44, effortCount * ROUTE_SHEET_ROW_HEIGHT + 8));
  return 80;
}

function preferredFlyoutWidth(pane: RouteSheetPane): number {
  return pane === 'model' ? 296 : 264;
}

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
  catalogLoaded,
  catalogRefreshing,
  catalogError,
  providerSetupError,
  modelDisabled,
  tuningDisabled,
  tooltip = '',
  onSelectModel,
  onChangeEffort,
  onChangeFast,
  onOpenProviders,
}: {
  models: DesktopModelOption[];
  provider: string;
  model: string;
  triggerModel: string;
  effort: string;
  effortOptions: Array<{ value: string; label: string }>;
  fast: boolean;
  fastVisible: boolean;
  fastAvailable: boolean;
  catalogLoaded: boolean;
  catalogRefreshing: boolean;
  catalogError: string;
  providerSetupError: string;
  modelDisabled: boolean;
  tuningDisabled: boolean;
  tooltip?: string;
  onSelectModel(option: DesktopModelOption): unknown;
  onChangeEffort(value: string): void;
  onChangeFast(enabled: boolean): void;
  onOpenProviders(): void;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [pane, setPane] = useState<RouteSheetPane | null>(null);
  const [sheetBox, setSheetBox] = useState<RoutePanelBox | null>(null);
  const [flyoutBox, setFlyoutBox] = useState<RoutePanelBox | null>(null);
  const [modelCatalogReady, setModelCatalogReady] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const modelFlyout = useRef<HTMLDivElement>(null);
  const optionFlyout = useRef<HTMLDivElement>(null);
  const rowButtons = useRef<Partial<Record<RouteSheetPane, HTMLButtonElement | null>>>({});
  const hoverLock = useRef<RouteSheetPane | null>(null);
  const closeTimer = useRef<number | null>(null);
  const clickGuard = useImmediateOverlayClickGuard();
  const surfaceActive = useSurfaceActive();
  const sheetId = useId().replace(/:/g, '');
  const selectedEffort = effortOptions.find((option) => option.value === effort);
  const effortLabel = selectedEffort?.label || '';
  const speedLabel = fast ? t('Fast') : t('Standard');
  const rows = routeSheetRows({
    hasModel: Boolean(provider && model),
    effortCount: effortOptions.length,
    fastVisible,
  });
  const sheetHeight = rows.length * ROUTE_SHEET_ROW_HEIGHT + ROUTE_PANEL_PADDING * 2;
  const paneRowIndex = pane ? rows.indexOf(pane) : -1;
  const visible = open && surfaceActive;
  const mounted = (open || closing) && surfaceActive;

  const finishClose = useCallback(() => {
    hoverLock.current = null;
    setClosing(false);
    setPane(null);
    setSheetBox(null);
    setFlyoutBox(null);
    setModelCatalogReady(false);
  }, []);

  const closeAll = useCallback((restoreFocus = false, immediate = false) => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setOpen(false);
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
  }, [finishClose]);

  const closePane = useCallback((closedPane: RouteSheetPane, restoreFocus = false) => {
    hoverLock.current = closedPane;
    setPane(null);
    setFlyoutBox(null);
    if (restoreFocus) {
      window.setTimeout(() => rowButtons.current[closedPane]?.focus({ preventScroll: true }), 0);
    }
  }, []);

  const layout = useCallback(() => {
    const triggerRect = trigger.current?.getBoundingClientRect();
    if (!triggerRect) return;
    const viewport = currentViewport(trigger.current);
    const nextSheet = routeSheetBox(triggerRect, sheetHeight, viewport);
    setSheetBox(nextSheet);
    if (!pane || paneRowIndex < 0) {
      setFlyoutBox(null);
      return;
    }
    setFlyoutBox(routeFlyoutBox(
      nextSheet,
      paneRowIndex,
      preferredFlyoutHeight(pane, effortOptions.length),
      viewport,
      preferredFlyoutWidth(pane),
    ));
  }, [effortOptions.length, pane, paneRowIndex, sheetHeight]);

  const show = (focusRow: 'first' | 'last' | null = null) => {
    const triggerRect = trigger.current?.getBoundingClientRect();
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    hoverLock.current = null;
    setClosing(false);
    if (triggerRect) setSheetBox(routeSheetBox(triggerRect, sheetHeight, currentViewport(trigger.current)));
    setPane(null);
    setModelCatalogReady(false);
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
    if (next === 'model') setModelCatalogReady(true);
    const rowIndex = rows.indexOf(next);
    if (sheetBox && rowIndex >= 0) {
      setFlyoutBox(routeFlyoutBox(
        sheetBox,
        rowIndex,
        preferredFlyoutHeight(next, effortOptions.length),
        currentViewport(trigger.current),
        preferredFlyoutWidth(next),
      ));
    }
    setPane(next);
  };

  useEffect(() => {
    if (!surfaceActive && (open || closing)) closeAll(false, true);
  }, [closeAll, closing, open, surfaceActive]);

  useEffect(() => {
    if (!mounted) return undefined;
    layout();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (trigger.current?.contains(target)
        || sheet.current?.contains(target)
        || modelFlyout.current?.contains(target)
        || optionFlyout.current?.contains(target)) return;
      closeAll();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (pane) closePane(pane, true);
      else closeAll(true);
    };
    const onViewport = () => layout();
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('scroll', onViewport, true);
    };
  }, [closeAll, closePane, layout, mounted, pane]);

  useEffect(() => {
    if (!visible || !pane) return;
    layout();
  }, [layout, pane, visible]);

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);

  const moveFocus = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    container: HTMLElement | null,
    selector: string,
  ) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;
    const buttons = Array.from(container?.querySelectorAll<HTMLButtonElement>(selector) || []);
    if (!buttons.length) return false;
    event.preventDefault();
    event.stopPropagation();
    const current = buttons.indexOf(event.currentTarget);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
    return true;
  };

  const focusPane = (next: RouteSheetPane) => {
    window.setTimeout(() => {
      if (next === 'model') {
        modelFlyout.current?.querySelector<HTMLInputElement>('.model-search input')?.focus({ preventScroll: true });
      } else {
        optionFlyout.current?.querySelector<HTMLButtonElement>('.route-sheet-option:not(:disabled)')?.focus({
          preventScroll: true,
        });
      }
    }, 0);
  };

  const row = (id: RouteSheetPane, label: string, value: string, disabled = false) => (
    <button ref={(node) => { rowButtons.current[id] = node; }} type="button"
      className="route-sheet-row" role="menuitem"
      aria-haspopup="menu" aria-expanded={pane === id} disabled={disabled}
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch' || hoverLock.current === id) return;
        openPane(id);
      }}
      onPointerLeave={() => {
        if (hoverLock.current === id) hoverLock.current = null;
      }}
      onClick={() => {
        if (pane === id) closePane(id);
        else openPane(id);
      }}
      onKeyDown={(event) => {
        if (moveFocus(event, sheet.current, '.route-sheet-row:not(:disabled)')) return;
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          openPane(id);
          focusPane(id);
        }
      }}>
      <span className="route-sheet-label">{label}</span>
      <span className="route-sheet-value">{value}</span>
      <ChevronRight size={14} aria-hidden="true" />
    </button>
  );

  return <div className="route-editor">
    <button ref={trigger} type="button" className="model-trigger" disabled={modelDisabled}
      aria-label={tooltip} aria-haspopup="menu" aria-expanded={visible}
      aria-controls={visible ? `route-sheet-${sheetId}` : undefined}
      data-tooltip={tooltip} data-tooltip-side="top"
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
      onPointerCancel={clickGuard.clearPointerActivation}>
      <span className="route-trigger-copy">
        <span className="route-trigger-model">{triggerModel}</span>
        {effortLabel && <span className="route-trigger-effort">{effortLabel}</span>}
        {fast && <span className="route-trigger-fast">{t('Fast')}</span>}
      </span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {mounted && sheetBox && createPortal(
      <div ref={sheet} id={`route-sheet-${sheetId}`} className="route-sheet" role="menu"
        aria-label={t('Choose model')} style={sheetBox} data-placement={sheetBox.placement}
        data-state={closing ? 'closing' : 'open'}>
        {row('model', t('Model'), triggerModel)}
        {rows.includes('effort') && row('effort', t('Reasoning effort'), effortLabel || t('Reasoning effort'), tuningDisabled)}
        {rows.includes('speed') && row('speed', t('Speed'), speedLabel, tuningDisabled)}
      </div>,
      document.body,
    )}
    {mounted && modelCatalogReady && createPortal(
      <div ref={modelFlyout} className="route-sheet-flyout route-sheet-flyout--model"
        hidden={pane !== 'model'} data-placement={flyoutBox?.placement}
        data-state={closing ? 'closing' : 'open'}
        style={pane === 'model' && flyoutBox ? flyoutBox : { display: 'none' }}>
        <ModelPicker models={models} provider={provider} model={model}
          triggerLabel={triggerModel} embedded active={pane === 'model'}
          catalogLoaded={catalogLoaded} catalogRefreshing={catalogRefreshing}
          catalogError={catalogError} providerSetupError={providerSetupError}
          onSelect={onSelectModel}
          onClose={() => closeAll(true)}
          onOpenProviders={() => {
            closeAll();
            onOpenProviders();
          }} />
      </div>,
      document.body,
    )}
    {mounted && pane === 'effort' && flyoutBox && createPortal(
      <div ref={optionFlyout} className="route-sheet-flyout" role="menu" aria-label={t('Reasoning effort')}
        style={flyoutBox} data-placement={flyoutBox.placement} data-state={closing ? 'closing' : 'open'}>
        {effortOptions.map((option) => {
          const selected = option.value === effort;
          return <button type="button" key={option.value} className="route-sheet-option" role="menuitemradio"
            aria-checked={selected} disabled={tuningDisabled}
            onClick={() => {
              if (option.value !== effort) onChangeEffort(option.value);
              closeAll(true);
            }}
            onKeyDown={(event) => {
              if (moveFocus(event, optionFlyout.current, '.route-sheet-option:not(:disabled)')) return;
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                closePane('effort', true);
              }
            }}>
            <span>{option.label}</span>
            {selected && <Check size={14} aria-hidden="true" />}
          </button>;
        })}
      </div>,
      document.body,
    )}
    {mounted && pane === 'speed' && flyoutBox && createPortal(
      <div ref={optionFlyout} className="route-sheet-flyout" role="menu" aria-label={t('Speed')} style={flyoutBox}
        data-placement={flyoutBox.placement} data-state={closing ? 'closing' : 'open'}>
        {([{ value: false, label: t('Standard') }, { value: true, label: t('Fast') }] as const).map((option) => {
          const selected = option.value === fast;
          const disabled = tuningDisabled || (option.value && !fastAvailable);
          return <button type="button" key={option.label} className="route-sheet-option" role="menuitemradio"
            aria-checked={selected} disabled={disabled}
            onClick={() => {
              if (option.value !== fast) onChangeFast(option.value);
              closeAll(true);
            }}
            onKeyDown={(event) => {
              if (moveFocus(event, optionFlyout.current, '.route-sheet-option:not(:disabled)')) return;
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                closePane('speed', true);
              }
            }}>
            <span>{option.label}</span>
            {selected && <Check size={14} aria-hidden="true" />}
          </button>;
        })}
      </div>,
      document.body,
    )}
  </div>;
}
