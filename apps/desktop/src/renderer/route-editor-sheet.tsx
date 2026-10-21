import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import type { CSSProperties, MutableRefObject, ReactNode, RefObject } from 'react';
import type { DesktopModelOption } from '../shared/contract';
import { t } from './i18n';
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import type { RouteSpeed } from './model-route-utils';
import { DAYBREAK_PARAMETER_ID, formatContextWindow, ModelRouteLabel } from './provider-display';
import { RouteDaybreakToggle } from './route-editor-auto-effort';
import type { RoutePanelBox, RouteSheetPane } from './route-editor-logic';
import {
  modelParameterLabel,
  moveRouteFocus,
  RouteContextTuneIcon,
  type RouteSessionChoice,
  routeSpeedClassName,
} from './route-editor-panes';

// Safe hover: while a flyout is open, passing over the other rows on the way
// to it must NOT switch panes — a switch needs a short dwell.
const HOVER_SWITCH_DWELL = 140;

/** One row of the route sheet; hovering or clicking opens its pane. */
export function RouteRow({
  id,
  label,
  value,
  disabled,
  pane,
  dropdown,
  hoverLock,
  hoverSwitchTimer,
  rowButtons,
  sheet,
  openPane,
  focusPane,
}: {
  id: RouteSheetPane;
  label: string;
  value: ReactNode;
  disabled: boolean;
  pane: RouteSheetPane | null;
  dropdown: boolean;
  hoverLock: MutableRefObject<RouteSheetPane | null>;
  hoverSwitchTimer: MutableRefObject<number | null>;
  rowButtons: MutableRefObject<Partial<Record<RouteSheetPane, HTMLButtonElement | null>>>;
  sheet: RefObject<HTMLDivElement | null>;
  openPane(pane: RouteSheetPane): void;
  focusPane(pane: RouteSheetPane): void;
}) {
  const cancelHoverSwitch = () => {
    if (hoverSwitchTimer.current === null) return;
    window.clearTimeout(hoverSwitchTimer.current);
    hoverSwitchTimer.current = null;
  };
  return (
    <button
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
        // A dropdown's pane replaces the rows: only a click may do that.
        if (dropdown || event.pointerType === 'touch' || hoverLock.current === id) return;
        if (pane === id) return;
        if (pane) {
          // Another pane is open: only a dwell switches, so the pointer can
          // travel across intermediate rows into the open flyout.
          if (hoverSwitchTimer.current !== null) window.clearTimeout(hoverSwitchTimer.current);
          hoverSwitchTimer.current = window.setTimeout(() => {
            hoverSwitchTimer.current = null;
            openPane(id);
          }, HOVER_SWITCH_DWELL);
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
}

/** The pill that opens the sheet; arrows open it focused on the first/last row. */
export function RouteTrigger({
  triggerRef,
  disabled,
  width,
  tooltip,
  visible,
  sheetId,
  triggerModel,
  effort,
  fast,
  ultra,
  blue,
  effortLabel,
  onShow,
  onToggle,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  disabled: boolean;
  width: number | null;
  tooltip: string;
  visible: boolean;
  sheetId: string;
  triggerModel: string;
  effort: string;
  fast: boolean;
  ultra: boolean;
  blue: boolean;
  effortLabel: string;
  onShow(focusRow: 'first' | 'last'): void;
  onToggle(): void;
}) {
  const clickGuard = useImmediateOverlayClickGuard();
  return (
    <button
      ref={triggerRef}
      type="button"
      className="model-trigger"
      disabled={disabled}
      style={width !== null ? { width } : undefined}
      data-morph={width !== null ? '' : undefined}
      aria-label={tooltip}
      aria-haspopup="menu"
      aria-expanded={visible}
      aria-controls={visible ? `route-sheet-${sheetId}` : undefined}
      data-tooltip={tooltip}
      data-tooltip-side="top"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        onShow(event.key === 'ArrowDown' ? 'first' : 'last');
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        clickGuard.markPointerActivation();
        commitImmediateOverlay(onToggle);
      }}
      onClick={(event) => {
        if (clickGuard.consumePointerClick()) return;
        if (event.detail !== 0) return;
        commitImmediateOverlay(onToggle);
      }}
      onPointerCancel={clickGuard.clearPointerActivation}
    >
      <span className="route-trigger-copy">
        <ModelRouteLabel
          model={triggerModel}
          effort={effort}
          fast={fast}
          ultra={ultra}
          blue={blue}
          effortLabel={effortLabel}
        />
      </span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
  );
}

/** A pane's title. A drilled pane replaced the sheet, so its first row walks
 *  back up one level; a flyout that opened beside the sheet keeps the plain
 *  title. The context pane adds its size-edit toggle beside it. */
export function RoutePaneHeader({
  label,
  drill,
  tune,
  onBack,
}: {
  label: string;
  drill: boolean;
  /** Present only for the context pane when its size can be edited. */
  tune?: { editing: boolean; disabled: boolean; onToggle(): void };
  onBack(): void;
}) {
  const title = drill ? (
    <button type="button" className="route-sheet-back" aria-label={t('Back')} onClick={onBack}>
      <ChevronLeft size={14} aria-hidden="true" />
      <span>{label}</span>
    </button>
  ) : (
    <div className="route-sheet-flyout-title" aria-hidden="true">
      {label}
    </div>
  );
  if (!tune) return title;
  return (
    <div className="route-context-titlebar">
      {title}
      <button
        type="button"
        className="route-context-tune"
        aria-label={t('Edit context size')}
        aria-pressed={tune.editing}
        disabled={tune.disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={tune.onToggle}
      >
        <RouteContextTuneIcon />
      </button>
    </div>
  );
}
/** The sheet's scale-out transform, derived from the pill it grows from. */
export function routeMorphStyle(
  panelBox: RoutePanelBox,
  from: { width: number; height: number } | null
): CSSProperties {
  const scale = (pill: number | undefined, panel: number) =>
    String(Math.min(1, Math.max(0.1, (pill || panel) / panel)));
  return {
    ...panelBox,
    '--route-morph-sx': scale(from?.width, panelBox.width),
    '--route-morph-sy': scale(from?.height, panelBox.height),
  } as CSSProperties;
}

/** The sheet's rows: the model's own settings, then the conversation's
 *  workflow and delegation choices below a separator. */
export function RouteSheetRows({
  row,
  rows,
  triggerModel,
  effortLabel,
  contextTokens,
  parameterRows,
  modelParameters,
  speed,
  speedLabel,
  daybreakRow,
  daybreakOn,
  tuningDisabled,
  sessionChoices,
  onChangeModelParameter,
}: {
  row(id: RouteSheetPane, label: string, value: ReactNode, disabled?: boolean): ReactNode;
  rows: RouteSheetPane[];
  triggerModel: string;
  effortLabel: string;
  contextTokens: number;
  parameterRows: NonNullable<DesktopModelOption['modelParameterOptions']>;
  modelParameters: Record<string, string>;
  speed: RouteSpeed;
  speedLabel: string;
  daybreakRow: boolean;
  daybreakOn: boolean;
  tuningDisabled: boolean;
  sessionChoices: RouteSessionChoice[];
  onChangeModelParameter?(id: string, value: string): void;
}) {
  return (
    <div className="route-sheet-rows" key="rows">
      {row('model', t('Model'), triggerModel)}
      {rows.includes('effort') &&
        row('effort', t('Reasoning effort'), effortLabel || t('Reasoning effort'), tuningDisabled)}
      {rows.includes('context') &&
        row('context', t('Context'), formatContextWindow(contextTokens).replace(/ Context$/, ''), tuningDisabled)}
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
      {rows.includes('speed') &&
        row('speed', t('Speed'), <span className={routeSpeedClassName(speed)}>{speedLabel}</span>, tuningDisabled)}
      {daybreakRow && (
        <RouteDaybreakToggle
          enabled={daybreakOn}
          disabled={tuningDisabled || !onChangeModelParameter}
          onChange={(enabled) => onChangeModelParameter?.(DAYBREAK_PARAMETER_ID, enabled ? 'on' : 'off')}
        />
      )}
      {sessionChoices.length > 0 && <hr className="route-sheet-separator" />}
      {sessionChoices.map((choice) =>
        row(
          `session:${choice.id}`,
          choice.label,
          choice.pending ? `${choice.valueLabel} · ${t('From the next response')}` : choice.valueLabel,
          choice.disabled
        )
      )}
    </div>
  );
}
