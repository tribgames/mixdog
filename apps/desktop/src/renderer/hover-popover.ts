import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEvent, RefObject } from "react";

import { useMobileBack } from "./mobile-back";
import { touchPrimaryPointer } from "./surface-input-focus";

/** A detail card hangs a few px off the control that owns it, so a pointer on
 *  its way there leaves the control BEFORE it arrives. Closing on that first
 *  frame killed the card mid-trip (user: 위로 마우스 올라가기 전에 계속 창이
 *  닫혀버리네) — the transparent hover bridge only covers the trip that runs
 *  straight through the gap, and anything painted over the bridge, a diagonal
 *  path, or a card that flips sides all leave it. The close waits out this
 *  grace window instead, and a pointer that is back inside the slot when it
 *  expires keeps the card open. Geometry no longer decides. */
export const HOVER_POPOVER_CLOSE_DELAY_MS = 220;

export type HoverPopover = {
  /** True while the card should paint. */
  open: boolean;
  /** True once a click pinned the card open; hover alone never pins. */
  pinned: boolean;
  /** The slot element: control plus card. Hover, dismissal and focus all read
   *  containment from here, so the card MUST render inside it. */
  host: RefObject<HTMLDivElement | null>;
  hostProps: {
    ref: RefObject<HTMLDivElement | null>;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
  };
  triggerProps: {
    onClick: () => void;
    onFocus: () => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
  };
  setOpen: (next: boolean) => void;
  toggle: () => void;
  close: () => void;
};

/** ONE hover-intent contract for the status slots (context gauge, work card):
 *  hover opens, a click pins, Escape or a pointer landing outside closes, and
 *  a coarse pointer gets the same card from a tap. */
export function useHoverPopover({
  open: controlledOpen,
  onOpenChange,
  closeDelayMs = HOVER_POPOVER_CLOSE_DELAY_MS,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  closeDelayMs?: number;
} = {}): HoverPopover {
  const [localOpen, setLocalOpen] = useState(false);
  const [pinned, setPinnedState] = useState(false);
  const open = controlledOpen ?? localOpen;
  const host = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  // The grace timer reads the pin it fires under, not the one captured when it
  // was scheduled: a click during the window has to survive.
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  // A coarse pointer has no hover to read the card with, so there a tap opens
  // the same card the desktop shows on hover.
  const touch = touchPrimaryPointer();

  const cancelClose = useCallback(() => {
    if (closeTimer.current === null) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const setOpen = useCallback((next: boolean) => {
    cancelClose();
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  }, [cancelClose, controlledOpen, onOpenChange]);

  const setPinned = useCallback((next: boolean) => {
    pinnedRef.current = next;
    setPinnedState(next);
  }, []);

  const close = useCallback(() => {
    setPinned(false);
    setOpen(false);
  }, [setOpen, setPinned]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      // The pointer can finish its trip on the CARD, which never re-enters the
      // host through mouseenter, so the live hover state is what decides.
      if (pinnedRef.current || host.current?.matches(":hover")) return;
      if (controlledOpen === undefined) setLocalOpen(false);
      onOpenChange?.(false);
    }, Math.max(0, closeDelayMs));
  }, [cancelClose, closeDelayMs, controlledOpen, onOpenChange]);

  useEffect(() => cancelClose, [cancelClose]);

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: globalThis.PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && host.current?.contains(target)) return;
      close();
    };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", keydown, true);
    };
  }, [close, open]);

  useEffect(() => {
    if (controlledOpen === false) {
      cancelClose();
      setPinned(false);
    }
  }, [cancelClose, controlledOpen, setPinned]);

  // ABB: a tapped-open card closes on hardware back.
  useMobileBack(open, close);

  const toggle = useCallback(() => {
    const next = !pinnedRef.current;
    setPinned(next);
    setOpen(next || (!touch && host.current?.matches(":hover") === true));
  }, [setOpen, setPinned, touch]);

  return {
    open,
    pinned,
    host,
    hostProps: {
      ref: host,
      onMouseEnter: () => { if (!touch) setOpen(true); },
      // A pinned card ignores the pointer leaving; an unpinned one only starts
      // the grace timer.
      onMouseLeave: () => { if (!touch && !pinnedRef.current) scheduleClose(); },
    },
    triggerProps: {
      onClick: toggle,
      onFocus: () => setOpen(true),
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (pinnedRef.current || host.current?.contains(event.relatedTarget)) return;
        setOpen(false);
      },
    },
    setOpen,
    toggle,
    close,
  };
}
