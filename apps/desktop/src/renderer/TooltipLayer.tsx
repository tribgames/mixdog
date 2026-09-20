import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface TooltipState {
  text: string;
  label: string;
  keys: string[];
  anchorLeft: number;
  anchorCenter: number;
  anchorRight: number;
  anchorTop: number;
  anchorBottom: number;
  preferredSide?: TooltipSide;
  sheetBounds?: { left: number; top: number; right: number; bottom: number };
}

function tooltipParts(text: string) {
  const [label, hint, ...rest] = text.split(/\s+·\s+/);
  if (
    !hint ||
    rest.length ||
    !/^(?:(?:Cmd|Ctrl|Alt|Option|Shift|Meta)\+)*(?:[A-Z0-9+=-]|Enter|Escape|Space|Tab|↑|↓|←|→)$/i.test(hint)
  ) {
    return { label: text, keys: [] };
  }
  return { label, keys: hint.split('+').filter(Boolean) };
}

type TooltipSide = 'top' | 'bottom' | 'left' | 'right';
const OPPOSITE_SIDE: Record<TooltipSide, TooltipSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

interface TooltipPosition {
  left: number;
  top: number;
  side: TooltipSide;
}

const VIEWPORT_PADDING = 8;
const TARGET_GAP = 6;
/* Hover hints are opt-in (`data-tooltip`). The only automatic fallback is an
   ICON-ONLY button or link, whose aria-label is the one name it has. The old
   fallback covered every labelled control — rows, cards, tabs, text links,
   inputs, textareas, selects — so ~500 screen-reader labels surfaced as
   bubbles that merely repeated the visible text (user: 모든 버튼에 다 붙어서
   개판). Those controls now stay silent unless a screen opts in. */
const ICON_CONTROLS = ['button[aria-label]', 'a[href][aria-label]', '[role="button"][aria-label]'].join(',');
/* Hover waits a beat longer than the OS default so a pointer merely passing
   over a control never summons a bubble; keyboard focus stays quick because
   it is a deliberate landing. */
const HOVER_DELAY_MS = 600;
const FOCUS_DELAY_MS = 150;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function tooltipTarget(value: EventTarget | null): HTMLElement | null {
  if (!(value instanceof Element)) return null;
  // Explicit copy wins, including an empty value used to suppress a tooltip.
  // Never duplicate native titles, and never turn section headings or
  // arbitrary content into hover targets.
  const explicit = value.closest<HTMLElement>('[data-tooltip]');
  const target = explicit || (value.closest('[title]') ? null : value.closest<HTMLElement>(ICON_CONTROLS));
  if (!target) return null;
  // A control that already shows text must not echo its accessible name.
  if (!explicit && (target.textContent ?? '').trim()) return null;
  return target.closest('[inert], [aria-hidden="true"]') ? null : target;
}

export function TooltipLayer() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const timer = useRef<number | null>(null);
  const active = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const node = content.current;
    if (!tooltip || !node) return;

    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const bounds = tooltip.sheetBounds || {
      left: 0,
      top: 0,
      right: viewportWidth,
      bottom: viewportHeight,
    };
    const tooltipBounds = node.getBoundingClientRect();
    const width = Math.min(tooltipBounds.width, Math.max(0, bounds.right - bounds.left - VIEWPORT_PADDING * 2));
    const height = Math.min(tooltipBounds.height, Math.max(0, bounds.bottom - bounds.top - VIEWPORT_PADDING * 2));
    const room: Record<TooltipSide, number> = {
      top: tooltip.anchorTop - bounds.top - TARGET_GAP - VIEWPORT_PADDING,
      bottom: bounds.bottom - tooltip.anchorBottom - TARGET_GAP - VIEWPORT_PADDING,
      left: tooltip.anchorLeft - bounds.left - TARGET_GAP - VIEWPORT_PADDING,
      right: bounds.right - tooltip.anchorRight - TARGET_GAP - VIEWPORT_PADDING,
    };
    let side: TooltipSide =
      tooltip.preferredSide || (room.bottom >= height || room.bottom >= room.top ? 'bottom' : 'top');
    const opposite = OPPOSITE_SIDE[side];
    const needed = side === 'left' || side === 'right' ? width : height;
    if (room[side] < needed && room[opposite] > room[side]) side = opposite;

    const horizontal = side === 'left' || side === 'right';
    let idealLeft = tooltip.anchorCenter - width / 2;
    if (side === 'right') idealLeft = tooltip.anchorRight + TARGET_GAP;
    else if (side === 'left') idealLeft = tooltip.anchorLeft - TARGET_GAP - width;
    const left = clamp(idealLeft, bounds.left + VIEWPORT_PADDING, bounds.right - VIEWPORT_PADDING - width);
    let idealTop = tooltip.anchorTop - TARGET_GAP - height;
    if (horizontal) idealTop = (tooltip.anchorTop + tooltip.anchorBottom - height) / 2;
    else if (side === 'bottom') idealTop = tooltip.anchorBottom + TARGET_GAP;
    const top = clamp(idealTop, bounds.top + VIEWPORT_PADDING, bounds.bottom - VIEWPORT_PADDING - height);
    setPosition({ left, top, side });
  }, [tooltip]);

  useEffect(() => {
    let watchdog: number | null = null;
    const stopWatchdog = () => {
      if (watchdog !== null) window.clearInterval(watchdog);
      watchdog = null;
    };
    const checkAnchor = () => {
      const anchor = active.current;
      if (!anchor) return;
      // Layout shifts (tab-close width pinning, dock resize, list reorder)
      // slide a still-connected anchor out from under a stationary pointer —
      // no pointerout ever fires. Reap when the anchor lost BOTH hover and
      // keyboard focus, not just when it unmounted.
      if (!anchor.isConnected || !(anchor.matches(':hover') || anchor.matches(':focus-visible'))) {
        cancel();
      }
    };
    const startWatchdog = () => {
      if (watchdog === null) watchdog = window.setInterval(checkAnchor, 500);
    };
    const cancel = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      stopWatchdog();
      active.current = null;
      setPosition(null);
      setTooltip(null);
    };
    const reveal = (target: HTMLElement, delay: number) => {
      if (active.current === target) return;
      if (timer.current !== null) window.clearTimeout(timer.current);
      active.current = target;
      timer.current = window.setTimeout(() => {
        if (!target.isConnected || active.current !== target) return;
        const text = (
          target.hasAttribute('data-tooltip') ? target.dataset.tooltip : target.getAttribute('aria-label')
        )?.trim();
        if (!text) return;
        const parts = tooltipParts(text);
        const rect = target.getBoundingClientRect();
        const sheet = target.closest<HTMLElement>('.workspace, .session-sidebar');
        const sheetRect = sheet?.getBoundingClientRect();
        const requested = target.dataset.tooltipSide;
        setPosition(null);
        setTooltip({
          text,
          ...parts,
          anchorLeft: rect.left,
          anchorCenter: rect.left + rect.width / 2,
          anchorRight: rect.right,
          anchorTop: rect.top,
          anchorBottom: rect.bottom,
          sheetBounds:
            sheetRect && sheetRect.width > 0 && sheetRect.height > 0
              ? {
                  left: sheetRect.left,
                  top: sheetRect.top,
                  right: sheetRect.right,
                  bottom: sheetRect.bottom,
                }
              : undefined,
          preferredSide:
            requested === 'top' || requested === 'bottom' || requested === 'left' || requested === 'right'
              ? requested
              : undefined,
        });
        startWatchdog();
      }, delay);
    };
    const onPointerOver = (event: PointerEvent) => {
      const target = tooltipTarget(event.target);
      if (target) reveal(target, HOVER_DELAY_MS);
    };
    const onPointerOut = (event: PointerEvent) => {
      const target = tooltipTarget(event.target);
      const related = event.relatedTarget;
      if (target && (!(related instanceof Node) || !target.contains(related))) cancel();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTarget(event.target);
      // Pointer clicks move focus and re-summoned the tooltip right after the
      // pointerdown dismissal, leaving it floating once the button moved or
      // re-rendered (user: lingering description bubbles). Only keyboard
      // focus reveals tooltips.
      if (target?.matches(':focus-visible')) reveal(target, FOCUS_DELAY_MS);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (tooltipTarget(event.target)) cancel();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const activationTarget = event.target instanceof Node ? event.target : null;
      if (
        event.key === 'Escape' ||
        ((event.key === 'Enter' || event.key === ' ') &&
          activationTarget !== null &&
          active.current?.contains(activationTarget))
      ) {
        cancel();
      }
    };
    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointerout', onPointerOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', cancel, true);
    // Activation dismisses outright, and a hovered target that re-renders or
    // unmounts (busy-state swaps) never fires pointerout — reap it.
    document.addEventListener('click', cancel, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', cancel, true);
    window.addEventListener('resize', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      cancel();
      document.removeEventListener('pointerover', onPointerOver);
      document.removeEventListener('pointerout', onPointerOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('click', cancel, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', cancel, true);
      window.removeEventListener('resize', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, []);

  if (!tooltip) return null;
  const maxWidth = tooltip.sheetBounds
    ? Math.min(280, Math.max(0, tooltip.sheetBounds.right - tooltip.sheetBounds.left - VIEWPORT_PADDING * 2))
    : undefined;
  return createPortal(
    <div
      ref={content}
      className="mx-tooltip"
      role="tooltip"
      data-side={position?.side || tooltip.preferredSide || 'bottom'}
      style={
        position
          ? { left: position.left, top: position.top, maxWidth }
          : { left: 0, top: 0, maxWidth, visibility: 'hidden' }
      }
      aria-label={tooltip.text}
    >
      <span className="mx-tooltip-label">{tooltip.label}</span>
      {tooltip.keys.length > 0 && (
        <span className="mx-keybind" data-component="keybind">
          {tooltip.keys.map((key) => (
            <kbd key={key}>{key}</kbd>
          ))}
        </span>
      )}
    </div>,
    document.body
  );
}
