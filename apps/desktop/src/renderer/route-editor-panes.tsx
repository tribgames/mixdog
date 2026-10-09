import { Check } from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { DesktopModelOption } from '../shared/contract';
import { t, tExisting } from './i18n';
import { wrappedNavigationIndex } from './list-navigation';
import type { RouteSpeed } from './model-route-utils';
import { formatContextWindow } from './provider-display';
import { ROUTE_SHEET_ROW_HEIGHT, routeSheetWidth, type RouteSheetPane } from './route-editor-logic';

// Leave one paint of headroom beyond the 110ms CSS exit so the surface and
// trigger reach their final frame before their fixed widths are released.
export const ROUTE_CLOSE_DURATION = 140;

export function naturalTriggerWidth(button: HTMLButtonElement): number {
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

// Cursor names its boolean reasoning switch "Thinking" — the same word the
// activity spinner uses, so the DOM localizer would print the spinner's
// "in progress" phrasing on a settings row. The row owns its own key and
// keeps the provider's label wherever no translation exists.
export function modelParameterLabel(parameter: { id: string; label: string }): string {
  return /^thinking$/i.test(parameter.id) || /^thinking$/i.test(parameter.label)
    ? tExisting('Thinking (model parameter)', parameter.label)
    : parameter.label;
}

export function currentViewport(anchor?: HTMLElement | null) {
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
export function sheetAnchor(
  rect: { left: number; top: number; bottom: number },
  viewport: { width: number },
  preferredWidth: number
) {
  const width = routeSheetWidth(viewport, preferredWidth);
  return { left: rect.left, right: rect.left + width, top: rect.top, bottom: rect.bottom };
}

export function preferredFlyoutHeight(pane: RouteSheetPane, effortCount: number): number {
  if (pane === 'model') return 380;
  if (pane === 'effort') return Math.min(300, Math.max(44, effortCount * ROUTE_SHEET_ROW_HEIGHT + 34));
  if (pane === 'context') return 100;
  return 132;
}

/** The model catalog needs more room than the menu column; the option panes
 *  match the sheet width. */
export function preferredFlyoutWidth(pane: RouteSheetPane): number | undefined {
  return pane === 'model' ? 280 : undefined;
}

type RouteModelParameter = NonNullable<DesktopModelOption['modelParameterOptions']>[number];

/** Trailing check mark of the selected option in every radio pane. */
function RouteSelectionCheck() {
  return (
    <span className="route-selection-check">
      <Check size={14} aria-hidden="true" />
    </span>
  );
}

/** Roving focus inside a menu surface; the caller names the container and the
 *  row selector, so sheet rows and pane options share one grammar. */
export function moveRouteFocus(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  container: HTMLElement | null,
  selector: string
): boolean {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;
  const buttons = Array.from(container?.querySelectorAll<HTMLButtonElement>(selector) || []);
  if (!buttons.length) return false;
  event.preventDefault();
  event.stopPropagation();
  const current = buttons.indexOf(event.currentTarget);
  const next = wrappedNavigationIndex(event.key, current, buttons.length, event.key === 'ArrowDown' ? 1 : -1);
  buttons[next]?.focus({ preventScroll: true });
  return true;
}

// ── Pane bodies ──────────────────────────────────────────────────────────
// What a route pane SHOWS, given the current route. Where that pane sits,
// when it opens and which surface hosts it stays with the component.

/** The Auto effort switch below the effort row; null hides it (feature not
 *  installed or the model cannot change effort per turn). */
export type RouteAutoEffort = { enabled: boolean; pending: boolean } | null;

export function routeEffortPane({
  effort,
  effortOptions,
  tuningDisabled,
  onChangeEffort,
  onOptionKeyDown,
}: {
  effort: string;
  effortOptions: Array<{ value: string; label: string }>;
  tuningDisabled: boolean;
  onChangeEffort(value: string): void;
  onOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void;
}): ReactNode {
  return effortOptions.map((option) => {
    const selected = option.value === effort;
    return (
      <button
        type="button"
        key={option.value}
        className="route-sheet-option"
        role="menuitemradio"
        aria-checked={selected}
        disabled={tuningDisabled}
        onClick={() => {
          if (option.value !== effort) onChangeEffort(option.value);
        }}
        onKeyDown={onOptionKeyDown}
      >
        <span>{option.label}</span>
        {selected && <RouteSelectionCheck />}
      </button>
    );
  });
}

export function routeSpeedPane({
  speed,
  fastAvailable,
  ultrafastAvailable,
  tuningDisabled,
  onChangeSpeed,
  onOptionKeyDown,
}: {
  speed: RouteSpeed;
  fastAvailable: boolean;
  ultrafastAvailable: boolean;
  tuningDisabled: boolean;
  onChangeSpeed(speed: RouteSpeed): void;
  onOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void;
}): ReactNode {
  const options: Array<{ value: RouteSpeed; label: string; description: string }> = [
    { value: 'standard', label: t('Standard'), description: t('Default speed') },
    { value: 'fast', label: t('Fast'), description: t('Increased speed, increased usage') },
  ];
  if (ultrafastAvailable) {
    options.push({ value: 'ultrafast', label: t('Ultrafast'), description: t('Fastest speed, highest usage') });
  }
  return options.map((option) => {
    const selected = option.value === speed;
    const disabled = tuningDisabled || (option.value !== 'standard' && !fastAvailable);
    return (
      <button
        type="button"
        key={option.label}
        className="route-sheet-option route-sheet-option--rich"
        role="menuitemradio"
        aria-checked={selected}
        disabled={disabled}
        onClick={() => {
          if (option.value !== speed) onChangeSpeed(option.value);
        }}
        onKeyDown={onOptionKeyDown}
      >
        <span className="route-sheet-option-copy">
          <span>{option.label}</span>
          <small>{option.description}</small>
        </span>
        {selected && <RouteSelectionCheck />}
      </button>
    );
  });
}

export function routeContextPane({
  contextDefaultPercent,
  defaultContextTokens,
  shownContextPercent,
  shownContextTokens,
  tuningDisabled,
  onCommitDraft,
  onDraftChange,
  onResetDefault,
}: {
  contextDefaultPercent: number;
  defaultContextTokens: number;
  shownContextPercent: number;
  shownContextTokens: number;
  tuningDisabled: boolean;
  onCommitDraft(): void;
  onDraftChange(percent: number): void;
  onResetDefault(): void;
}): ReactNode {
  return (
    <>
      <div className="route-context-head">
        <strong aria-hidden="true">{shownContextPercent}%</strong>
        <small aria-hidden="true">
          {formatContextWindow(shownContextTokens).replace(/ Context$/, '')}
          {shownContextPercent === contextDefaultPercent ? ` · ${t('Default')}` : ''}
        </small>
        {shownContextPercent !== contextDefaultPercent && (
          <button
            type="button"
            className="route-context-reset"
            disabled={tuningDisabled}
            aria-label={t('Reset to default ({{percent}}%)', { percent: contextDefaultPercent })}
            onClick={onResetDefault}
          >
            {formatContextWindow(defaultContextTokens).replace(/ Context$/, '')} · {t('Default')}
          </button>
        )}
      </div>
      <div className="route-context-slider">
        <input
          type="range"
          min={10}
          max={100}
          step={10}
          value={shownContextPercent}
          disabled={tuningDisabled}
          aria-label={t('Context')}
          aria-valuetext={`${shownContextPercent}%`}
          onChange={(event) => onDraftChange(Number(event.currentTarget.value))}
          onPointerUp={onCommitDraft}
          onKeyUp={onCommitDraft}
          onBlur={onCommitDraft}
        />
      </div>
    </>
  );
}

export function routeParameterPane({
  parameter,
  value,
  tuningDisabled,
  onChangeModelParameter,
  onOptionKeyDown,
}: {
  parameter: RouteModelParameter;
  value: string | undefined;
  tuningDisabled: boolean;
  onChangeModelParameter?(id: string, value: string): void;
  onOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void;
}): ReactNode {
  return parameter.options.map((option) => {
    const selected = option.value === value;
    return (
      <button
        type="button"
        key={option.value}
        className="route-sheet-option"
        role="menuitemradio"
        aria-checked={selected}
        disabled={tuningDisabled}
        onClick={() => {
          if (!selected) onChangeModelParameter?.(parameter.id, option.value);
        }}
        onKeyDown={onOptionKeyDown}
      >
        <span>{option.label}</span>
        {selected && <RouteSelectionCheck />}
      </button>
    );
  });
}
