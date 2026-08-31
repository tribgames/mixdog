import { Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import {
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
import { useMobileBack } from './mobile-back';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { ModelCatalog } from './model-catalog';
import { formatContextWindow, ModelRouteLabel } from './provider-display';
import { useSurfaceActive } from './surface-activity';
import {
  ROUTE_PANEL_PADDING,
  ROUTE_PANEL_WIDTH,
  ROUTE_SHEET_ROW_HEIGHT,
  routeDrillBox,
  routeDrillHeight,
  routeFlyoutBox,
  routeFlyoutFitsBeside,
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
  onOpenModelPane,
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
  /** Opening the catalog is also the user's retry gesture: the owner may
   *  re-request a catalog whose previous fetch failed. */
  onOpenModelPane?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [pane, setPane] = useState<RouteSheetPane | null>(null);
  const [sheetBox, setSheetBox] = useState<RoutePanelBox | null>(null);
  const [flyoutBox, setFlyoutBox] = useState<RoutePanelBox | null>(null);
  // Narrow surface (phone): the pane takes over the sheet's footprint and the
  // sheet steps aside, instead of stacking a detached second panel.
  const [drill, setDrill] = useState(false);
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
  // The slider row IS the context control (TUI parity): a provider's own
  // context-window parameter (Cursor 272K/1M) must never duplicate it.
  const parameterRows = contextVisible
    ? modelParameterOptions.filter((parameter) => parameter.id !== 'context')
    : modelParameterOptions;
  const rows = routeSheetRows({
    hasModel: Boolean(provider && model),
    effortCount: effortOptions.length,
    contextVisible,
    fastVisible,
    parameterIds: parameterRows.map((parameter) => parameter.id),
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
    setDrill(false);
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
    setDrill(false);
    if (restoreFocus) {
      window.setTimeout(() => rowButtons.current[closedPane]?.focus({ preventScroll: true }), 0);
    }
  }, []);

  // One geometry for every opening: a second column beside the sheet where it
  // fits, and a drilled pane inside the sheet's own footprint where it does
  // not (phones), so the menu never breaks into two detached panels.
  const paneLayout = useCallback((
    nextSheet: RoutePanelBox,
    next: RouteSheetPane,
    viewport: { left: number; top: number; width: number; height: number },
  ): { box: RoutePanelBox; drilled: boolean } => {
    const width = preferredFlyoutWidth(next);
    const height = preferredFlyoutHeight(next, effortOptions.length);
    if (routeFlyoutFitsBeside(nextSheet, viewport, width)) {
      return {
        box: routeFlyoutBox(
          nextSheet,
          height,
          viewport,
          rowButtons.current[next]?.getBoundingClientRect().top,
          width,
          'right',
        ),
        drilled: false,
      };
    }
    return {
      box: routeDrillBox(nextSheet, routeDrillHeight(height, viewport), viewport),
      drilled: true,
    };
  }, [effortOptions.length]);

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
      setDrill(false);
      return;
    }
    const nextBox = paneLayout(nextSheet, pane, viewport);
    setFlyoutBox(nextBox.box);
    setDrill(nextBox.drilled);
  }, [pane, paneLayout, sheetHeight]);

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
    if (next === 'model') {
      setModelCatalogReady(true);
      onOpenModelPane?.();
    }
    const triggerRect = trigger.current?.getBoundingClientRect();
    if (triggerRect) {
      const viewport = currentViewport(trigger.current);
      const nextSheet = routeSheetBox(sheetAnchor(triggerRect, viewport), sheetHeight, viewport);
      setSheetBox(nextSheet);
      const nextBox = paneLayout(nextSheet, next, viewport);
      setFlyoutBox(nextBox.box);
      setDrill(nextBox.drilled);
    }
    setPane(next);
  };

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
    // A phone keyboard resizes and offsets the VISUAL viewport, which fires
    // no window resize on iOS: without these the panel kept its old box while
    // the composer moved and the two drifted apart (user: 타이핑창 올라오면서
    // 분리되어버린다).
    const visual = window.visualViewport;
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, true);
    visual?.addEventListener('resize', onViewport);
    visual?.addEventListener('scroll', onViewport);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('scroll', onViewport, true);
      visual?.removeEventListener('resize', onViewport);
      visual?.removeEventListener('scroll', onViewport);
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

  // A drilled pane replaced the sheet, so its first row walks back up one
  // level; a flyout that opened beside the sheet keeps the plain title.
  const paneHeader = (label: string, target: RouteSheetPane) => (drill
    ? <button type="button" className="route-sheet-back" aria-label={t('Back')}
      onClick={() => closePane(target, true)}>
      <ChevronLeft size={14} aria-hidden="true" />
      <span>{label}</span>
    </button>
    : <div className="route-sheet-flyout-title" aria-hidden="true">{label}</div>);

  // Whichever surface currently hosts the open pane: the sheet itself while
  // drilled, the flyout beside it otherwise.
  const paneContainer = () => (sheet.current?.querySelector('.route-sheet-pane')
    ? sheet.current
    : optionFlyout.current);

  const paneLabel = (target: RouteSheetPane): string => {
    if (target === 'model') return t('Model');
    if (target === 'effort') return t('Reasoning effort');
    if (target === 'context') return t('Context');
    if (target === 'speed') return t('Speed');
    return parameterRows.find((entry) => `parameter:${entry.id}` === target)?.label || '';
  };

  const paneBody = (target: RouteSheetPane) => {
    if (target === 'effort') {
      return effortOptions.map((option) => {
        const selected = option.value === effort;
        return <button type="button" key={option.value} className="route-sheet-option" role="menuitemradio"
          aria-checked={selected} disabled={tuningDisabled}
          onClick={() => {
            if (option.value !== effort) onChangeEffort(option.value);
          }}
          onKeyDown={(event) => {
            if (moveFocus(event, paneContainer(), '.route-sheet-option:not(:disabled)')) return;
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
      });
    }
    if (target === 'speed') {
      return ([
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
            if (moveFocus(event, paneContainer(), '.route-sheet-option:not(:disabled)')) return;
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
      });
    }
    if (target === 'context') {
      return <>
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
      </>;
    }
    const parameter = parameterRows.find((entry) => `parameter:${entry.id}` === target);
    if (!parameter) return null;
    return parameter.options.map((option) => {
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
    });
  };

  // Drilled: ONE panel — the sheet itself takes the pane's box and content,
  // so the menu stays a single window growing out of the pill instead of a
  // second card floating over it (user: 한 창이라는 느낌이 덜하다).
  const drilled = drill && Boolean(pane);
  const panelBox = drilled && flyoutBox ? flyoutBox : sheetBox;

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
        <ModelRouteLabel model={triggerModel} effort={effort} fast={fast} effortLabel={effortLabel} />
      </span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {mounted && panelBox && createPortal(
      <div ref={sheet} id={`route-sheet-${sheetId}`} className="route-sheet" role="menu"
        aria-label={drilled && pane ? paneLabel(pane) : t('Choose model')}
        style={{
          ...panelBox,
          '--route-morph-sx': String(Math.min(1,
            Math.max(0.1, (morphFrom.current?.width || panelBox.width) / panelBox.width))),
          '--route-morph-sy': String(Math.min(1,
            Math.max(0.1, (morphFrom.current?.height || panelBox.height) / panelBox.height))),
        } as CSSProperties}
        data-placement={panelBox.placement}
        data-drilled={drilled ? '' : undefined}
        data-state={closing ? 'closing' : 'open'}>
        {drilled && pane
          ? <div className="route-sheet-pane" key={`pane:${pane}`}>
            {paneHeader(paneLabel(pane), pane)}
            {pane === 'model'
              ? <ModelCatalog models={models} provider={provider} model={model} active
                catalogLoaded={catalogLoaded} catalogRefreshing={catalogRefreshing}
                catalogError={catalogError} providerSetupError={providerSetupError}
                onSelect={onSelectModel}
                onClose={() => closePane('model', true)}
                onOpenProviders={() => {
                  closeAll();
                  onOpenProviders?.();
                }} />
              : paneBody(pane)}
          </div>
          : <div className="route-sheet-rows" key="rows">
            {row('model', t('Model'), triggerModel)}
            {rows.includes('effort') && row('effort', t('Reasoning effort'), effortLabel || t('Reasoning effort'), tuningDisabled)}
            {rows.includes('context') && row('context', t('Context'),
              formatContextWindow(contextTokens).replace(/ Context$/, ''), tuningDisabled)}
            {parameterRows.map((parameter) => row(
              `parameter:${parameter.id}`,
              parameter.label,
              parameter.options.find((option) => option.value === modelParameters[parameter.id])?.label
                || modelParameters[parameter.id]
                || parameter.options[0]?.label
                || '',
              tuningDisabled,
            ))}
            {rows.includes('speed') && row('speed', t('Speed'), speedLabel, tuningDisabled)}
          </div>}
      </div>,
      document.body,
    )}
    {mounted && !drill && modelCatalogReady && createPortal(
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
    {mounted && !drill && pane && pane !== 'model' && flyoutBox && createPortal(
      <div ref={optionFlyout} className="route-sheet-flyout" role="menu" aria-label={paneLabel(pane)}
        style={flyoutBox} data-placement={flyoutBox.placement}
        data-state={closing ? 'closing' : 'open'}>
        {paneHeader(paneLabel(pane), pane)}
        {paneBody(pane)}
      </div>,
      document.body,
    )}
  </div>;
}
