import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface TooltipState {
  text: string;
  anchorLeft: number;
  anchorTop: number;
  anchorBottom: number;
  preferredSide?: TooltipSide;
}

type TooltipSide = 'top' | 'bottom';

interface TooltipPosition {
  left: number;
  top: number;
  side: TooltipSide;
}

const VIEWPORT_PADDING = 8;
const TARGET_GAP = 6;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function tooltipTarget(value: EventTarget | null): HTMLElement | null {
  return value instanceof HTMLElement ? value.closest<HTMLElement>('[data-tooltip]') : null;
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
    const bounds = node.getBoundingClientRect();
    const width = Math.min(bounds.width, Math.max(0, viewportWidth - VIEWPORT_PADDING * 2));
    const height = Math.min(bounds.height, Math.max(0, viewportHeight - VIEWPORT_PADDING * 2));
    const room = {
      top: tooltip.anchorTop - TARGET_GAP - VIEWPORT_PADDING,
      bottom: viewportHeight - tooltip.anchorBottom - TARGET_GAP - VIEWPORT_PADDING,
    };
    let side: TooltipSide = tooltip.preferredSide
      || (room.bottom >= height || room.bottom >= room.top ? 'bottom' : 'top');
    const opposite: TooltipSide = side === 'bottom' ? 'top' : 'bottom';
    if (room[side] < height && room[opposite] > room[side]) side = opposite;

    const left = clamp(
      tooltip.anchorLeft - width / 2,
      VIEWPORT_PADDING,
      viewportWidth - VIEWPORT_PADDING - width,
    );
    const idealTop = side === 'bottom'
      ? tooltip.anchorBottom + TARGET_GAP
      : tooltip.anchorTop - TARGET_GAP - height;
    const top = clamp(
      idealTop,
      VIEWPORT_PADDING,
      viewportHeight - VIEWPORT_PADDING - height,
    );
    setPosition({ left, top, side });
  }, [tooltip]);

  useEffect(() => {
    const cancel = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
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
        const text = target.dataset.tooltip?.trim();
        if (!text) return;
        const rect = target.getBoundingClientRect();
        const requested = target.dataset.tooltipSide;
        setPosition(null);
        setTooltip({
          text,
          anchorLeft: rect.left + rect.width / 2,
          anchorTop: rect.top,
          anchorBottom: rect.bottom,
          preferredSide: requested === 'top' || requested === 'bottom' ? requested : undefined,
        });
      }, delay);
    };
    const onPointerOver = (event: PointerEvent) => {
      const target = tooltipTarget(event.target);
      if (target) reveal(target, 420);
    };
    const onPointerOut = (event: PointerEvent) => {
      const target = tooltipTarget(event.target);
      const related = event.relatedTarget;
      if (target && (!(related instanceof Node) || !target.contains(related))) cancel();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTarget(event.target);
      if (target) reveal(target, 150);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (tooltipTarget(event.target)) cancel();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const activationTarget = event.target instanceof Node ? event.target : null;
      if (event.key === 'Escape'
        || ((event.key === 'Enter' || event.key === ' ')
          && activationTarget !== null
          && active.current?.contains(activationTarget))) {
        cancel();
      }
    };
    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointerout', onPointerOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', cancel, true);
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
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', cancel, true);
      window.removeEventListener('resize', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, []);

  if (!tooltip) return null;
  return createPortal(<div
    ref={content}
    className="oc-tooltip"
    role="tooltip"
    data-side={position?.side || tooltip.preferredSide || 'bottom'}
    style={position
      ? { left: position.left, top: position.top }
      : { left: 0, top: 0, visibility: 'hidden' }}
  >{tooltip.text}</div>, document.body);
}
