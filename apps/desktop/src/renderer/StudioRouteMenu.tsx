import { ChevronDown } from 'lucide-react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';

import { t } from './i18n';
import { useMenuDismiss } from './menu-dismiss';
import { useMobileBack } from './mobile-back';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { routePanelStyle } from './route-editor-logic';
import type { StudioModelEntry, StudioOptionRow, StudioSliderRow } from './studio-route-menu-model';
import {
  StudioModelPane,
  StudioOptionPane,
  StudioPaneHeader,
  StudioSheetRow,
  StudioSliderPane,
  useStudioRowHoverSwitch,
} from './studio-route-menu-panes';
import { studioSheetStyle, useStudioRouteMenuPanels, useStudioViewportRelayout } from './use-studio-route-menu-panels';

export type { StudioModelEntry, StudioOptionRow, StudioSliderRow } from './studio-route-menu-model';

/** Pretendard splits Hangul into lazy unicode-range subsets: warm the exact
 *  menu strings at mount so a first open never paints fallback glyphs and
 *  swaps mid-animation (chat-composer parity). */
function useStudioMenuFontWarmup(
  rows: StudioOptionRow[],
  slider: StudioSliderRow | null,
  entries: StudioModelEntry[]
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate mount-only warm-up; later label changes must not re-run the font load
  useEffect(() => {
    try {
      void document.fonts.load(
        '400 13px "Pretendard Variable"',
        [
          t('Model'),
          ...rows.map((entry) => entry.label + entry.valueLabel),
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
  const {
    open,
    closing,
    mounted,
    pane,
    modelQuery,
    setModelQuery,
    sheetBox,
    flyoutBox,
    drill,
    triggerWidth,
    trigger,
    sheet,
    flyout,
    rowButtons,
    morphFrom,
    closeTimer,
    closeAll,
    layout,
    show,
    openPane,
    closePane,
  } = useStudioRouteMenuPanels({ field, rowCount: 1 + rows.length + (slider ? 1 : 0), rows });
  const hover = useStudioRowHoverSwitch();
  const clickGuard = useImmediateOverlayClickGuard();

  const current = entries.find((entry) => entry.lane === lane && entry.model === model);
  const modelLabel = triggerLabel ?? (current?.label || model || t('Select model'));

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

  useStudioViewportRelayout(mounted, layout);

  // biome-ignore lint/correctness/useExhaustiveDependencies: both timers are stable refs owned by the hooks above; unmount-only cleanup
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      if (hover.timer.current !== null) window.clearTimeout(hover.timer.current);
    },
    []
  );

  useStudioMenuFontWarmup(rows, slider, entries);

  const row = (id: string, label: string, value: string, rowDisabled = false) => (
    <StudioSheetRow
      key={id}
      id={id}
      label={label}
      value={value}
      disabled={rowDisabled}
      pane={pane}
      rowButtons={rowButtons}
      hover={hover}
      openPane={openPane}
    />
  );

  const activeRow = pane ? rows.find((entry) => entry.id === pane) : undefined;

  const paneHeader = (label: string, target: string) => (
    <StudioPaneHeader
      drill={drill}
      label={label}
      onBack={() => {
        closePane();
        window.setTimeout(() => rowButtons.current[target]?.focus({ preventScroll: true }), 0);
      }}
    />
  );

  const paneTitle = pane === 'model' ? t('Model') : activeRow?.label || slider?.label || '';

  const paneBody = () => (
    <>
      {pane === 'model' && (
        <StudioModelPane
          entries={entries}
          lane={lane}
          model={model}
          auto={auto}
          modelQuery={modelQuery}
          setModelQuery={setModelQuery}
          onSelect={onSelect}
          closeAll={closeAll}
        />
      )}
      {activeRow && <StudioOptionPane row={activeRow} />}
      {pane === 'slider' && slider && <StudioSliderPane slider={slider} />}
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
            style={studioSheetStyle(panelBox, morphFrom.current)}
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
