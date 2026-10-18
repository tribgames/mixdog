import { type RefObject, useEffect, useRef } from 'react';

const ROW_CONTEXT_MENU_SELECTOR = '.dock-scm-context-menu';

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
