import { type RefObject, useLayoutEffect } from 'react';
import { restoreSidebarFocus } from './app-root/use-sidebar-focus-restore';
import { DRAWER_COMMITTED_EVENT, DRAWER_INTENT_ATTRIBUTE } from './drawer-intent';

/** The drawer's commit runs no slide: an instant commit, for which
 *  07-mobile-chrome.css drops the frame's transition unless a tap's intent
 *  stamp is still up. Callers check this before `getAnimations()`, which would
 *  only flush the style of everything the commit mounted (Settings opening
 *  over the drawer paid its whole recalc there). Attribute reads only. */
export function drawerCommitIsInstant(frame: Element): boolean {
  return (
    frame.getAttribute('data-motion') === 'instant' &&
    !frame.ownerDocument.documentElement.hasAttribute(DRAWER_INTENT_ATTRIBUTE)
  );
}

/** Phone drawer: flipping `inert` restyles the whole sidebar (13-24 ms), so it
 *  is never flipped in the first animation frame. A closing drawer is only
 *  `pointer-events:none` (CSS on data-state) with aria-hidden, focus moved out,
 *  and takes `inert` when the frame's slide ends or is cancelled. An opening
 *  drawer drops `pointer-events:none` at once and `inert` at the slide's end.
 *  A drag release that already carried the sheet to its end has no slide: the
 *  commit hands the gesture's paint to the class (equal at rest, so no slide)
 *  and flips at once. With no slide running the flip is immediate. Desktop keeps `inert={!open}`
 *  in the render and this does nothing. */
export function usePhoneDrawerInert(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  phone: boolean,
  /** False while the element is not rendered, so it is picked up when it is. */
  rendered = true
): void {
  useLayoutEffect(() => {
    const sidebar = ref.current;
    if (!phone || !sidebar) return undefined;
    const apply = (): void => {
      if (open) sidebar.removeAttribute('inert');
      else sidebar.setAttribute('inert', '');
    };
    if (!open) restoreSidebarFocus(sidebar);
    const frame = sidebar.closest('.sidebar-drawer-frame');
    const sliding = (): boolean =>
      frame?.getAnimations().some((a) => (a as CSSTransition).transitionProperty === 'transform' && a.playState === 'running') ??
      false;
    // A drag release commits while the gesture's inline end-state paint is
    // still on the sheet: say so, so a paint at rest is handed to the class
    // (touch-gestures.ts) before reading whether a slide is running.
    if (frame && (frame as HTMLElement).style.transform !== '') {
      frame.dispatchEvent(new Event(DRAWER_COMMITTED_EVENT, { bubbles: true }));
    }
    if (!frame || drawerCommitIsInstant(frame) || !sliding()) {
      apply();
      return undefined;
    }
    const settle = (event: Event): void => {
      if (event.target !== frame || (event as TransitionEvent).propertyName !== 'transform') return;
      // A reversal cancels the old transition while its replacement runs:
      // that slide's own end or cancel settles.
      if (event.type === 'transitioncancel' && sliding()) return;
      apply();
    };
    frame.addEventListener('transitionend', settle);
    frame.addEventListener('transitioncancel', settle);
    return () => {
      frame.removeEventListener('transitionend', settle);
      frame.removeEventListener('transitioncancel', settle);
    };
  }, [ref, open, phone, rendered]);
}
