// Floating zoom control at the bottom centre of a surface: [−] [NN% ▾] [+].
// The percent button opens a small menu of presets (and, in the editor
// previews, "Fit width"). The value is always the live, resolved scale.
//
// Shared by the browser panes and the editor previews; the browser keeps its
// own name (BrowserZoomPill) for the default 50%–200% range and stays always
// visible, while the previews drive `visible`. The stylesheet ships with the
// component so every surface renders it alike.
import { Check, ChevronDown, Minus, Plus } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { BROWSER_ZOOM_PRESETS, BROWSER_ZOOM_RANGE, stepZoom, type ZoomRange } from './zoom-range';
import { t } from './i18n';
import './zoom-pill.css';

export interface ZoomPillLead {
  label: string;
  checked: boolean;
  onSelect(): void;
}

const SAME_SCALE = 0.005;

export function ZoomPill({
  level,
  onChange,
  range = BROWSER_ZOOM_RANGE,
  presets = BROWSER_ZOOM_PRESETS,
  step = (current, direction) => stepZoom(current, direction, range),
  lead,
  visible = true,
  onActiveChange,
}: {
  /** The resolved scale (1 = 100%). */
  level: number;
  onChange(level: number): void;
  range?: ZoomRange;
  presets?: readonly number[];
  /** Next scale for − / +. */
  step?(level: number, direction: 1 | -1): number;
  /** First menu entry, e.g. "Fit width"; defaults to "Zoom to 100%". */
  lead?: ZoomPillLead;
  visible?: boolean;
  /** True while the pill is hovered, focused or has its menu open. */
  onActiveChange?(active: boolean): void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const percentRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const percent = Math.round(level * 100);
  const head: ZoomPillLead = lead ?? {
    label: t('Zoom to {{value0}}%', { value0: 100 }),
    checked: Math.abs(level - 1) < SAME_SCALE,
    onSelect: () => onChange(1),
  };

  useEffect(() => {
    onActiveChange?.(open || hovered || focused);
  }, [open, hovered, focused, onActiveChange]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [open]);

  const choose = (apply: () => void, event: { detail: number }) => {
    setOpen(false);
    apply();
    // Keyboard users keep their place; a mouse pick leaves nothing focused.
    if (event.detail === 0) percentRef.current?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      percentRef.current?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    if (!open && event.target === percentRef.current) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    items[(at + delta + items.length) % items.length]?.focus();
  };

  // Buttons never take focus from a press, so the pill does not stay "focused"
  // (and therefore revealed) after a mouse click.
  const keepFocus = (event: { preventDefault(): void }) => event.preventDefault();

  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings its own border, padding and min-width into the floating pill.
    <div
      ref={rootRef}
      className={visible ? 'browser-zoom-pill' : 'browser-zoom-pill is-hidden'}
      role="group"
      aria-label={t('Zoom')}
      // Pointer events on the pill must never reach the surface below: the
      // phone pane turns every press into a page gesture.
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="browser-zoom-step"
        disabled={level <= range.min}
        onMouseDown={keepFocus}
        onClick={() => onChange(step(level, -1))}
        aria-label={t('Zoom out')}
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <div className="browser-zoom-percent-wrap">
        <button
          ref={percentRef}
          type="button"
          className="browser-zoom-percent"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${t('Zoom options')}: ${percent}%`}
          onMouseDown={keepFocus}
          onClick={() => setOpen((current) => !current)}
        >
          <span>{percent}%</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        {open && (
          <div className="browser-zoom-menu" role="menu" aria-label={t('Zoom options')}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={head.checked}
              className="browser-zoom-menu-item"
              onMouseDown={keepFocus}
              onClick={(event) => choose(head.onSelect, event)}
            >
              <span className="browser-zoom-menu-check" aria-hidden="true">
                {head.checked && <Check size={12} />}
              </span>
              {head.label}
            </button>
            {presets.map((preset) => {
              const checked = !head.checked && Math.abs(level - preset) < SAME_SCALE;
              return (
                <button
                  key={preset}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  className="browser-zoom-menu-item"
                  onMouseDown={keepFocus}
                  onClick={(event) => choose(() => onChange(preset), event)}
                >
                  <span className="browser-zoom-menu-check" aria-hidden="true">
                    {checked && <Check size={12} />}
                  </span>
                  {Math.round(preset * 100)}%
                </button>
              );
            })}
          </div>
        )}
      </div>
      <button
        type="button"
        className="browser-zoom-step"
        disabled={level >= range.max}
        onMouseDown={keepFocus}
        onClick={() => onChange(step(level, 1))}
        aria-label={t('Zoom in')}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
