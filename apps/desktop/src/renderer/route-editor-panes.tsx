import { Check } from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { clampContextTokens, parseContextTokensInput } from './route-editor-context';
import type { DesktopModelOption } from '../shared/contract';
import { t, tExisting } from './i18n';
import { wrappedNavigationIndex } from './list-navigation';
import type { RouteSpeed } from './model-route-utils';
import { formatContextWindow } from './provider-display';
import { paneBounds } from './anchored-panel';
import { ROUTE_SHEET_ROW_HEIGHT, type RouteSheetPane } from './route-editor-logic';

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

/** The area a route sheet may use: the trigger's pane clipped to the visible
 *  viewport (anchored-panel.ts paneBounds), the visible viewport in dialogs. */
export function currentViewport(anchor?: HTMLElement | null) {
  const bounds = paneBounds(anchor);
  return {
    left: bounds.left,
    top: bounds.top,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
  };
}

/** The model catalog's cap: a long list scrolls inside it, a short one makes
 *  a short flyout. */
export const ROUTE_MODEL_FLYOUT_MAX_HEIGHT = 360;

/** Height cap of a pane's flyout; the flyout itself sizes to its content. */
export function preferredFlyoutHeight(pane: RouteSheetPane, effortCount: number): number {
  if (pane === 'model') return ROUTE_MODEL_FLYOUT_MAX_HEIGHT;
  if (pane === 'effort') return Math.min(340, Math.max(44, effortCount * ROUTE_SHEET_ROW_HEIGHT + 34));
  if (pane === 'context') return 100;
  if (pane.startsWith('session:')) return 340;
  return 132;
}

/** A conversation setting the route menu carries below its model rows (the
 *  session's workflow and delegation mode): one row, one radio pane. */
export interface RouteSessionChoice {
  id: string;
  label: string;
  /** The selected option's value, and the name the row shows for it. */
  value: string;
  valueLabel: string;
  options: Array<{ value: string; label: string; description?: string }>;
  /** Chosen during a turn: shown now, applied from the next response. */
  pending?: boolean;
  disabled?: boolean;
  onSelect(value: string): void;
}

export function routeSessionChoicePane({
  choice,
  onOptionKeyDown,
}: {
  choice: RouteSessionChoice;
  onOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void;
}): ReactNode {
  return choice.options.map((option) => {
    const selected = option.value === choice.value;
    return (
      <button
        type="button"
        key={option.value}
        className={`route-sheet-option${option.description ? ' route-sheet-option--rich' : ''}`}
        role="menuitemradio"
        aria-checked={selected}
        disabled={choice.disabled}
        onClick={() => {
          if (!selected) choice.onSelect(option.value);
        }}
        onKeyDown={onOptionKeyDown}
      >
        <span className="route-sheet-option-copy">
          <span>{option.label}</span>
          {option.description && <small>{option.description}</small>}
        </span>
        {selected && <RouteSelectionCheck />}
      </button>
    );
  });
}

/** The model catalog needs more room than the menu column; the option panes
 *  match the sheet width. */
export function preferredFlyoutWidth(pane: RouteSheetPane): number | undefined {
  return pane === 'model' ? 280 : undefined;
}

type RouteModelParameter = NonNullable<DesktopModelOption['modelParameterOptions']>[number];

/** Trailing check mark of the selected option in every radio pane. */
export function RouteSelectionCheck() {
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
  autoEffort = null,
  autoEffortOn = false,
  tuningDisabled,
  onChangeEffort,
  onChangeAutoEffort,
  onOptionKeyDown,
}: {
  effort: string;
  effortOptions: Array<{ value: string; label: string }>;
  /** Present only for a model that supports Auto: adds "Auto" as the first item. */
  autoEffort?: RouteAutoEffort;
  /** Auto is the displayed effort (on and the model supports it). */
  autoEffortOn?: boolean;
  tuningDisabled: boolean;
  onChangeEffort(value: string): void;
  onChangeAutoEffort?(enabled: boolean): void;
  onOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void;
}): ReactNode {
  return (
    <>
      {autoEffort && (
        <button
          type="button"
          key="auto"
          className="route-sheet-option"
          role="menuitemradio"
          data-effort-option="auto"
          aria-checked={autoEffortOn}
          disabled={tuningDisabled || autoEffort.pending}
          onClick={() => {
            if (!autoEffort.enabled) onChangeAutoEffort?.(true);
          }}
          onKeyDown={onOptionKeyDown}
        >
          <span>Auto</span>
          {autoEffortOn && <RouteSelectionCheck />}
        </button>
      )}
      {effortOptions.map((option) => {
        const selected = option.value === effort && !autoEffortOn;
        return (
          <button
            type="button"
            key={option.value}
            className="route-sheet-option"
            role="menuitemradio"
            aria-checked={selected}
            disabled={tuningDisabled}
            onClick={() => {
              if (option.value !== effort || autoEffort?.enabled) onChangeEffort(option.value);
            }}
            onKeyDown={onOptionKeyDown}
          >
            <span>{option.label}</span>
            {selected && <RouteSelectionCheck />}
          </button>
        );
      })}
    </>
  );
}

/** The speed word's ink, shared with the model chip: Fast blue, Ultrafast orange. */
export function routeSpeedClassName(speed: RouteSpeed): string | undefined {
  if (speed === 'fast') return 'model-route-label-fast';
  if (speed === 'ultrafast') return 'model-route-label-ultra';
  return undefined;
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
          <span className={routeSpeedClassName(option.value)}>{option.label}</span>
          <small>{option.description}</small>
        </span>
        {selected && <RouteSelectionCheck />}
      </button>
    );
  });
}

export function RouteContextTuneIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" />
      <circle cx="10.5" cy="4.5" r="1.5" />
      <circle cx="5.5" cy="11.5" r="1.5" />
    </svg>
  );
}

export function routeContextPane(props: RouteContextPaneProps): ReactNode {
  return <RouteContextPane {...props} />;
}

type RouteContextPaneProps = {
  contextDefaultPercent: number;
  defaultContextTokens: number;
  contextMaxTokens: number;
  shownContextPercent: number;
  shownContextTokens: number;
  contextCustom: boolean;
  editing: boolean;
  commitEditRef: { current: (() => void) | null };
  tuningDisabled: boolean;
  onEditEnd(): void;
  onApplyTokens(tokens: number): void;
  onCommitDraft(): void;
  onDraftChange(percent: number): void;
  onResetDefault(): void;
};

function RouteContextPane({
  contextDefaultPercent,
  defaultContextTokens,
  contextMaxTokens,
  shownContextPercent,
  shownContextTokens,
  contextCustom,
  editing,
  commitEditRef,
  tuningDisabled,
  onEditEnd,
  onApplyTokens,
  onCommitDraft,
  onDraftChange,
  onResetDefault,
}: RouteContextPaneProps) {
  const fieldRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const finished = useRef(true);
  const prefill = useRef('');
  const endEdit = (apply: boolean) => {
    if (finished.current) return;
    finished.current = true;
    // An untouched field leaves the window exactly as it was.
    const tokens = apply && text !== prefill.current ? parseContextTokensInput(text) : null;
    if (tokens !== null && contextMaxTokens > 0) onApplyTokens(clampContextTokens(tokens, contextMaxTokens));
    onEditEnd();
  };
  commitEditRef.current = editing ? () => endEdit(true) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: shownContextTokens is read only to prefill once per edit session; re-running would overwrite typing.
  useEffect(() => {
    if (!editing) return;
    finished.current = false;
    prefill.current = String(shownContextTokens / 1000);
    setText(prefill.current);
    fieldRef.current?.focus();
    fieldRef.current?.select();
    // Prefill once per edit session.
  }, [editing]);
  const atDefault = shownContextPercent === contextDefaultPercent && !contextCustom;
  const tokensLabel = formatContextWindow(shownContextTokens).replace(/ Context$/, '');
  return (
    <>
      <div className="route-context-head">
        <strong aria-hidden="true">{shownContextPercent}%</strong>
        <small>
          {editing ? (
            <label className="route-context-num">
              <input
                ref={fieldRef}
                inputMode="decimal"
                value={text}
                aria-label={t('Context size')}
                onChange={(event) => setText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') endEdit(true);
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    endEdit(false);
                  }
                }}
                onBlur={() => endEdit(true)}
              />
              <em>{/m$/i.test(text.trim()) ? '' : 'k'}</em>
            </label>
          ) : (
            <span aria-hidden="true" className={contextCustom ? 'route-context-tokens is-custom' : undefined}>
              {tokensLabel}
            </span>
          )}
          <span aria-hidden="true">{atDefault ? ` · ${t('Default')}` : ''}</span>
        </small>
        {!atDefault && (
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
          step={contextCustom ? 0.1 : 10}
          value={shownContextPercent}
          disabled={tuningDisabled}
          aria-label={t('Context')}
          aria-valuetext={`${shownContextPercent}%`}
          onChange={(event) => onDraftChange(Math.round(Number(event.currentTarget.value) / 10) * 10)}
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
