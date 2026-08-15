import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopModelOption } from '../shared/contract';
import { t } from './i18n';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { ModelPicker } from './ModelPicker';
import { useSurfaceActive } from './surface-activity';
import { routeSheetRows, type RouteSheetPane } from './route-editor-logic';

export { routeSheetRows } from './route-editor-logic';

type Box = CSSProperties & { width: number; maxHeight: number };

function placeSheet(trigger: DOMRect): Box {
  const edge = 8;
  const gap = 6;
  const width = 228;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const left = Math.max(edge, Math.min(trigger.right - width, viewportWidth - width - edge));
  const spaceAbove = trigger.top - edge;
  const spaceBelow = viewportHeight - trigger.bottom - edge;
  const openAbove = spaceAbove >= 120 || spaceAbove > spaceBelow;
  const maxHeight = Math.min(280, Math.max(88, (openAbove ? spaceAbove : spaceBelow) - gap));
  return {
    left,
    width,
    maxHeight,
    ...(openAbove
      ? { bottom: viewportHeight - trigger.top + gap }
      : { top: trigger.bottom + gap }),
  };
}

function placeFlyout(sheet: DOMRect, preferredWidth: number, preferredHeight: number): Box {
  const edge = 8;
  const gap = 6;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(preferredWidth, viewportWidth - edge * 2);
  const spaceLeft = sheet.left - edge - gap;
  const spaceRight = viewportWidth - sheet.right - edge - gap;
  const placeLeft = spaceLeft >= Math.min(240, width) || spaceLeft >= spaceRight;
  const left = placeLeft
    ? Math.max(edge, sheet.left - width - gap)
    : Math.min(viewportWidth - width - edge, sheet.right + gap);
  const maxHeight = Math.min(preferredHeight, viewportHeight - edge * 2);
  const top = Math.min(Math.max(edge, sheet.top), viewportHeight - edge - Math.min(maxHeight, 160));
  return { left, top, width, maxHeight };
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
  const [sheetBox, setSheetBox] = useState<Box | null>(null);
  const [flyoutBox, setFlyoutBox] = useState<Box | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const flyout = useRef<HTMLDivElement>(null);
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
  const visible = open && surfaceActive;

  const closeAll = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPane(null);
    setSheetBox(null);
    setFlyoutBox(null);
    if (restoreFocus) {
      window.setTimeout(() => trigger.current?.focus({ preventScroll: true }), 0);
    }
  }, []);

  const layout = useCallback(() => {
    const triggerRect = trigger.current?.getBoundingClientRect();
    if (!triggerRect) return;
    const nextSheet = placeSheet(triggerRect);
    setSheetBox(nextSheet);
    const sheetRect = sheet.current?.getBoundingClientRect();
    if (!sheetRect || !pane) {
      setFlyoutBox(null);
      return;
    }
    setFlyoutBox(placeFlyout(sheetRect, pane === 'model' ? 320 : 220, pane === 'model' ? 380 : 260));
  }, [pane]);

  const show = () => {
    const triggerRect = trigger.current?.getBoundingClientRect();
    if (triggerRect) setSheetBox(placeSheet(triggerRect));
    setPane(null);
    setOpen(true);
  };

  const toggle = () => {
    if (open) closeAll();
    else show();
  };

  const openPane = (next: RouteSheetPane) => {
    if (next !== 'model' && tuningDisabled) return;
    setPane((current) => current === next ? null : next);
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
        || flyout.current?.contains(target)) return;
      closeAll();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (pane) setPane(null);
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
  }, [closeAll, layout, pane, visible]);

  useEffect(() => {
    if (!visible || !pane) return;
    layout();
  }, [layout, pane, visible]);

  const row = (id: RouteSheetPane, label: string, value: string, disabled = false) => (
    <button type="button" className="route-sheet-row" role="menuitem"
      aria-haspopup="menu" aria-expanded={pane === id} disabled={disabled}
      onClick={() => openPane(id)}>
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
    {visible && pane === 'model' && flyoutBox && createPortal(
      <div ref={flyout} className="route-sheet-flyout route-sheet-flyout--model" style={flyoutBox}>
        <ModelPicker models={models} provider={provider} model={model}
          triggerLabel={triggerModel} embedded
          catalogLoaded={catalogLoaded} catalogRefreshing={catalogRefreshing}
          catalogError={catalogError} providerSetupError={providerSetupError}
          onSelect={onSelectModel}
          onClose={() => setPane(null)}
          onOpenProviders={() => {
            closeAll();
            onOpenProviders();
          }} />
      </div>,
      document.body,
    )}
    {visible && pane === 'effort' && flyoutBox && createPortal(
      <div ref={flyout} className="route-sheet-flyout" role="menu" aria-label={t('Reasoning effort')}
        style={flyoutBox}>
        {effortOptions.map((option) => {
          const selected = option.value === effort;
          return <button type="button" key={option.value} className="route-sheet-option" role="menuitemradio"
            aria-checked={selected} disabled={tuningDisabled}
            onClick={() => {
              if (option.value !== effort) onChangeEffort(option.value);
              setPane(null);
            }}>
            <span>{option.label}</span>
            {selected && <Check size={14} aria-hidden="true" />}
          </button>;
        })}
      </div>,
      document.body,
    )}
    {visible && pane === 'speed' && flyoutBox && createPortal(
      <div ref={flyout} className="route-sheet-flyout" role="menu" aria-label={t('Speed')} style={flyoutBox}>
        {([{ value: false, label: t('Standard') }, { value: true, label: t('Fast') }] as const).map((option) => {
          const selected = option.value === fast;
          const disabled = tuningDisabled || (option.value && !fastAvailable);
          return <button type="button" key={option.label} className="route-sheet-option" role="menuitemradio"
            aria-checked={selected} disabled={disabled}
            onClick={() => {
              if (option.value !== fast) onChangeFast(option.value);
              setPane(null);
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
