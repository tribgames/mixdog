import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import {
  Fragment,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type { DesktopModelOption } from '../shared/contract';
import { t } from './i18n';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { ModelCatalog } from './model-catalog';
import { formatContextWindow } from './provider-display';
import { useSurfaceActive } from './surface-activity';
import {
  ROUTE_PANEL_PADDING,
  ROUTE_PANEL_WIDTH,
  ROUTE_SHEET_ROW_HEIGHT,
  routeFlyoutBox,
  routeSheetBox,
  routeSheetRows,
  type RoutePanelBox,
  type RouteSheetPane,
} from './route-editor-logic';

export { routeSheetRows } from './route-editor-logic';

// Leave one paint of headroom beyond the 110ms CSS exit so the surface and
// trigger reach their final frame before their fixed widths are released.
const ROUTE_CLOSE_DURATION = 140;

function naturalTriggerWidth(button: HTMLButtonElement): number {
  const parent = button.parentElement;
  if (!parent) return button.getBoundingClientRect().width;
  const probe = button.cloneNode(true) as HTMLButtonElement;
  probe.removeAttribute('id');
  probe.setAttribute('aria-hidden', 'true');
  probe.tabIndex = -1;
  probe.style.position = 'fixed';
  probe.style.left = '-10000px';
  probe.style.top = '0';
  probe.style.width = 'auto';
  probe.style.maxWidth = 'none';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.transition = 'none';
  parent.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

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

/** Left-anchored sheet: a synthetic rect whose right edge sits one sheet
 *  width from the pill's left edge, so routeSheetBox aligns left edges. */
function sheetAnchor(
  rect: { left: number; top: number; bottom: number },
  viewport: { width: number },
) {
  // 16 = ROUTE_PANEL_EDGE * 2 (routeSheetBox clamps the width the same way).
  const width = Math.min(ROUTE_PANEL_WIDTH, Math.max(1, viewport.width - 16));
  return { left: rect.left, right: rect.left + width, top: rect.top, bottom: rect.bottom };
}

function preferredFlyoutHeight(pane: RouteSheetPane, effortCount: number): number {
  if (pane === 'model') return 380;
  if (pane === 'effort') return Math.min(300, Math.max(44, effortCount * ROUTE_SHEET_ROW_HEIGHT + 34));
  if (pane === 'context') return 100;
  return 132;
}

/** The model catalog needs more room than the menu column; the option panes
 *  match the sheet width. */
function preferredFlyoutWidth(pane: RouteSheetPane): number | undefined {
  return pane === 'model' ? 280 : undefined;
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
  onChangeFast,
  onChangeContext,
  onChangeModelParameter,
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
  onChangeFast(enabled: boolean): void;
  onChangeContext(percent: number): void;
  onChangeModelParameter?(id: string, value: string): void;
  onOpenProviders?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [pane, setPane] = useState<RouteSheetPane | null>(null);
  const [sheetBox, setSheetBox] = useState<RoutePanelBox | null>(null);
  const [flyoutBox, setFlyoutBox] = useState<RoutePanelBox | null>(null);
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
  // Context slider drag preview: local until commit (pointer/key release);
  // the routed contextPercent takes over once the snapshot catches up.
  const [contextDraft, setContextDraft] = useState<number | null>(null);
  const clickGuard = useImmediateOverlayClickGuard();
  const surfaceActive = useSurfaceActive();
  const sheetId = useId().replace(/:/g, '');
  const selectedEffort = effortOptions.find((option) => option.value === effort);
  const effortLabel = selectedEffort?.label || '';
  const speedLabel = fast ? t('Fast') : t('Standard');
  const rows = routeSheetRows({
    hasModel: Boolean(provider && model),
    effortCount: effortOptions.length,
    contextVisible,
    fastVisible,
    parameterIds: modelParameterOptions.map((parameter) => parameter.id),
  });
  const sheetHeight = rows.length * ROUTE_SHEET_ROW_HEIGHT + ROUTE_PANEL_PADDING * 2;
  const visible = open && surfaceActive;
  const mounted = (open || closing) && surfaceActive;
  const shownContextPercent = contextDraft ?? contextPercent;
  const shownContextTokens = shownContextPercent === contextPercent
    ? contextTokens
    : shownContextPercent === contextDefaultPercent && contextDefaultTokens
      ? contextDefaultTokens
      : contextMaxTokens
        ? Math.max(1, Math.floor(contextMaxTokens * shownContextPercent / 100))
        : contextTokens;
  const defaultContextTokens = contextDefaultTokens
    || (contextMaxTokens
      ? Math.max(1, Math.floor(contextMaxTokens * contextDefaultPercent / 100))
      : contextTokens);
  const commitContextDraft = () => {
    if (contextDraft === null || contextDraft === contextPercent) return;
    onChangeContext(contextDraft);
  };
  useEffect(() => {
    // A closed/left pane or a snapshot that caught up releases the preview.
    if (contextDraft !== null && (pane !== 'context' || contextDraft === contextPercent)) {
      setContextDraft(null);
    }
  }, [pane, contextDraft, contextPercent]);

  const finishClose = useCallback(() => {
    hoverLock.current = null;
    setClosing(false);
    setPane(null);
    setSheetBox(null);
    setFlyoutBox(null);
    setModelCatalogReady(false);
    setTriggerWidth(null);
  }, []);

  const closeAll = useCallback((restoreFocus = false, immediate = false) => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setOpen(false);
    // Re-measure after a model change: the current label can have a different
    // natural width than the label captured when the sheet opened.
    const closeWidth = trigger.current
      ? naturalTriggerWidth(trigger.current)
      : morphFrom.current?.width ?? null;
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
    // The sheet anchors to the pill's LEFT edge: the pill expands rightwards
    // to the sheet width, so both share the same left edge and width.
    const nextSheet = routeSheetBox(sheetAnchor(triggerRect, viewport), sheetHeight, viewport);
    setSheetBox(nextSheet);
    if (!pane) {
      setFlyoutBox(null);
      return;
    }
    setFlyoutBox(routeFlyoutBox(
      nextSheet,
      preferredFlyoutHeight(pane, effortOptions.length),
      viewport,
      rowButtons.current[pane]?.getBoundingClientRect().top,
      preferredFlyoutWidth(pane),
    ));
  }, [effortOptions.length, pane, sheetHeight]);

  const show = (focusRow: 'first' | 'last' | null = null) => {
    const triggerRect = trigger.current?.getBoundingClientRect();
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    hoverLock.current = null;
    setClosing(false);
    morphFrom.current = triggerRect
      ? { width: triggerRect.width, height: triggerRect.height }
      : null;
    if (triggerRect) {
      const viewport = currentViewport(trigger.current);
      const nextSheet = routeSheetBox(sheetAnchor(triggerRect, viewport), sheetHeight, viewport);
      setSheetBox(nextSheet);
      // Two-step width: pin the current numeric width first, then widen to
      // the sheet width on the next frame so the transition can run.
      setTriggerWidth(triggerRect.width);
      window.requestAnimationFrame(() => setTriggerWidth(nextSheet.width));
    }
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
    const triggerRect = trigger.current?.getBoundingClientRect();
    if (triggerRect) {
      const viewport = currentViewport(trigger.current);
      const nextSheet = routeSheetBox(sheetAnchor(triggerRect, viewport), sheetHeight, viewport);
      setSheetBox(nextSheet);
      setFlyoutBox(routeFlyoutBox(
        nextSheet,
        preferredFlyoutHeight(next, effortOptions.length),
        viewport,
        rowButtons.current[next]?.getBoundingClientRect().top,
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
    if (hoverSwitchTimer.current !== null) window.clearTimeout(hoverSwitchTimer.current);
  }, []);

  // Pretendard splits Hangul into lazy unicode-range subsets, so a first open
  // painted fallback glyphs and swapped mid-animation (user: 처음 열 때
  // 폰트가 튄다). Warming the exact sheet/flyout strings at mount lands the
  // real faces long before the picker ever opens.
  useEffect(() => {
    try {
      void document.fonts.load('400 13px "Pretendard Variable"', [
        t('Model'), t('Reasoning effort'), t('Context'), t('Speed'), t('Standard'), t('Fast'),
        t('Default speed'), t('Increased speed, increased usage'),
        t('Search models…'), t('Loading models…'), t('Select model'),
      ].join(''));
    } catch { /* font readiness stays cosmetic */ }
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
        if (hoverSwitchTimer.current !== null) {
          window.clearTimeout(hoverSwitchTimer.current);
          hoverSwitchTimer.current = null;
        }
        if (hoverLock.current === id) hoverLock.current = null;
      }}
      onClick={() => {
        if (hoverSwitchTimer.current !== null) {
          window.clearTimeout(hoverSwitchTimer.current);
          hoverSwitchTimer.current = null;
        }
        // Click always OPENS (hover already opened it — a toggle here would
        // close the flyout under the very click that targeted it). Escape /
        // ArrowLeft / outside-click remain the ways to close.
        if (pane !== id) openPane(id);
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
      style={triggerWidth !== null ? { width: triggerWidth } : undefined}
      data-morph={triggerWidth !== null ? '' : undefined}
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
        aria-label={t('Choose model')}
        style={{
          ...sheetBox,
          '--route-morph-sx': String(Math.min(1,
            Math.max(0.1, (morphFrom.current?.width || sheetBox.width) / sheetBox.width))),
          '--route-morph-sy': String(Math.min(1,
            Math.max(0.1, (morphFrom.current?.height || sheetBox.height) / sheetBox.height))),
        } as CSSProperties}
        data-placement={sheetBox.placement}
        data-state={closing ? 'closing' : 'open'}>
        {row('model', t('Model'), triggerModel)}
        {rows.includes('effort') && row('effort', t('Reasoning effort'), effortLabel || t('Reasoning effort'), tuningDisabled)}
        {rows.includes('context') && row('context', t('Context'),
          formatContextWindow(contextTokens).replace(/ Context$/, ''), tuningDisabled)}
        {modelParameterOptions.map((parameter) => row(
          `parameter:${parameter.id}`,
          parameter.label,
          parameter.options.find((option) => option.value === modelParameters[parameter.id])?.label
            || modelParameters[parameter.id]
            || parameter.options[0]?.label
            || '',
          tuningDisabled,
        ))}
        {rows.includes('speed') && row('speed', t('Speed'), speedLabel, tuningDisabled)}
      </div>,
      document.body,
    )}
    {mounted && modelCatalogReady && createPortal(
      <div ref={modelFlyout} className="route-sheet-flyout route-sheet-flyout--model"
        hidden={pane !== 'model'} data-placement={flyoutBox?.placement}
        data-state={closing ? 'closing' : 'open'}
        style={pane === 'model' && flyoutBox ? flyoutBox : { display: 'none' }}>
        <ModelCatalog models={models} provider={provider} model={model}
          active={pane === 'model'}
          catalogLoaded={catalogLoaded} catalogRefreshing={catalogRefreshing}
          catalogError={catalogError} providerSetupError={providerSetupError}
          onSelect={onSelectModel}
          onClose={() => closePane('model', true)}
          onOpenProviders={() => {
            closeAll();
            onOpenProviders?.();
          }} />
      </div>,
      document.body,
    )}
    {mounted && pane === 'effort' && flyoutBox && createPortal(
      <div ref={optionFlyout} className="route-sheet-flyout" role="menu" aria-label={t('Reasoning effort')}
        style={flyoutBox} data-placement={flyoutBox.placement} data-state={closing ? 'closing' : 'open'}>
        <div className="route-sheet-flyout-title" aria-hidden="true">{t('Reasoning effort')}</div>
        {effortOptions.map((option) => {
          const selected = option.value === effort;
          return <button type="button" key={option.value} className="route-sheet-option" role="menuitemradio"
            aria-checked={selected} disabled={tuningDisabled}
            onClick={() => {
              if (option.value !== effort) onChangeEffort(option.value);
            }}
            onKeyDown={(event) => {
              if (moveFocus(event, optionFlyout.current, '.route-sheet-option:not(:disabled)')) return;
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                closePane('effort', true);
              }
            }}>
            <span>{option.label}</span>
            {selected && <span className="route-selection-check">
              <Check size={14} aria-hidden="true" />
            </span>}
          </button>;
        })}
      </div>,
      document.body,
    )}
    {mounted && pane === 'speed' && flyoutBox && createPortal(
      <div ref={optionFlyout} className="route-sheet-flyout" role="menu" aria-label={t('Speed')} style={flyoutBox}
        data-placement={flyoutBox.placement} data-state={closing ? 'closing' : 'open'}>
        <div className="route-sheet-flyout-title" aria-hidden="true">{t('Speed')}</div>
        {([
          { value: false, label: t('Standard'), description: t('Default speed') },
          { value: true, label: t('Fast'), description: t('Increased speed, increased usage') },
        ] as const).map((option) => {
          const selected = option.value === fast;
          const disabled = tuningDisabled || (option.value && !fastAvailable);
          return <button type="button" key={option.label}
            className="route-sheet-option route-sheet-option--rich" role="menuitemradio"
            aria-checked={selected} disabled={disabled}
            onClick={() => {
              if (option.value !== fast) onChangeFast(option.value);
            }}
            onKeyDown={(event) => {
              if (moveFocus(event, optionFlyout.current, '.route-sheet-option:not(:disabled)')) return;
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                closePane('speed', true);
              }
            }}>
            <span className="route-sheet-option-copy">
              <span>{option.label}</span>
              <small>{option.description}</small>
            </span>
            {selected && <span className="route-selection-check">
              <Check size={14} aria-hidden="true" />
            </span>}
          </button>;
        })}
      </div>,
      document.body,
    )}
    {mounted && pane === 'context' && flyoutBox && createPortal(
      <div ref={optionFlyout} className="route-sheet-flyout" role="menu" aria-label={t('Context')}
        style={flyoutBox} data-placement={flyoutBox.placement} data-state={closing ? 'closing' : 'open'}>
        <div className="route-sheet-flyout-title" aria-hidden="true">{t('Context')}</div>
        <div className="route-context-head">
          <strong aria-hidden="true">{shownContextPercent}%</strong>
          <small aria-hidden="true">
            {formatContextWindow(shownContextTokens).replace(/ Context$/, '')}
            {shownContextPercent === contextDefaultPercent ? ` · ${t('Default')}` : ''}
          </small>
          {shownContextPercent !== contextDefaultPercent && <button type="button"
            className="route-context-reset" disabled={tuningDisabled}
            aria-label={t('Reset to default ({{percent}}%)', { percent: contextDefaultPercent })}
            onClick={() => { setContextDraft(null); onChangeContext(contextDefaultPercent); }}>
            {formatContextWindow(defaultContextTokens).replace(/ Context$/, '')} · {t('Default')}
          </button>}
        </div>
        <div className="route-context-slider">
          <input type="range" min={10} max={100} step={10}
            value={shownContextPercent} disabled={tuningDisabled}
            aria-label={t('Context')} aria-valuetext={`${shownContextPercent}%`}
            onChange={(event) => setContextDraft(Number(event.currentTarget.value))}
            onPointerUp={commitContextDraft}
            onKeyUp={commitContextDraft}
            onBlur={commitContextDraft} />
        </div>
      </div>,
      document.body,
    )}
    {mounted && pane?.startsWith('parameter:') && flyoutBox && createPortal(
      <div ref={optionFlyout} className="route-sheet-flyout" role="menu"
        aria-label={modelParameterOptions.find((entry) => `parameter:${entry.id}` === pane)?.label || ''}
        style={flyoutBox} data-placement={flyoutBox.placement} data-state={closing ? 'closing' : 'open'}>
        {modelParameterOptions.filter((entry) => `parameter:${entry.id}` === pane).map((parameter) => <Fragment key={parameter.id}>
          <div className="route-sheet-flyout-title" aria-hidden="true">{parameter.label}</div>
          {parameter.options.map((option) => {
            const selected = option.value === modelParameters[parameter.id];
            return <button type="button" key={option.value} className="route-sheet-option"
              role="menuitemradio" aria-checked={selected} disabled={tuningDisabled}
              onClick={() => {
                if (!selected) onChangeModelParameter?.(parameter.id, option.value);
              }}>
              <span>{option.label}</span>
              {selected && <span className="route-selection-check">
                <Check size={14} aria-hidden="true" />
              </span>}
            </button>;
          })}
        </Fragment>)}
      </div>,
      document.body,
    )}
  </div>;
}
