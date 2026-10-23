import { type RefObject, useEffect, useRef } from 'react';
import { TOUCH_SLOP_PX } from './remote-browser-touch';

const ROW_CONTEXT_MENU_SELECTOR = '.dock-scm-context-menu';

const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ']);
/** Keys typed here edit text instead of scrolling. */
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
/** Space on these activates them instead of scrolling. */
const SPACE_ACTIVATES_SELECTOR =
  'button, summary, [role="button"], [role="checkbox"], [role="switch"], [role="tab"], [role="option"], [role^="menuitem"]';

/** True when the browser's default action for this key scrolls. */
function keyScrolls(event: KeyboardEvent): boolean {
  if (!SCROLL_KEYS.has(event.key)) return false;
  const target = event.target as Element | null;
  if (typeof target?.closest !== 'function') return true;
  if (target.closest(EDITABLE_SELECTOR)) return false;
  return event.key !== ' ' || !target.closest(SPACE_ACTIVATES_SELECTOR);
}

/** A menu portalled at fixed coordinates detaches from its row when the user
 *  scrolls the page under it, so a user scroll outside the menu closes it: a
 *  wheel, a scrolling key (a pointer open leaves focus on the trigger, outside
 *  the menu) or a touch drag past the slop (a drag that starts on the trigger
 *  brings no new outside pointerdown). A `scroll` event is no such signal:
 *  programmatic scrolls fire it too, and an agent turn makes them constantly
 *  (the transcript pinning its end on every streamed token, the sidebar holding
 *  its rows in place on a live re-sort), so a menu closed on `scroll` vanished
 *  while the user moved to pick an item. Dragging a scrollbar starts with a
 *  pointerdown, which the outside-pointer rule already covers. A touchmove a
 *  handler prevented (touch-gestures.ts holds the page still under a finger
 *  resting after a long-press open) scrolls nothing and keeps the menu.
 *  Returns the cleanup. */
export function closeOnUserScroll(close: () => void, insideMenu: (target: Node | null) => boolean): () => void {
  // A row context menu opened over this one belongs to it (as in useMenuDismiss).
  const inside = (target: Node | null) =>
    insideMenu(target) || (target as Element | null)?.closest?.(ROW_CONTEXT_MENU_SELECTOR) != null;
  const onWheel = (event: WheelEvent) => {
    if (!inside(event.target as Node | null)) close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (keyScrolls(event) && !inside(event.target as Node | null)) close();
  };
  // Where each touch was first seen while the menu is up: the touch that
  // opened it may already be down, so its first move can be the baseline.
  const touchStarts = new Map<number, { x: number; y: number }>();
  const onTouchStart = (event: TouchEvent) => {
    for (let index = 0; index < event.changedTouches.length; index += 1) {
      const touch = event.changedTouches[index];
      touchStarts.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
    }
  };
  const onTouchMove = (event: TouchEvent) => {
    if (event.defaultPrevented || inside(event.target as Node | null)) return;
    for (let index = 0; index < event.changedTouches.length; index += 1) {
      const touch = event.changedTouches[index];
      const start = touchStarts.get(touch.identifier);
      if (!start) touchStarts.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
      else if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > TOUCH_SLOP_PX) {
        close();
        return;
      }
    }
  };
  const onTouchEnd = (event: TouchEvent) => {
    for (let index = 0; index < event.changedTouches.length; index += 1) {
      touchStarts.delete(event.changedTouches[index].identifier);
    }
  };
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  // Bubble phase: a document-level guard that prevents the move has run.
  window.addEventListener('touchmove', onTouchMove, { passive: true });
  window.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
  window.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });
  return () => {
    window.removeEventListener('wheel', onWheel, { capture: true });
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('touchstart', onTouchStart, { capture: true });
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd, { capture: true });
    window.removeEventListener('touchcancel', onTouchEnd, { capture: true });
  };
}

/** ONE dismiss/focus contract for trigger-anchored popups that portal their
 *  panel to document.body (⋯ menus, the usage menu, the model picker sheet):
 *
 *  - Escape closes and returns focus to the trigger;
 *  - Tab closes (the menus are not roving-through lists) and the browser's
 *    default Tab then continues from the trigger, so focus never strands in a
 *    portal or skips into whatever follows the portal at the end of <body>;
 *  - a pointer landing outside the panel and trigger closes.
 *
 *  Listening on the window (capture) instead of the panel's onKeyDown
 *  matters: a pointer open leaves focus on the TRIGGER, outside the panel, so
 *  panel-scoped key handlers never see the Tab or Escape. */
export function useMenuDismiss({
  open,
  close,
  trigger,
  panels,
  onEscape,
}: {
  open: boolean;
  close: () => void;
  trigger: RefObject<HTMLElement | null>;
  /** Every element that belongs to the open popup (panel, flyouts). */
  panels: () => Array<HTMLElement | null | undefined>;
  /** Replaces the default Escape (close + focus trigger), e.g. to step out of a
   *  nested pane first. Return true when it handled the key. */
  onEscape?: (event: KeyboardEvent) => boolean;
}): void {
  const latest = useRef({ close, panels, onEscape });
  latest.current = { close, panels, onEscape };
  useEffect(() => {
    if (!open) return undefined;
    // A row context menu opened from the popup (portaled to <body>) is part of
    // it: its pointer events do not dismiss the popup, and it owns Escape and
    // Tab while it is up.
    const rowMenu = (target: Node | null) => (target as Element | null)?.closest?.(ROW_CONTEXT_MENU_SELECTOR) != null;
    const inside = (target: Node | null) =>
      Boolean(
        target &&
          (rowMenu(target) ||
            trigger.current?.contains(target) ||
            latest.current.panels().some((panel) => panel?.contains(target)))
      );
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target as Node)) latest.current.close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector(ROW_CONTEXT_MENU_SELECTOR)) return;
      if (event.key === 'Escape') {
        if (latest.current.onEscape?.(event)) return;
        latest.current.close();
        trigger.current?.focus({ preventScroll: true });
        return;
      }
      if (event.key !== 'Tab') return;
      latest.current.close();
      // Focus inside the popup would be lost with it: hand it to the trigger so
      // the default Tab step starts there. Focus elsewhere is left alone.
      if (latest.current.panels().some((panel) => panel?.contains(document.activeElement))) {
        trigger.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, trigger]);
}
