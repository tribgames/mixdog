import { type RefObject, useLayoutEffect } from 'react';
import { restoreSidebarFocus } from './app-root/use-sidebar-focus-restore';

/** Phone drawer: flipping `inert` restyles the whole sidebar (13-24 ms), so it
 *  is never flipped in the first animation frame. A closing drawer is only
 *  `pointer-events:none` (CSS on data-state) with aria-hidden, focus moved out,
 *  and takes `inert` when the frame's slide ends or is cancelled. An opening
 *  drawer drops `pointer-events:none` at once and `inert` at the slide's end.
 *  With no slide running the flip is immediate. Desktop keeps `inert={!open}`
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
    if (!frame || !sliding()) {
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
