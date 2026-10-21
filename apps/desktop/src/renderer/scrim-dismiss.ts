import type { MouseEvent, PointerEvent } from 'react';

// Tap-outside-to-close for a modal's scrim. `mousedown` is not an option on
// an iPhone: iOS synthesizes no mouse events for a tap on a plain div, so a
// scrim that listens for it can never be dismissed. Pointer events do arrive
// and a React `onClick` is what makes the div tappable there, so the dismissal
// is the click, armed only when the press STARTED on the scrim — a drag that
// begins inside the card and lets go over the scrim must not close it.
const pressedOnScrim = new WeakSet<EventTarget>();

export function scrimDismiss(close: () => void) {
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.target === event.currentTarget) pressedOnScrim.add(event.currentTarget);
      else pressedOnScrim.delete(event.currentTarget);
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      const armed = pressedOnScrim.delete(event.currentTarget);
      if (armed && event.target === event.currentTarget) close();
    },
  };
}
