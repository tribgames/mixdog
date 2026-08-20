import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { ProviderIcon } from './provider-display';
import {
  ROUTE_PANEL_PADDING,
  ROUTE_PANEL_WIDTH,
  ROUTE_SHEET_ROW_HEIGHT,
  routeDrillBox,
  routeDrillHeight,
  routeFlyoutBox,
  routeFlyoutFitsBeside,
  routeSheetBox,
  type RoutePanelBox,
} from './route-editor-logic';

export interface StudioModelEntry {
  lane: string;
  laneLabel: string;
  model: string;
  label: string;
}

/** One lane option (aspect, resolution, …) surfaced as a sheet row. */
export interface StudioOptionRow {
  id: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  valueLabel: string;
  disabled?: boolean;
  onPick(value: string): void;
}

/** Continuous duration lanes keep their slider, hosted inside a pane. */
export interface StudioSliderRow {
  label: string;
  min: number;
  max: number;
  value: number;
  disabled?: boolean;
  onChange(value: number): void;
}

const CLOSE_DURATION = 110;

function viewportBox() {
  const visual = window.visualViewport;
  return {
    left: visual?.offsetLeft ?? 0,
    top: visual?.offsetTop ?? 0,
    width: visual?.width ?? window.innerWidth,
    height: visual?.height ?? window.innerHeight,
  };
}

/** Left-anchored Studio sheet: the main menu grows rightwards from the model
 *  control while its detail flyouts prefer the sheet's right side. */
function sheetAnchor(
  rect: { left: number; top: number; bottom: number },
  viewport: { width: number },
) {
  // 16 = panel edge * 2 (routeSheetBox clamps the width the same way).
  const width = Math.min(ROUTE_PANEL_WIDTH, Math.max(1, viewport.width - 16));
  return { left: rect.left, right: rect.left + width, top: rect.top, bottom: rect.bottom };
}

/**
 * Generation menu: one pill that expands
 * to the sheet width; the model and every lane option live as sheet rows
 * whose value panes open beside the sheet.
 */
export function StudioRouteMenu({
  entries,
  lane,
  model,
  disabled = false,
  rows = [],
  slider = null,
  onSelect,
}: {
  entries: StudioModelEntry[];
  lane: string;
  model: string;
  disabled?: boolean;
  rows?: StudioOptionRow[];
  slider?: StudioSliderRow | null;
  onSelect(entry: StudioModelEntry): void;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [pane, setPane] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState('');
  const [sheetBox, setSheetBox] = useState<RoutePanelBox | null>(null);
  const [flyoutBox, setFlyoutBox] = useState<RoutePanelBox | null>(null);
  // Narrow surface (phone): the pane takes over the sheet's footprint and the
  // sheet steps aside, instead of stacking a detached second panel.
  const [drill, setDrill] = useState(false);
  // While open, the trigger expands to the sheet width.
  const [triggerWidth, setTriggerWidth] = useState<number | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const flyout = useRef<HTMLDivElement>(null);
  const modelSearch = useRef<HTMLInputElement>(null);
  const rowButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const morphFrom = useRef<{ width: number; height: number } | null>(null);
  const closeTimer = useRef<number | null>(null);
  const hoverSwitchTimer = useRef<number | null>(null);
  const clickGuard = useImmediateOverlayClickGuard();

  const current = entries.find((entry) => entry.lane === lane && entry.model === model);
  const rowCount = 1 + rows.length + (slider ? 1 : 0);
  const sheetHeight = rowCount * ROUTE_SHEET_ROW_HEIGHT + ROUTE_PANEL_PADDING * 2;

  const flyoutSize = useCallback((id: string): { height: number; width?: number } => {
    if (id === 'model') return { height: 380, width: 280 };
    if (id === 'slider') return { height: 76 };
    const count = rowsRef.current.find((row) => row.id === id)?.options.length || 0;
    return { height: Math.min(300, Math.max(44, count * ROUTE_SHEET_ROW_HEIGHT + 34)) };
  }, []);

  const finishClose = useCallback(() => {
    setClosing(false);
    setPane(null);
    setSheetBox(null);
    setFlyoutBox(null);
    setDrill(false);
    setTriggerWidth(null);
  }, []);

  const closeAll = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setOpen(false);
    setClosing(true);
    // The pill shrinks back to its captured natural width during the close
    // animation; finishClose releases it to auto.
    setTriggerWidth(morphFrom.current?.width ?? null);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      finishClose();
    }, CLOSE_DURATION);
  }, [finishClose]);

  // One geometry for every opening: a second column beside the sheet where it
  // fits, and a drilled pane inside the sheet's own footprint where it does
  // not (phones), so the menu never breaks into two detached panels.
  const paneLayout = useCallback((
    nextSheet: RoutePanelBox,
    id: string,
    viewport: { left: number; top: number; width: number; height: number },
  ): { box: RoutePanelBox; drilled: boolean } => {
    const size = flyoutSize(id);
    if (routeFlyoutFitsBeside(nextSheet, viewport, size.width)) {
      return {
        box: routeFlyoutBox(
          nextSheet,
          size.height,
          viewport,
          rowButtons.current[id]?.getBoundingClientRect().top,
          size.width,
          'right',
        ),
        drilled: false,
      };
    }
    return {
      box: routeDrillBox(nextSheet, routeDrillHeight(size.height, viewport), viewport),
      drilled: true,
    };
  }, [flyoutSize]);

  const layout = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const viewport = viewportBox();
    const nextSheet = routeSheetBox(sheetAnchor(rect, viewport), sheetHeight, viewport);
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

  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setClosing(false);
    morphFrom.current = rect ? { width: rect.width, height: rect.height } : null;
    if (rect) {
      const viewport = viewportBox();
      const nextSheet = routeSheetBox(sheetAnchor(rect, viewport), sheetHeight, viewport);
      setSheetBox(nextSheet);
      // Two-step width: pin the numeric width first, widen on the next frame.
      setTriggerWidth(rect.width);
      window.requestAnimationFrame(() => setTriggerWidth(nextSheet.width));
    }
    setPane(null);
    setModelQuery('');
    setOpen(true);
  };

  const openPane = (id: string) => {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) {
      const viewport = viewportBox();
      const nextSheet = routeSheetBox(sheetAnchor(rect, viewport), sheetHeight, viewport);
      setSheetBox(nextSheet);
      const nextBox = paneLayout(nextSheet, id, viewport);
      setFlyoutBox(nextBox.box);
      setDrill(nextBox.drilled);
    }
    setPane(id);
  };

  const mounted = open || closing;

  // ABB: back closes the drilled pane first, then the sheet — same order the
  // Escape handler below walks.
  useMobileBack(open, () => closeAll());
  useMobileBack(Boolean(pane), () => {
    setPane(null);
    setFlyoutBox(null);
    setDrill(false);
  });

  useEffect(() => {
    if (!mounted) return undefined;
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
      if (pane) {
        setPane(null);
        setFlyoutBox(null);
        setDrill(false);
      } else {
        closeAll();
      }
    };
    const onViewport = () => layout();
    // A phone keyboard resizes and offsets the VISUAL viewport, which fires
    // no window resize on iOS: without these the panel kept its old box while
    // the composer moved and the two drifted apart.
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
  }, [closeAll, layout, mounted, pane]);

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    if (hoverSwitchTimer.current !== null) window.clearTimeout(hoverSwitchTimer.current);
  }, []);

  // Pretendard splits Hangul into lazy unicode-range subsets: warm the exact
  // menu strings at mount so a first open never paints fallback glyphs and
  // swaps mid-animation (chat-composer parity).
  useEffect(() => {
    try {
      void document.fonts.load('400 13px "Pretendard Variable"', [
        t('Model'),
        ...rowsRef.current.map((entry) => entry.label + entry.valueLabel),
        slider?.label || '',
        ...entries.map((entry) => entry.laneLabel + entry.label),
      ].join(''));
    } catch { /* font readiness stays cosmetic */ }
    // Warm once per mount; the label vocabulary is stable per lane set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearHoverSwitch = () => {
    if (hoverSwitchTimer.current !== null) {
      window.clearTimeout(hoverSwitchTimer.current);
      hoverSwitchTimer.current = null;
    }
  };

  const row = (id: string, label: string, value: string, rowDisabled = false) => (
    <button key={id} ref={(node) => { rowButtons.current[id] = node; }} type="button"
      className="route-sheet-row" role="menuitem"
      aria-haspopup="menu" aria-expanded={pane === id} disabled={rowDisabled}
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch' || pane === id || rowDisabled) return;
        if (pane) {
          // Safe hover: only a dwell switches, so the pointer can travel
          // across intermediate rows into the open flyout.
          clearHoverSwitch();
          hoverSwitchTimer.current = window.setTimeout(() => {
            hoverSwitchTimer.current = null;
            openPane(id);
          }, 140);
          return;
        }
        openPane(id);
      }}
      onPointerLeave={clearHoverSwitch}
      onClick={() => {
        clearHoverSwitch();
        // Click always OPENS (hover already opened it — a toggle would close
        // the flyout under the very click that targeted it).
        if (pane !== id) openPane(id);
      }}>
      <span className="route-sheet-label">{label}</span>
      <span className="route-sheet-value">{value}</span>
      <ChevronRight size={14} aria-hidden="true" />
    </button>
  );

  const lanes: Array<{ id: string; label: string; items: StudioModelEntry[] }> = [];
  for (const entry of entries) {
    const bucket = lanes.find((group) => group.id === entry.lane);
    if (bucket) bucket.items.push(entry);
    else lanes.push({ id: entry.lane, label: entry.laneLabel, items: [entry] });
  }
  const normalizedModelQuery = modelQuery.trim().toLocaleLowerCase();
  const visibleLanes = lanes.map((group) => ({
    ...group,
    items: group.items.filter((entry) => !normalizedModelQuery
      || `${entry.label} ${entry.model} ${entry.laneLabel}`.toLocaleLowerCase().includes(normalizedModelQuery)),
  })).filter((group) => group.items.length > 0);
  const activeRow = pane ? rows.find((entry) => entry.id === pane) : undefined;

  // A drilled pane replaced the sheet, so its first row walks back up one
  // level; a flyout that opened beside the sheet keeps the plain title.
  const paneHeader = (label: string, target: string) => (drill
    ? <button type="button" className="route-sheet-back" aria-label={t('Back')}
      onClick={() => {
        setPane(null);
        setFlyoutBox(null);
        setDrill(false);
        window.setTimeout(() => rowButtons.current[target]?.focus({ preventScroll: true }), 0);
      }}>
      <ChevronLeft size={14} aria-hidden="true" />
      <span>{label}</span>
    </button>
    : <div className="route-sheet-flyout-title">{label}</div>);

  const paneTitle = pane === 'model' ? t('Model') : activeRow?.label || slider?.label || '';

  const paneBody = () => <>
    {pane === 'model' && <div className="model-catalog-list">
      <div className="model-search-wrapper">
        <div className="model-search">
          <div className="model-search-container">
            <Search size={16} aria-hidden="true" />
            <input ref={modelSearch} type="text" value={modelQuery}
              placeholder={t('Search models…')} aria-label={t('Search models')}
              autoComplete="off" spellCheck={false}
              onInput={(event) => setModelQuery(event.currentTarget.value)} />
          </div>
          {modelQuery && <button type="button" data-component="icon-button"
            onClick={() => {
              setModelQuery('');
              modelSearch.current?.focus();
            }} aria-label={t('Clear picker search')}>
            <X size={14} />
          </button>}
        </div>
      </div>
      <div className="model-list">
        {visibleLanes.map((group) => <section className="model-group model-group--provider" key={group.id}>
          <h3><span className="model-provider-heading">
            <ProviderIcon provider={group.id} />
            <span>{group.label}</span>
          </span></h3>
          <div className="model-items">
            {group.items.map((entry) => {
              const active = entry.lane === lane && entry.model === model;
              return <button type="button" key={`${entry.lane}/${entry.model}`}
                className="model-option-row" role="menuitemradio" aria-checked={active}
                onClick={() => {
                  onSelect(entry);
                  closeAll();
                }}>
                <span className="model-row-copy">
                  <span className="model-row-title"><strong>{entry.label}</strong></span>
                </span>
                {active && <span className="route-selection-check">
                  <Check size={14} aria-hidden="true" />
                </span>}
              </button>;
            })}
          </div>
        </section>)}
        {visibleLanes.length === 0 && <p className="model-empty">{t('No matching models.')}</p>}
      </div>
    </div>}
    {activeRow && activeRow.options.map((option) => {
      const selected = option.value === activeRow.value;
      return <button type="button" key={option.value} className="route-sheet-option"
        role="menuitemradio" aria-checked={selected} disabled={activeRow.disabled}
        onClick={() => {
          if (!selected) activeRow.onPick(option.value);
        }}>
        <span>{option.label}</span>
        {selected && <span className="route-selection-check">
          <Check size={14} aria-hidden="true" />
        </span>}
      </button>;
    })}
    {pane === 'slider' && slider && <label className="route-sheet-slider">
      <input type="range" min={slider.min} max={slider.max} value={slider.value}
        disabled={slider.disabled} aria-label={t('Duration seconds')}
        onChange={(event) => {
          // Read the value BEFORE any state updater runs (chat-composer
          // slider crash note: currentTarget clears by then).
          const next = Number(event.currentTarget.value);
          slider.onChange(next);
        }} />
      <span>{slider.value}s</span>
    </label>}
  </>;

  // Drilled: ONE panel — the sheet itself takes the pane's box and content,
  // so the menu stays a single window growing out of the pill instead of a
  // second card floating over it.
  const drilled = drill && Boolean(pane);
  const panelBox = drilled && flyoutBox ? flyoutBox : sheetBox;

  return <div className="studio-model-menu">
    <button ref={trigger} type="button" className="studio-model-trigger" disabled={disabled}
      style={triggerWidth !== null ? { width: triggerWidth } : undefined}
      data-morph={triggerWidth !== null ? '' : undefined}
      aria-haspopup="menu" aria-expanded={open} aria-label="Generation model"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        clickGuard.markPointerActivation();
        commitImmediateOverlay(() => {
          if (open) closeAll();
          else show();
        });
      }}
      onClick={(event) => {
        if (clickGuard.consumePointerClick()) return;
        if (event.detail !== 0) return;
        commitImmediateOverlay(() => {
          if (open) closeAll();
          else show();
        });
      }}
      onPointerCancel={clickGuard.clearPointerActivation}>
      <span>{current?.label || model || t('Select model')}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {mounted && panelBox && createPortal(
      <div ref={sheet} className="route-sheet" role="menu"
        aria-label={drilled ? paneTitle : t('Generation options')}
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
            {paneHeader(paneTitle, pane)}
            {paneBody()}
          </div>
          : <div className="route-sheet-rows" key="rows">
            {row('model', t('Model'), current?.label || model || t('Select model'))}
            {rows.map((entry) => row(entry.id, entry.label, entry.valueLabel, entry.disabled))}
            {slider && row('slider', slider.label, `${slider.value}s`, slider.disabled)}
          </div>}
      </div>,
      document.body,
    )}
    {mounted && !drill && pane && flyoutBox && createPortal(
      <div ref={flyout}
        className={`route-sheet-flyout${pane === 'model'
          ? ' route-sheet-flyout--model model-catalog-panel' : ''}`}
        role="menu" aria-label={paneTitle}
        style={flyoutBox} data-placement={flyoutBox.placement}
        data-state={closing ? 'closing' : 'open'}>
        {pane !== 'model' && paneHeader(paneTitle, pane)}
        {paneBody()}
      </div>,
      document.body,
    )}
  </div>;
}