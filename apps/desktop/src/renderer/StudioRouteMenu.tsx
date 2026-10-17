import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { t } from './i18n';
import { useMenuDismiss } from './menu-dismiss';
import { useMobileBack } from './mobile-back';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { ProviderIcon } from './provider-display';
import { routePaneLayout, settledTop, useRouteFlyoutFit } from './route-editor-layout';
import {
  ROUTE_PANEL_PADDING,
  ROUTE_PANEL_WIDTH,
  ROUTE_SHEET_ROW_HEIGHT,
  routePanelStyle,
  routeSheetBox,
  type RoutePanelBox,
} from './route-editor-logic';
import { currentViewport, preferredFlyoutWidth, ROUTE_MODEL_FLYOUT_MAX_HEIGHT } from './route-editor-panes';

export interface StudioModelEntry {
  lane: string;
  laneLabel: string;
  authType?: string;
  model: string;
  label: string;
  description?: string;
  /** Muted note replacing the check: the row is listed but cannot be chosen. */
  unavailable?: string;
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

function authTypeLabel(authType: unknown): string {
  if (authType === 'oauth') return t('Account');
  return authType === 'api-key' ? t('API key') : '';
}

/** The Studio composer's pill sits at the bottom of its pane, so its sheet
 *  opens above with the left edges aligned (the pill grows rightwards into
 *  it); the settings `field` sits at the trailing edge of its row, so its
 *  sheet opens below with the right edges aligned. */
function measuredSheet(
  trigger: HTMLElement,
  rect: { left: number; right: number; top: number; bottom: number },
  sheetHeight: number,
  field: boolean
) {
  const viewport = currentViewport(trigger);
  return {
    viewport,
    sheet: field
      ? routeSheetBox(rect, sheetHeight, viewport, ROUTE_PANEL_WIDTH, 'below', 'end')
      : routeSheetBox(rect, sheetHeight, viewport, ROUTE_PANEL_WIDTH, 'above', 'start'),
  };
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
  variant = 'studio',
  triggerLabel,
  suffix = '',
  ariaLabel,
  auto,
  onSelect,
}: {
  entries: StudioModelEntry[];
  lane: string;
  model: string;
  disabled?: boolean;
  rows?: StudioOptionRow[];
  slider?: StudioSliderRow | null;
  /** `field` wears the agent editor's route trigger (`.model-trigger`) and
   *  keeps its natural width while the sheet is open. */
  variant?: 'studio' | 'field';
  /** Replaces the selected model's label on the trigger and the Model row. */
  triggerLabel?: string;
  /** Muted text after the label on the field trigger. */
  suffix?: string;
  ariaLabel?: string;
  /** A first, model-less choice at the top of the model list. */
  auto?: { label: string; selected: boolean; onSelect(): void };
  onSelect(entry: StudioModelEntry): void;
}) {
  const field = variant === 'field';
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
  const modelLabel = triggerLabel ?? (current?.label || model || t('Select model'));
  const rowCount = 1 + rows.length + (slider ? 1 : 0);
  const sheetHeight = rowCount * ROUTE_SHEET_ROW_HEIGHT + ROUTE_PANEL_PADDING * 2;

  // Height caps; a side flyout sizes to its content below them.
  const flyoutSize = useCallback((id: string): { maxHeight: number; width?: number } => {
    if (id === 'model') return { maxHeight: ROUTE_MODEL_FLYOUT_MAX_HEIGHT, width: preferredFlyoutWidth('model') };
    if (id === 'slider') return { maxHeight: 76 };
    const count = rowsRef.current.find((row) => row.id === id)?.options.length || 0;
    return { maxHeight: Math.min(300, Math.max(44, count * ROUTE_SHEET_ROW_HEIGHT + 34)) };
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
    setTriggerWidth(field ? null : (morphFrom.current?.width ?? null));
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      finishClose();
    }, CLOSE_DURATION);
  }, [field, finishClose]);

  // The route editor's pane geometry (route-editor-layout.ts).
  const paneLayout = useCallback(
    (
      nextSheet: RoutePanelBox,
      id: string,
      viewport: { left: number; top: number; width: number; height: number }
    ): { box: RoutePanelBox; drilled: boolean } => {
      const row = rowButtons.current[id];
      return routePaneLayout(nextSheet, viewport, flyoutSize(id), row ? settledTop(row) : undefined);
    },
    [flyoutSize]
  );
  useRouteFlyoutFit(flyout, flyoutBox, setFlyoutBox, () => (pane ? rowButtons.current[pane] : null));

  const layout = useCallback(() => {
    const node = trigger.current;
    const rect = node?.getBoundingClientRect();
    if (!node || !rect) return;
    const { viewport, sheet: nextSheet } = measuredSheet(node, rect, sheetHeight, field);
    setSheetBox(nextSheet);
    if (!pane) {
      setFlyoutBox(null);
      setDrill(false);
      return;
    }
    const nextBox = paneLayout(nextSheet, pane, viewport);
    setFlyoutBox(nextBox.box);
    setDrill(nextBox.drilled);
  }, [field, pane, paneLayout, sheetHeight]);

  const show = () => {
    const node = trigger.current;
    const rect = node?.getBoundingClientRect();
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setClosing(false);
    morphFrom.current = rect ? { width: rect.width, height: rect.height } : null;
    if (node && rect) {
      const { sheet: nextSheet } = measuredSheet(node, rect, sheetHeight, field);
      setSheetBox(nextSheet);
      // Two-step width: pin the numeric width first, widen on the next frame.
      if (!field) {
        setTriggerWidth(rect.width);
        window.requestAnimationFrame(() => setTriggerWidth(nextSheet.width));
      }
    }
    setPane(null);
    setModelQuery('');
    setOpen(true);
  };

  const openPane = (id: string) => {
    const node = trigger.current;
    const rect = node?.getBoundingClientRect();
    if (node && rect) {
      const { viewport, sheet: nextSheet } = measuredSheet(node, rect, sheetHeight, field);
      setSheetBox(nextSheet);
      const nextBox = paneLayout(nextSheet, id, viewport);
      setFlyoutBox(nextBox.box);
      setDrill(nextBox.drilled);
    }
    setPane(id);
  };

  const mounted = open || closing;

  const closePane = useCallback(() => {
    setPane(null);
    setFlyoutBox(null);
    setDrill(false);
  }, []);

  const toggle = () =>
    commitImmediateOverlay(() => {
      if (open) closeAll();
      else show();
    });

  // ABB: back closes the drilled pane first, then the sheet — same order the
  // Escape handler below walks.
  useMobileBack(open, () => closeAll());
  useMobileBack(Boolean(pane), closePane);

  // Outside click, Escape and Tab: the shared popup contract (menu-dismiss.ts).
  // Escape steps out of an open pane first, then closes the sheet.
  useMenuDismiss({
    open: mounted,
    close: closeAll,
    trigger,
    panels: () => [sheet.current, flyout.current],
    onEscape: (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!pane) return false;
      closePane();
      return true;
    },
  });

  useEffect(() => {
    if (!mounted) return undefined;
    layout();
    const onViewport = () => layout();
    // A phone keyboard resizes and offsets the VISUAL viewport, which fires
    // no window resize on iOS: without these the panel kept its old box while
    // the composer moved and the two drifted apart.
    const visual = window.visualViewport;
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, true);
    visual?.addEventListener('resize', onViewport);
    visual?.addEventListener('scroll', onViewport);
    return () => {
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('scroll', onViewport, true);
      visual?.removeEventListener('resize', onViewport);
      visual?.removeEventListener('scroll', onViewport);
    };
  }, [layout, mounted]);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      if (hoverSwitchTimer.current !== null) window.clearTimeout(hoverSwitchTimer.current);
    },
    []
  );

  // Pretendard splits Hangul into lazy unicode-range subsets: warm the exact
  // menu strings at mount so a first open never paints fallback glyphs and
  // swaps mid-animation (chat-composer parity).
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate mount-only warm-up; later label changes must not re-run the font load
  useEffect(() => {
    try {
      void document.fonts.load(
        '400 13px "Pretendard Variable"',
        [
          t('Model'),
          ...rowsRef.current.map((entry) => entry.label + entry.valueLabel),
          slider?.label || '',
          ...entries.map((entry) => entry.laneLabel + entry.label),
        ].join('')
      );
    } catch {
      /* font readiness stays cosmetic */
    }
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
      disabled={rowDisabled}
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
      }}
    >
      <span className="route-sheet-label">{label}</span>
      <span className="route-sheet-value">{value}</span>
      <ChevronRight size={14} aria-hidden="true" />
    </button>
  );

  const lanes: Array<{ id: string; label: string; authType?: string; items: StudioModelEntry[] }> = [];
  for (const entry of entries) {
    const bucket = lanes.find((group) => group.id === entry.lane);
    if (bucket) bucket.items.push(entry);
    else lanes.push({ id: entry.lane, label: entry.laneLabel, authType: entry.authType, items: [entry] });
  }
  const normalizedModelQuery = modelQuery.trim().toLocaleLowerCase();
  const autoVisible = Boolean(
    auto && (!normalizedModelQuery || auto.label.toLocaleLowerCase().includes(normalizedModelQuery))
  );
  const visibleLanes = lanes
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (entry) =>
          !normalizedModelQuery ||
          `${entry.label} ${entry.model} ${entry.laneLabel}`.toLocaleLowerCase().includes(normalizedModelQuery)
      ),
    }))
    .filter((group) => group.items.length > 0);
  const activeRow = pane ? rows.find((entry) => entry.id === pane) : undefined;

  // A drilled pane replaced the sheet, so its first row walks back up one
  // level; a flyout that opened beside the sheet keeps the plain title.
  const paneHeader = (label: string, target: string) =>
    drill ? (
      <button
        type="button"
        className="route-sheet-back"
        aria-label={t('Back')}
        onClick={() => {
          closePane();
          window.setTimeout(() => rowButtons.current[target]?.focus({ preventScroll: true }), 0);
        }}
      >
        <ChevronLeft size={14} aria-hidden="true" />
        <span>{label}</span>
      </button>
    ) : (
      <div className="route-sheet-flyout-title">{label}</div>
    );

  const paneTitle = pane === 'model' ? t('Model') : activeRow?.label || slider?.label || '';

  const paneBody = () => (
    <>
      {pane === 'model' && (
        <div className="model-catalog-list">
          <div className="model-search-wrapper">
            <div className="model-search">
              <div className="model-search-container">
                <Search size={16} aria-hidden="true" />
                <input
                  ref={modelSearch}
                  type="text"
                  value={modelQuery}
                  placeholder={t('Search models…')}
                  aria-label={t('Search models')}
                  autoComplete="off"
                  spellCheck={false}
                  onInput={(event) => setModelQuery(event.currentTarget.value)}
                />
              </div>
              {modelQuery && (
                <button
                  type="button"
                  data-component="icon-button"
                  onClick={() => {
                    setModelQuery('');
                    modelSearch.current?.focus();
                  }}
                  aria-label={t('Clear picker search')}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
          <div className="model-list">
            {auto && autoVisible && (
              <button
                type="button"
                className="model-option-row"
                role="menuitemradio"
                aria-checked={auto.selected}
                onClick={() => {
                  auto.onSelect();
                  closeAll();
                }}
              >
                <span className="model-row-copy">
                  <span className="model-row-title">
                    <strong>{auto.label}</strong>
                  </span>
                </span>
                {auto.selected && (
                  <span className="route-selection-check">
                    <Check size={14} aria-hidden="true" />
                  </span>
                )}
              </button>
            )}
            {visibleLanes.map((group) => (
              <section className="model-group model-group--provider" key={group.id}>
                <h3>
                  <span className="model-provider-heading">
                    <ProviderIcon provider={group.id} />
                    <span>{group.label}</span>
                    <small>{authTypeLabel(group.authType)}</small>
                  </span>
                </h3>
                <div className="model-items">
                  {group.items.map((entry) => {
                    const active = !entry.unavailable && entry.lane === lane && entry.model === model;
                    return (
                      <button
                        type="button"
                        key={`${entry.lane}/${entry.model}`}
                        className="model-option-row"
                        role="menuitemradio"
                        aria-checked={active}
                        disabled={Boolean(entry.unavailable)}
                        data-unavailable={entry.unavailable ? '' : undefined}
                        data-tooltip={entry.unavailable ? undefined : t('Select model')}
                        onClick={() => {
                          onSelect(entry);
                          closeAll();
                        }}
                      >
                        <span className="model-row-copy">
                          <span className="model-row-title">
                            <strong>{entry.label}</strong>
                          </span>
                          {entry.model && <small className="studio-model-id">{entry.model}</small>}
                          {entry.description && <small className="studio-model-description">{entry.description}</small>}
                        </span>
                        {entry.unavailable && <small className="model-row-unavailable">{entry.unavailable}</small>}
                        {active && (
                          <span className="route-selection-check">
                            <Check size={14} aria-hidden="true" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
            {visibleLanes.length === 0 && !autoVisible && <p className="model-empty">{t('No matching models.')}</p>}
          </div>
        </div>
      )}
      {activeRow?.options.map((option) => {
        const selected = option.value === activeRow.value;
        return (
          <button
            type="button"
            key={option.value}
            className="route-sheet-option"
            role="menuitemradio"
            aria-checked={selected}
            disabled={activeRow.disabled}
            onClick={() => {
              if (!selected) activeRow.onPick(option.value);
            }}
          >
            <span>{option.label}</span>
            {selected && (
              <span className="route-selection-check">
                <Check size={14} aria-hidden="true" />
              </span>
            )}
          </button>
        );
      })}
      {pane === 'slider' && slider && (
        <label className="route-sheet-slider">
          <input
            type="range"
            min={slider.min}
            max={slider.max}
            value={slider.value}
            disabled={slider.disabled}
            aria-label={t('Duration seconds')}
            onChange={(event) => {
              // Read the value BEFORE any state updater runs (chat-composer
              // slider crash note: currentTarget clears by then).
              const next = Number(event.currentTarget.value);
              slider.onChange(next);
            }}
          />
          <span>{slider.value}s</span>
        </label>
      )}
    </>
  );

  // Drilled: ONE panel — the sheet itself takes the pane's box and content,
  // so the menu stays a single window growing out of the pill instead of a
  // second card floating over it.
  const drilled = drill && Boolean(pane);
  const panelBox = drilled && flyoutBox ? flyoutBox : sheetBox;

  const menu = (
    <div className={field ? 'route-editor studio-model-menu' : 'studio-model-menu'}>
      <button
        ref={trigger}
        type="button"
        className={field ? 'model-trigger' : 'studio-model-trigger'}
        disabled={disabled}
        style={triggerWidth !== null ? { width: triggerWidth } : undefined}
        data-morph={triggerWidth !== null ? '' : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel || t('Generation model')}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          clickGuard.markPointerActivation();
          toggle();
        }}
        onClick={(event) => {
          if (clickGuard.consumePointerClick()) return;
          if (event.detail !== 0) return;
          toggle();
        }}
        onPointerCancel={clickGuard.clearPointerActivation}
      >
        {field ? (
          <span className="route-trigger-copy">
            <span className="model-route-label">{modelLabel}</span>
            {suffix && <span className="model-route-label model-route-label-effort">{suffix}</span>}
          </span>
        ) : (
          <span>{modelLabel}</span>
        )}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {mounted &&
        panelBox &&
        createPortal(
          <div
            ref={sheet}
            className="route-sheet"
            role="menu"
            aria-label={drilled ? paneTitle : t('Generation options')}
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
            {drilled && pane ? (
              <div className="route-sheet-pane" key={`pane:${pane}`}>
                {paneHeader(paneTitle, pane)}
                {paneBody()}
              </div>
            ) : (
              <div className="route-sheet-rows" key="rows">
                {row('model', t('Model'), modelLabel)}
                {rows.map((entry) => row(entry.id, entry.label, entry.valueLabel, entry.disabled))}
                {slider && row('slider', slider.label, `${slider.value}s`, slider.disabled)}
              </div>
            )}
          </div>,
          document.body
        )}
      {mounted &&
        !drill &&
        pane &&
        flyoutBox &&
        createPortal(
          <div
            ref={flyout}
            className={`route-sheet-flyout${pane === 'model' ? ' route-sheet-flyout--model model-catalog-panel' : ''}`}
            role="menu"
            aria-label={paneTitle}
            style={routePanelStyle(flyoutBox)}
            data-placement={flyoutBox.placement}
            data-state={closing ? 'closing' : 'open'}
          >
            {pane !== 'model' && paneHeader(paneTitle, pane)}
            {paneBody()}
          </div>,
          document.body
        )}
    </div>
  );
  return field ? <div className="workflows-dialog-route">{menu}</div> : menu;
}
