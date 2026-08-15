import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
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

function currentViewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function preferredFlyoutHeight(pane: RouteSheetPane, effortCount: number): number {
  if (pane === 'model') return 380;
  if (pane === 'effort') return Math.min(260, Math.max(44, effortCount * ROUTE_SHEET_ROW_HEIGHT + 8));
  return 80;
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

  const closeAll = useCallback((restoreFocus = false) => {
    hoverLock.current = null;
    setOpen(false);
    setPane(null);
    setSheetBox(null);
    setFlyoutBox(null);
    setModelCatalogReady(false);
    if (restoreFocus) {
      window.setTimeout(() => trigger.current?.focus({ preventScroll: true }), 0);
    }
  }, []);

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
    const viewport = currentViewport();
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
    ));
  }, [effortOptions.length, pane, paneRowIndex, sheetHeight]);

  const show = () => {
    const triggerRect = trigger.current?.getBoundingClientRect();
    hoverLock.current = null;
    if (triggerRect) setSheetBox(routeSheetBox(triggerRect, sheetHeight, currentViewport()));
    setPane(null);
    setModelCatalogReady(false);
    setOpen(true);
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
        currentViewport(),
      ));
    }
    setPane(next);
  };

  useEffect(() => {
    if (!surfaceActive && open) closeAll();
  }, [closeAll, open, surfaceActive]);

  useEffect(() => {
    if (!visible) return undefined;
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
  }, [closeAll, closePane, layout, pane, visible]);

  useEffect(() => {
    if (!visible || !pane) return;
    layout();
  }, [layout, pane, visible]);

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
      </span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {visible && sheetBox && createPortal(
      <div ref={sheet} id={`route-sheet-${sheetId}`} className="route-sheet" role="menu"
        aria-label={t('Choose model')} style={sheetBox}>
        {row('model', t('Model'), triggerModel)}
        {rows.includes('effort') && row('effort', t('Reasoning effort'), effortLabel || t('Reasoning effort'), tuningDisabled)}
        {rows.includes('speed') && row('speed', t('Speed'), speedLabel, tuningDisabled)}
      </div>,
      document.body,
    )}
    {visible && modelCatalogReady && createPortal(
      <div ref={modelFlyout} className="route-sheet-flyout route-sheet-flyout--model"
        hidden={pane !== 'model'}
        style={pane === 'model' && flyoutBox ? flyoutBox : { display: 'none' }}>
        <ModelPicker models={models} provider={provider} model={model}
          triggerLabel={triggerModel} embedded active={pane === 'model'}
          catalogLoaded={catalogLoaded} catalogRefreshing={catalogRefreshing}
          catalogError={catalogError} providerSetupError={providerSetupError}
          onSelect={onSelectModel}
          onClose={() => closePane('model', true)}
          onOpenProviders={() => {
            closeAll();
            onOpenProviders();
          }} />
      </div>,
      document.body,
    )}
    {visible && pane === 'effort' && flyoutBox && createPortal(
      <div ref={optionFlyout} className="route-sheet-flyout" role="menu" aria-label={t('Reasoning effort')}
        style={flyoutBox}>
        {effortOptions.map((option) => {
          const selected = option.value === effort;
          return <button type="button" key={option.value} className="route-sheet-option" role="menuitemradio"
            aria-checked={selected} disabled={tuningDisabled}
            onClick={() => {
              if (option.value !== effort) onChangeEffort(option.value);
              closePane('effort', true);
            }}>
            <span>{option.label}</span>
            {selected && <Check size={14} aria-hidden="true" />}
          </button>;
        })}
      </div>,
      document.body,
    )}
    {visible && pane === 'speed' && flyoutBox && createPortal(
      <div ref={optionFlyout} className="route-sheet-flyout" role="menu" aria-label={t('Speed')} style={flyoutBox}>
        {([{ value: false, label: t('Standard') }, { value: true, label: t('Fast') }] as const).map((option) => {
          const selected = option.value === fast;
          const disabled = tuningDisabled || (option.value && !fastAvailable);
          return <button type="button" key={option.label} className="route-sheet-option" role="menuitemradio"
            aria-checked={selected} disabled={disabled}
            onClick={() => {
              if (option.value !== fast) onChangeFast(option.value);
              closePane('speed', true);
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
